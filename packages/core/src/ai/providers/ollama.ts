import type {
	LLMChunk,
	LLMRequest,
	LLMResponse,
	LLMToolCall,
	ProviderConfig,
} from "../types.js";
import { BaseLLMProvider, fetchModelsList } from "./base.js";
import { readNextWithTimeout } from "./stream-reader.js";

export class OllamaProvider extends BaseLLMProvider {
	private baseUrl: string;

	constructor(config: ProviderConfig) {
		super(config);
		this.baseUrl = config.baseUrl ?? "http://localhost:11434";
	}

	private mapModel(model: string): string {
		return model.replace(/^local\//, "");
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const model = this.mapModel(request.model);
		const options = {
			...(request.maxTokens != null ? { num_predict: request.maxTokens } : {}),
			...(request.temperature != null
				? { temperature: request.temperature }
				: {}),
		};
		const body: Record<string, unknown> = {
			model,
			messages: request.messages.map((m) => ({
				role: m.role,
				content: m.content,
			})),
			stream: false,
			...(Object.keys(options).length ? { options } : {}),
			...(request.tools?.length ? { tools: request.tools } : {}),
		};

		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Ollama API error: ${response.status} ${errorText}`);
		}

		const data = (await response.json()) as {
			message: {
				content: string;
				tool_calls?: Array<{
					function: { name: string; arguments: Record<string, unknown> };
				}>;
			};
			model: string;
			prompt_eval_count?: number;
			eval_count?: number;
			done_reason?: string;
		};

		const toolCalls: LLMToolCall[] | undefined = data.message.tool_calls?.map(
			(tc, i) => ({
				id: `ollama_tc_${i}`,
				type: "function" as const,
				function: {
					name: tc.function.name,
					arguments: JSON.stringify(tc.function.arguments),
				},
			}),
		);

		const promptTokens = data.prompt_eval_count ?? 0;
		const completionTokens = data.eval_count ?? 0;

		return {
			content: data.message.content,
			model: data.model,
			usage: {
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
			},
			...(toolCalls?.length ? { toolCalls } : {}),
			finishReason: data.done_reason ?? "stop",
		};
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		const model = this.mapModel(request.model);
		const options = {
			...(request.maxTokens != null ? { num_predict: request.maxTokens } : {}),
			...(request.temperature != null
				? { temperature: request.temperature }
				: {}),
		};
		const body: Record<string, unknown> = {
			model,
			messages: request.messages.map((m) => ({
				role: m.role,
				content: m.content,
			})),
			stream: true,
			...(Object.keys(options).length ? { options } : {}),
		};

		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Ollama API error: ${response.status} ${errorText}`);
		}

		const bodyStream = response.body;
		if (!bodyStream) throw new Error("No response body");
		const reader = bodyStream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const readNext = async () =>
			readNextWithTimeout(
				reader,
				this.resolveStreamReadTimeoutMs(120_000, 1_800_000),
				"Ollama",
			);

		while (true) {
			const { done, value } = await readNext();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let parsed: {
					error?: string;
					message?: { content?: string };
					done?: boolean;
					done_reason?: string;
					prompt_eval_count?: number;
					eval_count?: number;
				};
				try {
					parsed = JSON.parse(trimmed) as typeof parsed;
				} catch {
					continue; // ignore malformed chunks
				}

				if (parsed.error) {
					throw new Error(parsed.error);
				}

				if (parsed.message?.content) {
					yield { content: parsed.message.content };
				}
				if (parsed.done) {
					const chunk: LLMChunk = {
						finishReason: parsed.done_reason ?? "stop",
					};
					if (parsed.prompt_eval_count != null || parsed.eval_count != null) {
						const pt = parsed.prompt_eval_count ?? 0;
						const ct = parsed.eval_count ?? 0;
						chunk.usage = {
							promptTokens: pt,
							completionTokens: ct,
							totalTokens: pt + ct,
						};
					}
					yield chunk;
				}
			}
		}
	}

	// Ollama is local and needs no API key — always considered configured when
	// present in config (connectivity is verified by listModels' /api/tags GET).
	hasCredentials(): boolean {
		return true;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/api/tags`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<{ ok: boolean; models: string[] }> {
		// Ollama exposes installed models via /api/tags ({models:[{name}]}).
		return fetchModelsList(`${this.baseUrl}/api/tags`, {}, 5000);
	}
}
