import type {
	LLMChunk,
	LLMMessage,
	LLMRequest,
	LLMResponse,
	LLMToolCall,
	ProviderConfig,
	ReasoningEffort,
	ThinkingBlock,
} from "../types.js";
import { BaseLLMProvider } from "./base.js";

const EFFORT_BUDGET: Record<Exclude<ReasoningEffort, "none">, number> = {
	low: 2048,
	medium: 8192,
	high: 32768,
};

export class AnthropicProvider extends BaseLLMProvider {
	private mapModel(model: string): string {
		return model.replace(/^anthropic\//, "");
	}

	private toAnthropicMessages(
		messages: LLMMessage[],
		includeThinking = false,
	): {
		system?: string;
		messages: Array<{
			role: "user" | "assistant";
			content: string | Array<Record<string, unknown>>;
		}>;
	} {
		const systemMessages: string[] = [];
		const filtered: LLMMessage[] = [];

		for (const msg of messages) {
			if (msg.role === "system") {
				systemMessages.push(msg.content);
			} else {
				filtered.push(msg);
			}
		}

		const anthropicMessages = filtered.map((m) => {
			if (m.role === "tool") {
				return {
					role: "user" as const,
					content: [
						{
							type: "tool_result",
							tool_use_id: m.toolCallId,
							content: m.content,
						},
					],
				};
			}

			if (m.role === "assistant" && m.toolCalls?.length) {
				const contentBlocks: Array<Record<string, unknown>> = [];
				if (m.content) {
					contentBlocks.push({ type: "text", text: m.content });
				}
				for (const tc of m.toolCalls) {
					contentBlocks.push({
						type: "tool_use",
						id: tc.id,
						name: tc.function.name,
						input: JSON.parse(tc.function.arguments),
					});
				}
				return { role: "assistant" as const, content: contentBlocks };
			}

			return { role: m.role as "user" | "assistant", content: m.content };
		});

		return {
			...(systemMessages.length ? { system: systemMessages.join("\n") } : {}),
			messages: anthropicMessages,
		};
	}

	private toAnthropicTools(
		tools: LLMRequest["tools"],
	): Array<Record<string, unknown>> | undefined {
		if (!tools?.length) return undefined;
		return tools.map((t) => ({
			name: t.function.name,
			description: t.function.description,
			input_schema: t.function.parameters,
		}));
	}

	private buildThinkingConfig(request: LLMRequest): Record<string, unknown> {
		const reasoning = request.reasoning;
		if (!reasoning || reasoning.effort === "none") return {};
		const budget = reasoning.budgetTokens ?? EFFORT_BUDGET[reasoning.effort];
		return {
			thinking: {
				type: "enabled",
				budget_tokens: budget,
			},
		};
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const model = this.mapModel(request.model);
		const includeThinking =
			request.reasoning?.effort !== "none" &&
			request.reasoning?.effort !== undefined;
		const { system, messages } = this.toAnthropicMessages(
			request.messages,
			includeThinking,
		);

		const thinkingConfig = this.buildThinkingConfig(request);
		const hasThinking = !!thinkingConfig.thinking;

		const body: Record<string, unknown> = {
			model,
			messages,
			max_tokens: request.maxTokens ?? 4096,
			...(hasThinking
				? {}
				: request.temperature != null
					? { temperature: request.temperature }
					: {}),
			...(system ? { system } : {}),
			...thinkingConfig,
		};

		const tools = this.toAnthropicTools(request.tools);
		if (tools) {
			body.tools = tools;
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"x-api-key": this.config.apiKey ?? "",
			"anthropic-version": "2023-06-01",
		};

		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
		}

		const data = (await response.json()) as {
			content: Array<{
				type: string;
				text?: string;
				thinking?: string;
				signature?: string;
				id?: string;
				name?: string;
				input?: Record<string, unknown>;
			}>;
			model: string;
			usage: { input_tokens: number; output_tokens: number };
			stop_reason: string;
		};

		let textContent = "";
		const toolCalls: LLMToolCall[] = [];
		const thinkingBlocks: ThinkingBlock[] = [];

		for (const block of data.content) {
			if (block.type === "thinking" && block.thinking) {
				thinkingBlocks.push({
					type: "thinking",
					text: block.thinking,
					...(block.signature ? { signature: block.signature } : {}),
				});
			} else if (block.type === "text" && block.text != null) {
				textContent += block.text;
			} else if (block.type === "tool_use" && block.id && block.name) {
				toolCalls.push({
					id: block.id,
					type: "function",
					function: {
						name: block.name,
						arguments: JSON.stringify(block.input ?? {}),
					},
				});
			}
		}

		return {
			content: textContent,
			model: data.model,
			usage: {
				promptTokens: data.usage.input_tokens,
				completionTokens: data.usage.output_tokens,
				totalTokens: data.usage.input_tokens + data.usage.output_tokens,
			},
			...(toolCalls.length ? { toolCalls } : {}),
			...(thinkingBlocks.length ? { thinking: thinkingBlocks } : {}),
			finishReason: data.stop_reason ?? "end_turn",
		};
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		const model = this.mapModel(request.model);
		const includeThinking =
			request.reasoning?.effort !== "none" &&
			request.reasoning?.effort !== undefined;
		const { system, messages } = this.toAnthropicMessages(
			request.messages,
			includeThinking,
		);

		const thinkingConfig = this.buildThinkingConfig(request);
		const hasThinking = !!thinkingConfig.thinking;

		const body: Record<string, unknown> = {
			model,
			messages,
			stream: true,
			max_tokens: request.maxTokens ?? 4096,
			...(hasThinking
				? {}
				: request.temperature != null
					? { temperature: request.temperature }
					: {}),
			...(system ? { system } : {}),
			...thinkingConfig,
		};

		const tools = this.toAnthropicTools(request.tools);
		if (tools) {
			body.tools = tools;
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"x-api-key": this.config.apiKey ?? "",
			"anthropic-version": "2023-06-01",
		};

		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
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
			const parts = buffer.split("\n\n");
			buffer = parts.pop() ?? "";

			for (const part of parts) {
				const lines = part.split("\n");
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data: ")) continue;
					const payload = trimmed.slice(6);

					try {
						const event = JSON.parse(payload) as {
							type: string;
							delta?: {
								text?: string;
								thinking?: string;
								stop_reason?: string;
								partial_json?: string;
							};
							content_block?: {
								type: string;
								id?: string;
								name?: string;
								thinking?: string;
							};
							index?: number;
							message?: {
								usage: { input_tokens: number; output_tokens: number };
							};
						};

						if (event.type === "content_block_delta" && event.delta?.text) {
							yield { content: event.delta.text };
						} else if (
							event.type === "content_block_delta" &&
							event.delta?.thinking
						) {
							yield { thinking: event.delta.thinking };
						} else if (
							event.type === "tool_use_chunk" &&
							event.delta?.partial_json
						) {
							yield {
								toolCalls: {
									function: { name: "", arguments: event.delta.partial_json },
								},
							};
						} else if (
							event.type === "content_block_start" &&
							event.content_block?.type === "tool_use"
						) {
							yield {
								toolCalls: {
									id: event.content_block.id ?? "",
									type: "function",
									function: {
										name: event.content_block.name ?? "",
										arguments: "",
									},
								},
							};
						} else if (
							event.type === "message_delta" &&
							event.delta?.stop_reason
						) {
							yield { finishReason: event.delta.stop_reason };
						} else if (event.type === "message_start" && event.message?.usage) {
							yield {
								usage: {
									promptTokens: event.message.usage.input_tokens,
									completionTokens: event.message.usage.output_tokens,
									totalTokens:
										event.message.usage.input_tokens +
										event.message.usage.output_tokens,
								},
							};
						}
					} catch {}
				}
			}
		}
	}

	async isAvailable(): Promise<boolean> {
		return !!this.config.apiKey;
	}
}
