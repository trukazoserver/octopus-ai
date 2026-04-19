import type {
	LLMChunk,
	LLMRequest,
	LLMResponse,
	ProviderConfig,
	ThinkingBlock,
} from "../types.js";
import { BaseLLMProvider } from "./base.js";

export type ZhipuApiMode = "api" | "coding-plan" | "coding-global" | "global";

const ZHIPU_ENDPOINTS: Record<ZhipuApiMode, string> = {
	api: "https://open.bigmodel.cn/api/paas/v4",
	"coding-plan": "https://open.bigmodel.cn/api/coding/paas/v4",
	"coding-global": "https://api.z.ai/api/coding/paas/v4",
	global: "https://api.z.ai/api/paas/v4",
};

export class ZhipuProvider extends BaseLLMProvider {
	private baseUrl: string;
	private prefix = "zhipu";
	private mode: ZhipuApiMode;

	constructor(config: ProviderConfig & { mode?: ZhipuApiMode }) {
		super(config);
		this.mode = config.mode ?? "coding-plan";
		this.baseUrl = ZHIPU_ENDPOINTS[this.mode];
	}

	private mapModel(model: string): string {
		if (model.startsWith("zhipu/")) {
			return model.slice(6);
		}
		return model;
	}

	private getHeaders(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.config.apiKey}`,
		};
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const model = this.mapModel(request.model);
		const body: Record<string, unknown> = {
			model,
			messages: request.messages.map((m) => ({
				role: m.role,
				content: m.content,
				...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
				...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
			})),
			...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
			...(request.temperature != null
				? { temperature: request.temperature }
				: {}),
			...(request.tools?.length ? { tools: request.tools } : {}),
			...(request.reasoning && request.reasoning.effort !== "none"
				? { thinking: { type: "enabled" } }
				: request.reasoning && request.reasoning.effort === "none"
					? { thinking: { type: "disabled" } }
					: {}),
		};

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Z.ai API error (${this.mode}): ${response.status} ${errorText}`,
			);
		}

		const data = (await response.json()) as {
			choices: Array<{
				message: {
					content: string | null;
					reasoning_content?: string | null;
					tool_calls?: Array<{
						id: string;
						type: "function";
						function: { name: string; arguments: string };
					}>;
				};
				finish_reason: string;
			}>;
			model: string;
			usage: {
				prompt_tokens: number;
				completion_tokens: number;
				total_tokens: number;
				completion_tokens_details?: { reasoning_tokens?: number };
			};
		};

		const choice = data.choices[0];
		const toolCalls = choice.message.tool_calls?.map((tc) => ({
			id: tc.id,
			type: "function" as const,
			function: { name: tc.function.name, arguments: tc.function.arguments },
		}));

		const hasBoth =
			!!choice.message.content && !!choice.message.reasoning_content;
		const thinking: ThinkingBlock[] | undefined = hasBoth
			? [{ type: "thinking", text: choice.message.reasoning_content ?? "" }]
			: !!choice.message.reasoning_content && !choice.message.content
				? [{ type: "thinking", text: choice.message.reasoning_content }]
				: undefined;
		const content =
			choice.message.content ||
			(thinking ? "" : choice.message.reasoning_content) ||
			"";
		const reasoningTokens =
			data.usage?.completion_tokens_details?.reasoning_tokens;

		return {
			content,
			model: data.model,
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				...(reasoningTokens ? { reasoningTokens } : {}),
			},
			...(toolCalls?.length ? { toolCalls } : {}),
			...(thinking ? { thinking } : {}),
			finishReason: choice.finish_reason ?? "stop",
		};
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		const model = this.mapModel(request.model);
		const body: Record<string, unknown> = {
			model,
			stream: true,
			messages: request.messages.map((m) => ({
				role: m.role,
				content: m.content,
				...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
				...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
			})),
			...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
			...(request.temperature != null
				? { temperature: request.temperature }
				: {}),
			...(request.tools?.length ? { tools: request.tools } : {}),
			...(request.reasoning && request.reasoning.effort !== "none"
				? { thinking: { type: "enabled" } }
				: request.reasoning && request.reasoning.effort === "none"
					? { thinking: { type: "disabled" } }
					: {}),
		};

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Z.ai API error (${this.mode}): ${response.status} ${errorText}`,
			);
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
					if (payload === "[DONE]") return;
					try {
						const parsed = JSON.parse(payload) as {
							choices: Array<{
								delta: {
									content?: string;
									reasoning_content?: string;
									tool_calls?: Array<{
										index: number;
										id?: string;
										type?: string;
										function?: { name?: string; arguments?: string };
									}>;
								};
								finish_reason: string | null;
							}>;
						};
						const delta = parsed.choices[0];
						if (!delta) continue;
						const chunk: LLMChunk = {};
						if (delta.delta.content) {
							chunk.content = delta.delta.content;
						}
						if (delta.delta.reasoning_content) {
							chunk.thinking = delta.delta.reasoning_content;
						}
						if (delta.delta.tool_calls) {
							const tc = delta.delta.tool_calls[0];
							if (tc) {
								chunk.toolCalls = {
									id: tc.id ?? "",
									type: "function",
									function: {
										name: tc.function?.name ?? "",
										arguments: tc.function?.arguments ?? "",
									},
								};
							}
						}
						if (delta.finish_reason) {
							chunk.finishReason = delta.finish_reason;
						}
						yield chunk;
					} catch {}
				}
			}
		}
	}

	async isAvailable(): Promise<boolean> {
		return !!this.config.apiKey;
	}

	getMode(): ZhipuApiMode {
		return this.mode;
	}

	getBaseUrl(): string {
		return this.baseUrl;
	}
}
