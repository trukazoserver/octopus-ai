import type {
	LLMChunk,
	LLMMessage,
	LLMRequest,
	LLMResponse,
	LLMToolCall,
	ProviderConfig,
	ThinkingBlock,
} from "../types.js";
import { BaseLLMProvider } from "./base.js";

export interface OpenAICompatibleConfig extends ProviderConfig {
	baseUrl: string;
	authHeader?: string;
	extraHeaders?: Record<string, string>;
	prefix?: string;
}

export class OpenAICompatibleProvider extends BaseLLMProvider {
	protected baseUrl: string;
	protected authHeader: string;
	protected extraHeaders: Record<string, string>;
	protected prefix: string;

	constructor(config: OpenAICompatibleConfig) {
		super(config);
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.authHeader = config.authHeader ?? "Authorization";
		this.extraHeaders = config.extraHeaders ?? {};
		this.prefix = config.prefix ?? "";
	}

	protected mapModel(model: string): string {
		if (this.prefix && model.startsWith(`${this.prefix}/`)) {
			return model.slice(this.prefix.length + 1);
		}
		return model;
	}

	private getHeaders(): Record<string, string> {
		const credential = stripBearerPrefix(
			this.config.authMode === "oauth"
				? this.config.oauthAccessToken
				: this.config.authMode === "browser"
					? this.config.accessToken
					: this.config.apiKey ||
						(this.config.authMode === "codex"
							? this.config.accessToken
							: undefined),
		);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...this.extraHeaders,
		};
		if (credential) {
			if (this.authHeader === "Authorization") {
				headers.Authorization = `Bearer ${credential}`;
			} else {
				headers[this.authHeader] = credential;
			}
		}
		return headers;
	}

	private hasAuthCredential(): boolean {
		return Boolean(
			this.config.apiKey ||
				this.config.oauthAccessToken ||
				this.config.accessToken ||
				(this.config.authMode === "codex" && this.config.accessToken),
		);
	}

	private buildMessages(request: LLMRequest): Array<{
		role: LLMMessage["role"];
		content: LLMMessage["content"];
		tool_calls?: LLMToolCall[];
		tool_call_id?: string;
	}> {
		return request.messages.map((m) => ({
			role: m.role,
			content: m.content,
			...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
			...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
		}));
	}

	protected buildReasoningBody(request: LLMRequest): Record<string, unknown> {
		const reasoning = request.reasoning;
		if (!reasoning || reasoning.effort === "none") return {};

		if (this.prefix === "xai") {
			return { reasoning_effort: reasoning.effort === "low" ? "low" : "high" };
		}

		if (this.prefix === "mistral") {
			return { prompt_mode: "reasoning" };
		}

		return {};
	}

	protected extractReasoningFromResponse(
		message: {
			content: string | null;
			reasoning_content?: string | null;
			[key: string]: unknown;
		},
		usage:
			| {
					prompt_tokens: number;
					completion_tokens: number;
					total_tokens: number;
					completion_tokens_details?: { reasoning_tokens?: number };
			  }
			| undefined,
	): { thinking?: ThinkingBlock[]; reasoningTokens?: number } {
		const result: { thinking?: ThinkingBlock[]; reasoningTokens?: number } = {};

		const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
		if (reasoningTokens) {
			result.reasoningTokens = reasoningTokens;
		}

		if (message.reasoning_content && message.content) {
			result.thinking = [{ type: "thinking", text: message.reasoning_content }];
		}

		return result;
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const model = this.mapModel(request.model);
		const body: Record<string, unknown> = {
			model,
			messages: this.buildMessages(request),
			...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
			...(request.temperature != null
				? { temperature: request.temperature }
				: {}),
			...(request.tools?.length ? { tools: request.tools } : {}),
			...this.buildReasoningBody(request),
		};

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`API error (${this.prefix || "openai-compat"}): ${response.status} ${errorText}`,
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
		const toolCalls: LLMToolCall[] | undefined = choice.message.tool_calls?.map(
			(tc) => ({
				id: tc.id,
				type: "function" as const,
				function: {
					name: tc.function.name,
					arguments: tc.function.arguments,
				},
			}),
		);

		const reasoning = this.extractReasoningFromResponse(
			choice.message,
			data.usage,
		);
		const content =
			choice.message.content || choice.message.reasoning_content || "";

		return {
			content,
			model: data.model,
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				...(reasoning.reasoningTokens
					? { reasoningTokens: reasoning.reasoningTokens }
					: {}),
			},
			...(toolCalls?.length ? { toolCalls } : {}),
			...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
			finishReason: choice.finish_reason ?? "stop",
		};
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		const model = this.mapModel(request.model);
		const body: Record<string, unknown> = {
			model,
			stream: true,
			stream_options: { include_usage: true },
			messages: this.buildMessages(request),
			...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
			...(request.temperature != null
				? { temperature: request.temperature }
				: {}),
			...(request.tools?.length ? { tools: request.tools } : {}),
			...this.buildReasoningBody(request),
		};

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`API error (${this.prefix || "openai-compat"}): ${response.status} ${errorText}`,
			);
		}

		const bodyStream = response.body;
		if (!bodyStream) throw new Error("No response body");
		const reader = bodyStream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const readNext = async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					reader.read(),
					new Promise<Awaited<ReturnType<typeof reader.read>>>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("OpenAI-compatible stream read timeout")),
							120_000,
						);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		};

		try {
			while (true) {
				const { done, value } = await readNext();
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
						let parsed: {
							error?: { message?: string } | string;
							usage?: {
								prompt_tokens?: number;
								completion_tokens?: number;
								total_tokens?: number;
								completion_tokens_details?: { reasoning_tokens?: number };
							};
							choices?: Array<{
								delta?: {
									content?: string;
									reasoning_content?: string;
									tool_calls?: Array<{
										id?: string;
										type?: "function";
										function?: { name?: string; arguments?: string };
									}>;
								};
								finish_reason?: string;
							}>;
						};
						try {
							parsed = JSON.parse(payload) as typeof parsed;
						} catch {
							continue; // ignore malformed chunks
						}
						if (parsed.error) {
							throw new Error(
								typeof parsed.error === "string"
									? parsed.error
									: parsed.error.message || JSON.stringify(parsed.error),
							);
						}
						if (parsed.usage) {
							yield {
								usage: {
									promptTokens: parsed.usage.prompt_tokens ?? 0,
									completionTokens: parsed.usage.completion_tokens ?? 0,
									totalTokens: parsed.usage.total_tokens ?? 0,
									...(parsed.usage.completion_tokens_details?.reasoning_tokens
										? {
												reasoningTokens:
													parsed.usage.completion_tokens_details
														.reasoning_tokens,
											}
										: {}),
								},
							};
						}
						const delta = parsed.choices?.[0];
						if (!delta) continue;
						const chunk: LLMChunk = {};
						if (delta.delta?.content) {
							chunk.content = delta.delta.content;
							if (delta.delta?.reasoning_content) {
								chunk.thinking = delta.delta.reasoning_content;
							}
						} else if (delta.delta?.reasoning_content) {
							chunk.content = delta.delta.reasoning_content;
						}
						if (delta.delta?.tool_calls) {
							const tc = delta.delta.tool_calls[0];
							if (tc) {
								chunk.toolCalls = {
									id: tc.id ?? "",
									type: (tc.type as "function") ?? undefined,
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
						if (chunk.finishReason) return;
					}
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	}

	async isAvailable(): Promise<boolean> {
		// OpenAI Codex/browser login: available whenever an accessToken exists,
		// even without an API key (checked before the generic credential gate).
		if (
			this.prefix === "openai" &&
			(this.config.authMode === "codex" ||
				this.config.authMode === "browser") &&
			Boolean(this.config.accessToken)
		) {
			return true;
		}
		if (!this.hasAuthCredential() && this.prefix !== "local") return false;
		if (
			this.prefix === "openai" &&
			(this.config.authMode === "codex" || this.config.authMode === "browser")
		) {
			return true;
		}
		try {
			const response = await fetch(`${this.baseUrl}/models`, {
				headers: this.getHeaders(),
				signal: AbortSignal.timeout(5000),
			});
			return response.ok;
		} catch {
			return this.prefix === "local";
		}
	}
}

function stripBearerPrefix(value: string | undefined): string | undefined {
	return value?.replace(/^Bearer\s+/i, "").trim();
}
