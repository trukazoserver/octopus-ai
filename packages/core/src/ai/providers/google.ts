import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
	LLMChunk,
	LLMMessage,
	LLMRequest,
	LLMResponse,
	LLMToolCall,
	ProviderConfig,
	ReasoningEffort,
} from "../types.js";
import { BaseLLMProvider, verifyModelsGet } from "./base.js";
import { readNextWithTimeout } from "./stream-reader.js";

interface GoogleServiceAccountCredentials {
	client_email?: string;
	private_key?: string;
	token_uri?: string;
	project_id?: string;
}

const EFFORT_BUDGET: Record<Exclude<ReasoningEffort, "none">, number> = {
	low: 128,
	medium: 1024,
	high: 8192,
	xhigh: 24576,
};

interface VertexPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: { id?: string; name: string; args?: unknown };
}

interface VertexCandidate {
	content?: { parts?: VertexPart[] };
	finishReason?: string;
}

interface VertexPayload {
	error?: { message?: string } | string;
	candidates?: VertexCandidate[];
	promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		totalTokenCount?: number;
	};
}

// Gemini requires the exact signature when a function call is replayed. Keep
// IDs unique process-wide so signatures survive provider reconfiguration and
// cannot be overwritten by a later tool call or concurrent conversation.
let vertexToolCallCounter = 0;
const thoughtSignatures = new Map<string, string>();
const nativeVertexToolCallIds = new Map<string, string>();

/**
 * Gemini's native API is stricter than OpenAI: every `type: "array"` property
 * MUST have an `items` sub-schema. OpenAI tool schemas sometimes omit `items`.
 * This recursively adds `items: {}` to every array missing it so the schema
 * passes Gemini validation. Operates on a deep-cloned schema (caller clones).
 */
function sanitizeSchemaForGemini(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	const s = schema as Record<string, unknown>;
	if (s.type === "array" && !s.items) s.items = {};
	if (s.items && typeof s.items === "object") sanitizeSchemaForGemini(s.items);
	if (s.properties && typeof s.properties === "object") {
		for (const v of Object.values(s.properties)) {
			sanitizeSchemaForGemini(v);
		}
	}
	if (s.additionalProperties && typeof s.additionalProperties === "object") {
		sanitizeSchemaForGemini(s.additionalProperties);
	}
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		if (Array.isArray(s[key])) {
			for (const item of s[key] as unknown[]) {
				sanitizeSchemaForGemini(item);
			}
		}
	}
	return schema;
}

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
		const credentials = this.loadVertexCredentials(false);
		return (
			this.config.projectId ??
			credentials?.project_id ??
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
			"global"
		);
	}

	private async getHeaders(): Promise<Record<string, string>> {
		if (this.config.authMode === "oauth") {
			const token = this.config.oauthAccessToken;
			if (!token) {
				throw new Error(
					"Google OAuth mode requires an access token. Please login again.",
				);
			}
			return {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			};
		}
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
			this.config.accessToken ??
			this.config.oauthAccessToken ??
			process.env.GOOGLE_VERTEX_ACCESS_TOKEN;
		if (configured?.trim()) return configured.trim();
		if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
			return this.tokenCache.token;
		}
		const credentials = this.loadVertexCredentials(true);
		if (!credentials) {
			throw new Error(
				"Google Vertex auth requires GOOGLE_VERTEX_ACCESS_TOKEN, credentialsJson, credentialsFile, or GOOGLE_APPLICATION_CREDENTIALS",
			);
		}
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

	private loadVertexCredentials(
		throwOnInvalid: boolean,
	): GoogleServiceAccountCredentials | null {
		const rawJson = this.config.credentialsJson;
		if (rawJson?.trim()) {
			try {
				return JSON.parse(rawJson) as GoogleServiceAccountCredentials;
			} catch {
				if (throwOnInvalid) {
					throw new Error("Google credentialsJson is not valid JSON");
				}
				return null;
			}
		}

		const credentialsFile =
			this.config.credentialsFile ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
		if (!credentialsFile || !existsSync(credentialsFile)) return null;
		return JSON.parse(
			readFileSync(credentialsFile, "utf8"),
		) as GoogleServiceAccountCredentials;
	}

	private buildThinkingConfig(request: LLMRequest): Record<string, unknown> {
		const reasoning = request.reasoning;
		if (!reasoning || reasoning.effort === "none") return {};
		const budget = reasoning.budgetTokens ?? EFFORT_BUDGET[reasoning.effort];
		return {
			thinkingConfig: {
				thinkingBudget: budget,
				// MUST be true: Gemini 3.x only attaches the thoughtSignature to
				// functionCalls when includeThoughts is true, and the API rejects
				// historical functionCalls that are missing it (400). We separate
				// thought parts (thought:true) from real content in the parser so
				// the user never sees the reasoning leaked into the response.
				includeThoughts: true,
			},
		};
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		// Vertex uses the native Gemini API (publishers/google/models); the
		// OpenAI-mount endpoint doesn't support location "global" or current models.
		if (this.authMode === "vertex") return this.chatVertex(request);
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
		if (this.authMode === "vertex") {
			yield* this.chatVertexStream(request);
			return;
		}
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
		const readNext = async () =>
			readNextWithTimeout(
				reader,
				this.resolveStreamReadTimeoutMs(120_000, 1_800_000),
				"Google",
			);

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

	// ----------------------------------------------------------------------
	// Vertex AI native Gemini API (publishers/google/models). The OpenAI-mount
	// endpoint doesn't support location "global" or current Gemini models.
	// ----------------------------------------------------------------------

	private vertexGenerateUrl(model: string, stream: boolean): string {
		const location = this.vertexLocation();
		const host =
			location === "global"
				? "aiplatform.googleapis.com"
				: `${location}-aiplatform.googleapis.com`;
		const method = stream ? "streamGenerateContent" : "generateContent";
		const query = stream ? "?alt=sse" : "";
		return `https://${host}/v1/projects/${this.vertexProjectId()}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:${method}${query}`;
	}

	private toVertexInlineData(
		url: string,
	): { mimeType: string; data: string } | null {
		const match = url.match(/^data:([^;]+);base64,(.*)$/);
		if (!match) return null; // remote http(s) URLs are not inlined
		return { mimeType: match[1], data: match[2] };
	}

	private toVertexContent(
		message: LLMMessage,
		toolCallIdToName: Map<string, string>,
	): Record<string, unknown> {
		// Tool result → functionResponse on a user turn. Gemini requires the
		// FUNCTION NAME (not the tool-call id) in functionResponse.name.
		if (message.role === "tool" && message.toolCallId) {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			const name =
				toolCallIdToName.get(message.toolCallId) ?? message.toolCallId;
			const nativeId = nativeVertexToolCallIds.get(message.toolCallId);
			return {
				role: "user",
				parts: [
					{
						functionResponse: {
							...(nativeId ? { id: nativeId } : {}),
							name,
							response: {
								content:
									text ||
									"Generated media is available at the saved media URL.",
							},
						},
					},
				],
			};
		}
		const parts: Record<string, unknown>[] = [];
		if (typeof message.content === "string") {
			if (message.content || !message.toolCalls?.length) {
				parts.push({ text: message.content });
			}
		} else {
			for (const p of message.content) {
				if (p.type === "text") {
					parts.push({ text: p.text });
				} else {
					const inline = this.toVertexInlineData(p.image_url.url);
					if (inline) parts.push({ inlineData: inline });
				}
			}
		}
		// Assistant tool calls → functionCall parts.
		if (message.toolCalls) {
			for (const tc of message.toolCalls) {
				let args: unknown = {};
				try {
					args = JSON.parse(tc.function.arguments || "{}");
				} catch {
					args = {};
				}
				// thoughtSignature is a SIBLING of functionCall in the part.
				const nativeId = nativeVertexToolCallIds.get(tc.id);
				const part: Record<string, unknown> = {
					functionCall: {
						...(nativeId ? { id: nativeId } : {}),
						name: tc.function.name,
						args,
					},
				};
				const sig = thoughtSignatures.get(tc.id);
				if (sig) part.thoughtSignature = sig;
				parts.push(part);
			}
		}
		return { role: message.role === "assistant" ? "model" : "user", parts };
	}

	private buildVertexBody(request: LLMRequest): Record<string, unknown> {
		// Build a map of toolCallId → functionName from assistant turns, so we can
		// resolve the correct name when converting tool results → functionResponse.
		const toolCallIdToName = new Map<string, string>();
		for (const m of request.messages) {
			if (m.role === "assistant" && m.toolCalls) {
				for (const tc of m.toolCalls) {
					toolCallIdToName.set(tc.id, tc.function.name);
				}
			}
		}

		const systemParts: string[] = [];
		const contents: Record<string, unknown>[] = [];
		for (const m of request.messages) {
			if (m.role === "system") {
				const text =
					typeof m.content === "string"
						? m.content
						: m.content
								.filter((p) => p.type === "text")
								.map((p) => (p as { text: string }).text)
								.join("\n");
				if (text) systemParts.push(text);
				continue;
			}
			contents.push(this.toVertexContent(m, toolCallIdToName));
		}

		const body: Record<string, unknown> = { contents };
		if (systemParts.length) {
			body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
		}

		const generationConfig: Record<string, unknown> = {};
		if (request.maxTokens != null)
			generationConfig.maxOutputTokens = request.maxTokens;
		if (request.temperature != null)
			generationConfig.temperature = request.temperature;
		const thinking = this.buildThinkingConfig(request);
		if (thinking.thinkingConfig) {
			generationConfig.thinkingConfig = thinking.thinkingConfig;
		}
		if (Object.keys(generationConfig).length)
			body.generationConfig = generationConfig;

		if (request.tools?.length) {
			body.tools = [
				{
					functionDeclarations: request.tools.map((t) => ({
						name: t.function.name,
						description: t.function.description,
						parameters: sanitizeSchemaForGemini(
							JSON.parse(JSON.stringify(t.function.parameters)),
						),
					})),
				},
			];
		}
		return body;
	}

	private parseVertexCandidate(parts: VertexPart[]): {
		text: string;
		thinking: string;
		toolCalls: LLMToolCall[];
	} {
		const texts: string[] = [];
		const thinkingTexts: string[] = [];
		const toolCalls: LLMToolCall[] = [];
		for (const p of parts) {
			if (p.functionCall) {
				const id = `vertex-tc-${vertexToolCallCounter++}`;
				if (p.functionCall.id) {
					nativeVertexToolCallIds.set(id, p.functionCall.id);
				}
				// thoughtSignature is a SIBLING of functionCall in the part, not
				// nested inside it. Cache it by tool-call id for history rebuild.
				if (p.thoughtSignature) {
					thoughtSignatures.set(id, p.thoughtSignature);
				}
				toolCalls.push({
					id,
					type: "function",
					function: {
						name: p.functionCall.name,
						arguments: JSON.stringify(p.functionCall.args ?? {}),
					},
				});
			} else if (typeof p.text === "string" && p.text) {
				if (p.thought) thinkingTexts.push(p.text);
				else texts.push(p.text);
			}
		}
		return {
			text: texts.join(""),
			thinking: thinkingTexts.join(""),
			toolCalls,
		};
	}

	private vertexChunksFromPayload(parsed: VertexPayload): LLMChunk[] {
		if (parsed.error) {
			throw new Error(
				typeof parsed.error === "string"
					? parsed.error
					: parsed.error.message || JSON.stringify(parsed.error),
			);
		}
		if (parsed.promptFeedback?.blockReason) {
			throw new Error(
				`Google Vertex blocked the prompt (${parsed.promptFeedback.blockReason})${
					parsed.promptFeedback.blockReasonMessage
						? `: ${parsed.promptFeedback.blockReasonMessage}`
						: ""
				}`,
			);
		}

		const chunks: LLMChunk[] = [];
		if (parsed.usageMetadata) {
			const u = parsed.usageMetadata;
			chunks.push({
				usage: {
					promptTokens: u.promptTokenCount ?? 0,
					completionTokens: u.candidatesTokenCount ?? 0,
					totalTokens:
						u.totalTokenCount ??
						(u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0),
					...(u.thoughtsTokenCount
						? { reasoningTokens: u.thoughtsTokenCount }
						: {}),
				},
			});
		}

		const candidate = parsed.candidates?.[0];
		if (!candidate) return chunks;
		const { text, thinking, toolCalls } = this.parseVertexCandidate(
			candidate.content?.parts ?? [],
		);
		if (thinking) chunks.push({ thinking });
		if (text) chunks.push({ content: text });
		for (const tc of toolCalls) chunks.push({ toolCalls: tc });
		if (candidate.finishReason) {
			chunks.push({ finishReason: candidate.finishReason });
		}
		return chunks;
	}

	private parseVertexSseEvent(event: string): {
		chunks: LLMChunk[];
		done: boolean;
	} {
		const payload = event
			.split(/\r\n|\r|\n/)
			.map((line) => line.trimStart())
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!payload) return { chunks: [], done: false };
		if (payload === "[DONE]") return { chunks: [], done: true };
		try {
			return {
				chunks: this.vertexChunksFromPayload(
					JSON.parse(payload) as VertexPayload,
				),
				done: false,
			};
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new Error("Google Vertex stream returned malformed JSON");
			}
			throw error;
		}
	}

	private async chatVertex(request: LLMRequest): Promise<LLMResponse> {
		const model = request.model.replace(/^google\//, "");
		const body = this.buildVertexBody(request);
		const response = await fetch(this.vertexGenerateUrl(model, false), {
			method: "POST",
			headers: await this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});
		if (!response.ok) {
			throw new Error(
				`Google Vertex API error: ${response.status} ${await response.text()}`,
			);
		}
		const data = (await response.json()) as VertexPayload;
		const candidate = data.candidates?.[0];
		const { text, thinking, toolCalls } = this.parseVertexCandidate(
			candidate?.content?.parts ?? [],
		);
		const u = data.usageMetadata;
		return {
			content: text,
			model,
			usage: {
				promptTokens: u?.promptTokenCount ?? 0,
				completionTokens: u?.candidatesTokenCount ?? 0,
				totalTokens:
					u?.totalTokenCount ??
					(u?.promptTokenCount ?? 0) + (u?.candidatesTokenCount ?? 0),
				...(u?.thoughtsTokenCount
					? { reasoningTokens: u.thoughtsTokenCount }
					: {}),
			},
			...(toolCalls.length ? { toolCalls } : {}),
			...(thinking
				? { thinking: [{ type: "thinking" as const, text: thinking }] }
				: {}),
			finishReason: candidate?.finishReason ?? "STOP",
		};
	}

	private async *chatVertexStream(
		request: LLMRequest,
	): AsyncIterable<LLMChunk> {
		const model = request.model.replace(/^google\//, "");
		const body = this.buildVertexBody(request);
		const response = await fetch(this.vertexGenerateUrl(model, true), {
			method: "POST",
			headers: await this.getHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(600000),
		});
		if (!response.ok) {
			throw new Error(
				`Google Vertex API error: ${response.status} ${await response.text()}`,
			);
		}
		const bodyStream = response.body;
		if (!bodyStream) throw new Error("No response body");
		const reader = bodyStream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let sawTerminalEvent = false;
		const readNext = async () =>
			readNextWithTimeout(
				reader,
				this.resolveStreamReadTimeoutMs(120_000, 1_800_000),
				"Google Vertex",
			);

		try {
			streamLoop: while (true) {
				const { done, value } = await readNext();
				if (done) {
					buffer += decoder.decode();
					if (buffer.trim()) {
						const event = this.parseVertexSseEvent(buffer);
						for (const chunk of event.chunks) {
							if (chunk.finishReason) sawTerminalEvent = true;
							yield chunk;
						}
						if (event.done) sawTerminalEvent = true;
					}
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split(/(?:(?:\r\n)|\r|\n){2}/);
				buffer = parts.pop() ?? "";
				for (const part of parts) {
					const event = this.parseVertexSseEvent(part);
					for (const chunk of event.chunks) {
						if (chunk.finishReason) sawTerminalEvent = true;
						yield chunk;
					}
					if (event.done) {
						sawTerminalEvent = true;
						break streamLoop;
					}
				}
			}
			if (!sawTerminalEvent) {
				throw new Error(
					"Google Vertex stream closed before completion (network: connection dropped)",
				);
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
						this.config.oauthAccessToken ||
						process.env.GOOGLE_VERTEX_ACCESS_TOKEN ||
						this.config.credentialsJson ||
						this.config.credentialsFile ||
						process.env.GOOGLE_APPLICATION_CREDENTIALS),
			);
		}
		return !!this.apiKey;
	}

	async verifyKey(): Promise<{ ok: boolean; error?: string }> {
		// Vertex: the SA key was already proven at connect time (prepareVertexProject).
		// Don't mint a JWT here — just check presence.
		if (this.authMode === "vertex") {
			const ok = await this.isAvailable();
			return {
				ok,
				error: ok ? undefined : "Sin proyecto/credenciales de Vertex",
			};
		}
		return verifyModelsGet(
			`${this.getBaseUrl()}/models`,
			await this.getHeaders(),
		);
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
