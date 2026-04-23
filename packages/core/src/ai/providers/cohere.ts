import type {
	LLMChunk,
	LLMRequest,
	LLMResponse,
	LLMToolCall,
	ProviderConfig,
} from "../types.js";
import { BaseLLMProvider } from "./base.js";

export class CohereProvider extends BaseLLMProvider {
	private mapModel(model: string): string {
		return model.replace(/^cohere\//, "");
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const model = this.mapModel(request.model);

		const chatHistory: Array<{ role: string; message: string }> = [];
		let lastUserMsg = "";
		let systemMsg = "";

		for (const m of request.messages) {
			if (m.role === "system") {
				systemMsg = m.content;
			} else if (m.role === "user") {
				lastUserMsg = m.content;
				chatHistory.push({ role: "USER", message: m.content });
			} else if (m.role === "assistant") {
				chatHistory.push({ role: "CHATBOT", message: m.content });
			}
		}

		const body: Record<string, unknown> = {
			model,
			message: lastUserMsg,
			...(chatHistory.length > 1
				? { chat_history: chatHistory.slice(0, -1) }
				: {}),
			...(systemMsg ? { preamble: systemMsg } : {}),
			...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
			...(request.temperature != null
				? { temperature: request.temperature }
				: {}),
		};

		if (request.tools?.length) {
			body.tools = request.tools.map((t) => ({
				type: "function",
				function: {
					name: t.function.name,
					description: t.function.description,
					parameters: t.function.parameters,
				},
			}));
		}

		const response = await fetch("https://api.cohere.com/v2/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Cohere API error: ${response.status} ${errorText}`);
		}

		const data = (await response.json()) as {
			message?: {
				content?: Array<{ type: string; text?: string }>;
				tool_calls?: Array<{
					id: string;
					type: string;
					function: { name: string; arguments: string };
				}>;
			};
			finish_reason?: string;
			meta?: {
				tokens?: {
					input_tokens: number;
					output_tokens: number;
					reasoning_tokens?: number;
				};
			};
			model?: string;
		};

		let textContent = "";
		const toolCalls: LLMToolCall[] = [];

		if (data.message?.content) {
			for (const block of data.message.content) {
				if (block.type === "text" && block.text) {
					textContent += block.text;
				}
			}
		}

		if (data.message?.tool_calls) {
			for (const tc of data.message.tool_calls) {
				toolCalls.push({
					id: tc.id,
					type: "function",
					function: {
						name: tc.function.name,
						arguments: tc.function.arguments,
					},
				});
			}
		}

		const reasoningTokens = data.meta?.tokens?.reasoning_tokens;

		return {
			content: textContent,
			model: data.model ?? model,
			usage: {
				promptTokens: data.meta?.tokens?.input_tokens ?? 0,
				completionTokens: data.meta?.tokens?.output_tokens ?? 0,
				totalTokens:
					(data.meta?.tokens?.input_tokens ?? 0) +
					(data.meta?.tokens?.output_tokens ?? 0),
				...(reasoningTokens ? { reasoningTokens } : {}),
			},
			...(toolCalls.length ? { toolCalls } : {}),
			finishReason: data.finish_reason ?? "complete",
		};
	}

	async *chatStream(_request: LLMRequest): AsyncIterable<LLMChunk> {
		const model = this.mapModel(_request.model);

		const body: Record<string, unknown> = {
			model,
			message: _request.messages[_request.messages.length - 1]?.content ?? "",
			stream: true,
		};

		const response = await fetch("https://api.cohere.com/v2/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Cohere API error: ${response.status} ${errorText}`);
		}

		const bodyStream = response.body;
		if (!bodyStream) throw new Error("No response body");
		const reader = bodyStream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let event: any;
				try {
					event = JSON.parse(trimmed);
				} catch {
					continue; // ignore malformed chunks
				}

				if (event.error) {
					throw new Error(event.error.message || JSON.stringify(event.error));
				}

				if (
					event.type === "content-delta" &&
					event.delta?.message?.content?.text
				) {
					yield { content: event.delta.message.content.text };
				}
			}
		}
	}

	async isAvailable(): Promise<boolean> {
		return !!this.config.apiKey;
	}
}
