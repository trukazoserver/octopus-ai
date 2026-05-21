import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
	LLMChunk,
	LLMRequest,
	LLMResponse,
	LLMToolCall,
	ProviderConfig,
	ReasoningEffort,
} from "../types.js";
import { BaseLLMProvider } from "./base.js";

const EFFORT_BUDGET: Record<Exclude<ReasoningEffort, "none">, number> = {
	low: 128,
	medium: 1024,
	high: 8192,
};

export class GoogleProvider extends BaseLLMProvider {
	private apiKey: string;
	private authMode: "api-key" | "vertex";
	private tokenCache?: { token: string; expiresAt: number };

	constructor(
		config: ProviderConfig & {
			authMode?: string;
			accessToken?: string;
			credentialsFile?: string;
			projectId?: string;
			location?: string;
		},
	) {
		super(config);
		this.apiKey = config.apiKey ?? "";
		this.authMode = config.authMode === "vertex" ? "vertex" : "api-key";
	}

	private getBaseUrl(): string {
		if (this.config.baseUrl) return this.config.baseUrl.replace(/\/+$/, "");
		if (this.authMode === "vertex") {
			const projectId = this.vertexProjectId();
			const location = this.vertexLocation();
			return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/endpoints/openapi`;
		}
		return "https://generativelanguage.googleapis.com/v1beta/openai";
	}

	private vertexProjectId(): string {
		return (
			this.config.projectId ??
			process.env.GOOGLE_CLOUD_PROJECT ??
			process.env.GCLOUD_PROJECT ??
			""
		);
	}

	private vertexLocation(): string {
		return (
			this.config.location ??
			process.env.GOOGLE_CLOUD_LOCATION ??
			process.env.GOOGLE_CLOUD_REGION ??
			"us-central1"
		);
	}

	private async getHeaders(): Promise<Record<string, string>> {
		if (this.authMode === "vertex") {
			return {
				"Content-Type": "application/json",
				Authorization: `Bearer ${await this.vertexAccessToken()}`,
			};
		}
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	private async vertexAccessToken(): Promise<string> {
		const configured =
			this.config.accessToken ?? process.env.GOOGLE_VERTEX_ACCESS_TOKEN;
		if (configured?.trim()) return configured.trim();
		if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
			return this.tokenCache.token;
		}
		const credentialsFile =
			this.config.credentialsFile ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
		if (!credentialsFile || !existsSync(credentialsFile)) {
			throw new Error(
				"Google Vertex auth requires GOOGLE_VERTEX_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS",
			);
		}
		const credentials = JSON.parse(readFileSync(credentialsFile, "utf8")) as {
			client_email?: string;
			private_key?: string;
			token_uri?: string;
		};
		if (!credentials.client_email || !credentials.private_key) {
			throw new Error("Google service account credentials are incomplete");
		}
		const now = Math.floor(Date.now() / 1000);
		const assertion = signJwt(
			{ alg: "RS256", typ: "JWT" },
			{
				iss: credentials.client_email,
				scope: "https://www.googleapis.com/auth/cloud-platform",
				aud: credentials.token_uri ?? "https://oauth2.googleapis.com/token",
				exp: now + 3600,
				iat: now,
			},
			credentials.private_key,
		);
		const body = new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		});
		const response = await fetch(
			credentials.token_uri ?? "https://oauth2.googleapis.com/token",
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body,
			},
		);
		if (!response.ok) {
			throw new Error(
				`Google Vertex token request failed: ${response.status} ${await response.text()}`,
			);
		}
		const token = (await response.json()) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!token.access_token) throw new Error("Google Vertex token missing");
		this.tokenCache = {
			token: token.access_token,
			expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
		};
		return token.access_token;
	}

	private buildThinkingConfig(request: LLMRequest): Record<string, unknown> {
		const reasoning = request.reasoning;
		if (!reasoning || reasoning.effort === "none") return {};
		const budget = reasoning.budgetTokens ?? EFFORT_BUDGET[reasoning.effort];
		return {
			thinkingConfig: {
				thinkingBudget: budget,
				includeThoughts: reasoning.includeThinking ?? true,
			},
		};
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const model = request.model.replace(/^google\//, "");

		const body: Record<string, unknown> = {
			model,
			messages: request.messages.map((m) => ({
				role: m.role === "tool" ? "tool" : m.role,
				content: m.content,
				...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
				...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
			})),
			...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
			...(request.temperature != null
				? { temperature: request.temperature }
				: {}),
			...(request.tools?.length ? { tools: request.tools } : {}),
			...this.buildThinkingConfig(request),
		};

		const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
			method: "POST",
			headers: await this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Google Gemini API error: ${response.status} ${errorText}`,
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
				completion_tokens_details?: {
					reasoning_tokens?: number;
					thoughts_tokens?: number;
				};
			};
		};

		const choice = data.choices[0];
		const toolCalls: LLMToolCall[] | undefined = choice.message.tool_calls?.map(
			(tc) => ({
				id: tc.id,
				type: "function" as const,
				function: { name: tc.function.name, arguments: tc.function.arguments },
			}),
		);

		const thinkingTokens =
			data.usage?.completion_tokens_details?.thoughts_tokens ??
			data.usage?.completion_tokens_details?.reasoning_tokens;
		const hasReasoningContent =
			!!choice.message.reasoning_content && !!choice.message.content;

		return {
			content: choice.message.content ?? choice.message.reasoning_content ?? "",
			model: data.model,
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				...(thinkingTokens ? { reasoningTokens: thinkingTokens } : {}),
			},
			...(toolCalls?.length ? { toolCalls } : {}),
			...(hasReasoningContent
				? {
						thinking: [
							{
								type: "thinking" as const,
								text: choice.message.reasoning_content ?? "",
							},
						],
					}
				: {}),
			finishReason: choice.finish_reason ?? "stop",
		};
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		const model = request.model.replace(/^google\//, "");

		const body: Record<string, unknown> = {
			model,
			stream: true,
			stream_options: { include_usage: true },
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
			...this.buildThinkingConfig(request),
		};

		const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
			method: "POST",
			headers: await this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Google Gemini API error: ${response.status} ${errorText}`,
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
							() => reject(new Error("Google stream read timeout")),
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
								completion_tokens_details?: {
									thoughts_tokens?: number;
									reasoning_tokens?: number;
								};
							};
							choices?: Array<{
								delta?: {
									content?: string;
									reasoning_content?: string;
									tool_calls?: Array<{
										id?: string;
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
									...((parsed.usage.completion_tokens_details
										?.thoughts_tokens ??
									parsed.usage.completion_tokens_details?.reasoning_tokens)
										? {
												reasoningTokens:
													parsed.usage.completion_tokens_details
														?.thoughts_tokens ??
													parsed.usage.completion_tokens_details
														?.reasoning_tokens,
											}
										: {}),
								},
							};
						}
						const delta = parsed.choices?.[0];
						if (!delta) continue;
						const chunk: LLMChunk = {};
						if (delta.delta?.content) chunk.content = delta.delta.content;
						if (delta.delta?.reasoning_content)
							chunk.thinking = delta.delta.reasoning_content;
						if (delta.delta?.tool_calls) {
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
						if (delta.finish_reason) chunk.finishReason = delta.finish_reason;

						if (Object.keys(chunk).length > 0) {
							yield chunk;
						}
					}
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	}

	async isAvailable(): Promise<boolean> {
		if (this.authMode === "vertex") {
			return Boolean(
				this.vertexProjectId() &&
					(this.config.accessToken ||
						process.env.GOOGLE_VERTEX_ACCESS_TOKEN ||
						this.config.credentialsFile ||
						process.env.GOOGLE_APPLICATION_CREDENTIALS),
			);
		}
		return !!this.apiKey;
	}
}

function base64url(value: string): string {
	return Buffer.from(value)
		.toString("base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function signJwt(
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
	privateKey: string,
): string {
	const input = `${base64url(JSON.stringify(header))}.${base64url(
		JSON.stringify(payload),
	)}`;
	const signature = createSign("RSA-SHA256")
		.update(input)
		.sign(privateKey, "base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
	return `${input}.${signature}`;
}
