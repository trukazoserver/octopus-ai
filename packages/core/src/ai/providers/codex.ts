/**
 * CodexProvider — talks the OpenAI Codex backend (Responses API) using a
 * ChatGPT-account OAuth access_token (obtained via the Codex login flow).
 *
 * Unlike the standard OpenAI provider (api.openai.com/v1/chat/completions), the
 * Codex backend serves ChatGPT-subscription accounts at
 * `https://chatgpt.com/backend-api/codex/responses` (the Responses API) and
 * requires the `chatgpt_account_id` header. This mirrors what the official
 * Codex CLI does, so a ChatGPT/Codex subscription powers text (and image
 * generation, via a separate tool) without an API key or organization.
 *
 * Format details verified against the Codex CLI source (github.com/openai/codex).
 */
import { randomUUID } from "node:crypto";
import type {
	LLMChunk,
	LLMMessage,
	LLMRequest,
	LLMResponse,
	LLMTool,
	LLMToolCall,
	ProviderConfig,
} from "../types.js";
import { BaseLLMProvider } from "./base.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const ORIGINATOR = "codex_cli_rs";
/** Client version sent to /models (matches the @openai/codex npm release). */
const CODEX_CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION || "0.142.0";
const CODEX_MODELS_TTL_MS = 60 * 60_000; // 1 hour cache

let codexModelsCache: { models: string[]; fetchedAt: number } | null = null;

/**
 * Fetch the list of models the Codex backend supports for this ChatGPT account
 * (same source as `codex models`), with a 1-hour cache. Returns the cached list
 * (or []) on error so the UI never blocks on a model fetch.
 */
export async function listCodexModels(accessToken: string): Promise<string[]> {
	if (
		codexModelsCache &&
		Date.now() - codexModelsCache.fetchedAt < CODEX_MODELS_TTL_MS
	) {
		return codexModelsCache.models;
	}
	try {
		const token = accessToken.replace(/^Bearer\s+/i, "");
		const resp = await fetch(
			`${CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`,
			{ headers: { Authorization: `Bearer ${token}`, originator: ORIGINATOR } },
		);
		if (!resp.ok) return codexModelsCache?.models ?? [];
		const data = (await resp.json()) as
			| { models?: Array<{ slug?: string }> }
			| Array<{ slug?: string }>;
		const arr = Array.isArray(data) ? data : (data.models ?? []);
		const models = arr
			.map((m) => m.slug)
			.filter((s): s is string => typeof s === "string" && s.length > 0);
		codexModelsCache = { models, fetchedAt: Date.now() };
		return models;
	} catch {
		return codexModelsCache?.models ?? [];
	}
}

interface ResponseInputItem {
	type: string;
	role?: string;
	content?: Array<Record<string, unknown>>;
	[name: string]: unknown;
}

/**
 * Per-string cap for content sent to the Codex backend. The Responses API
 * rejects any single string > ~10MB with HTTP 400 `string_above_max_length`
 * (param `input[N].output`), which a turn hits as soon as the assistant
 * embeds generated images as base64 data URIs in its output/HTML, or a tool
 * returns a large blob. 1MB per field stays well under the limit while leaving
 * the surrounding structure intact.
 */
const CODEX_MAX_FIELD_CHARS = 1_000_000;
const DATA_URI_RE =
	/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}/gi;

function sanitizeForTransport(text: string): string {
	if (typeof text !== "string") return text;
	let out = text;
	if (out.includes(";base64,")) {
		// Strip embedded image/media data URIs (the usual cause of multi-MB
		// outputs when the agent inlines generated images as base64).
		out = out.replace(DATA_URI_RE, "[data-uri omitted]");
	}
	if (out.length > CODEX_MAX_FIELD_CHARS) {
		const head = out.slice(0, 200_000);
		const tail = out.slice(-100_000);
		out = `${head}\n\n[...content truncated: ${out.length - 300_000} chars omitted to fit the provider's per-field limit...]\n\n${tail}`;
	}
	return out;
}

export class CodexProvider extends BaseLLMProvider {
	private baseUrl: string;
	private accessToken: string;
	private accountId?: string;
	/**
	 * Router-injected refresh callback. When set, a 401 from the Codex backend
	 * triggers a single token refresh (which also persists the new token), then
	 * retries the request. If unset or refresh fails, the 401 propagates so the
	 * router's fallback can take over. Kept as a callback (not a direct import
	 * of the auth module) to avoid a circular provider↔auth dependency.
	 */
	onTokenRefresh?: () => Promise<string>;
	private inflightRefresh?: Promise<string>;

	constructor(config: ProviderConfig) {
		super(config);
		// The Codex backend is fixed for ChatGPT-auth sessions; ignore the OpenAI
		// api.openai.com baseUrl (only allow an explicit CODEX_BASE_URL override).
		this.baseUrl = (process.env.CODEX_BASE_URL || CODEX_BASE_URL).replace(
			/\/+$/,
			"",
		);
		this.accessToken = config.accessToken ?? "";
		this.accountId = config.accountId;
	}

	async isAvailable(): Promise<boolean> {
		return Boolean(this.accessToken);
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.accessToken.replace(/^Bearer\s+/i, "")}`,
			"content-type": "application/json",
			accept: "text/event-stream",
			originator: ORIGINATOR,
			"session-id": randomUUID(),
		};
		if (this.accountId) headers.chatgpt_account_id = this.accountId;
		return headers;
	}

	/**
	 * Refresh the access_token exactly once, deduping concurrent callers on a
	 * shared in-flight promise (parallel 401s must not trigger N refreshes).
	 * Updates this.accessToken immediately so the next call uses it even before
	 * persistence completes. Throws if no hook is wired or the refresh fails.
	 */
	private async refreshOnce(): Promise<string> {
		if (this.inflightRefresh) return this.inflightRefresh;
		const refresh = this.onTokenRefresh;
		if (!refresh) {
			throw new Error(
				"Codex 401: no token-refresh hook wired (re-login required)",
			);
		}
		this.inflightRefresh = (async () => {
			try {
				const fresh = await refresh();
				this.accessToken = fresh;
				return fresh;
			} finally {
				this.inflightRefresh = undefined;
			}
		})();
		return this.inflightRefresh;
	}

	/**
	 * POST to the Codex backend. On a 401 (expired ChatGPT access_token), if a
	 * refresh hook is wired, refresh once and retry the same request. If refresh
	 * fails or there's no hook, return the original 401 response so the caller
	 * surfaces a normal auth error (→ router fallback / runtime terminal auth).
	 */
	private async codexFetch(url: string, init: RequestInit): Promise<Response> {
		let response = await fetch(url, init);
		if (response.status === 401 && this.onTokenRefresh) {
			try {
				// refreshOnce dedupes concurrent callers on a shared in-flight
				// promise, so N parallel 401s trigger a single refresh.
				const fresh = await this.refreshOnce();
				response = await fetch(url, {
					...init,
					headers: {
						...(init.headers as Record<string, string>),
						Authorization: `Bearer ${fresh.replace(/^Bearer\s+/i, "")}`,
					},
				});
			} catch {
				// refresh failed — surface the original 401 (fall through below)
			}
		}
		return response;
	}

	private mapModel(model: string): string {
		return model.startsWith("openai/") ? model.slice("openai/".length) : model;
	}

	/** Build the Responses API `instructions` + `input[]` from chat messages. */
	private buildResponsesInput(messages: LLMMessage[]): {
		instructions?: string;
		input: ResponseInputItem[];
	} {
		const instructions: string[] = [];
		const input: ResponseInputItem[] = [];
		for (const msg of messages) {
			if (msg.role === "system") {
				const text = typeof msg.content === "string" ? msg.content : "";
				if (text) instructions.push(sanitizeForTransport(text));
				continue;
			}
			if (msg.role === "tool") {
				// Tool result → function_call_output.
				const output =
					typeof msg.content === "string"
						? msg.content
						: JSON.stringify(msg.content);
				input.push({
					type: "function_call_output",
					call_id: msg.toolCallId ?? "",
					output: sanitizeForTransport(output),
				});
				continue;
			}
			if (msg.role === "assistant") {
				// Assistant text → output_text message.
				const text = typeof msg.content === "string" ? msg.content : "";
				if (text) {
					input.push({
						type: "message",
						role: "assistant",
						content: [
							{ type: "output_text", text: sanitizeForTransport(text) },
						],
					});
				}
				// Prior tool calls → function_call items.
				for (const tc of msg.toolCalls ?? []) {
					input.push({
						type: "function_call",
						call_id: tc.id,
						name: tc.function.name,
						arguments: sanitizeForTransport(tc.function.arguments),
					});
				}
				continue;
			}
			// user
			const content: Array<Record<string, unknown>> = [];
			if (typeof msg.content === "string") {
				content.push({
					type: "input_text",
					text: sanitizeForTransport(msg.content),
				});
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "text") {
						content.push({
							type: "input_text",
							text: sanitizeForTransport(part.text),
						});
					} else if (part.type === "image_url") {
						content.push({
							type: "input_image",
							image_url: part.image_url.url,
						});
					}
				}
			}
			input.push({ type: "message", role: "user", content });
		}
		return {
			instructions: instructions.length ? instructions.join("\n\n") : undefined,
			input,
		};
	}

	private buildResponsesTools(
		tools?: LLMTool[],
	): Array<Record<string, unknown>> {
		if (!tools?.length) return [];
		return tools.map((t) => ({
			type: "function",
			name: t.function.name,
			description: t.function.description,
			parameters: t.function.parameters,
			strict: false,
		}));
	}

	private buildBody(
		request: LLMRequest,
		stream: boolean,
	): Record<string, unknown> {
		const { instructions, input } = this.buildResponsesInput(request.messages);
		const body: Record<string, unknown> = {
			model: this.mapModel(request.model),
			input,
			tools: this.buildResponsesTools(request.tools),
			tool_choice: request.tools?.length ? "auto" : undefined,
			parallel_tool_calls: request.tools?.length ? true : undefined,
			store: false,
			stream,
		};
		if (instructions) body.instructions = instructions;
		if (request.reasoning && request.reasoning.effort !== "none") {
			body.reasoning = {
				effort: request.reasoning.effort,
				summary: request.reasoning.includeThinking ? "auto" : undefined,
			};
			body.include = ["reasoning.encrypted_content"];
		}
		// Send the output budget explicitly so Octopus (not the provider default)
		// controls how many tokens a turn may emit. OpenAI bills reasoning tokens
		// as output and they count against this limit — when the provider's own
		// default is low, heavy reasoning leaves no room for the visible reply
		// ("razonamiento agotado" / empty response). maxTokens is the cap we set.
		if (request.maxTokens && request.maxTokens > 0) {
			body.max_output_tokens = request.maxTokens;
		}
		// Reasoning models (gpt-5.x with reasoning enabled) reject `temperature`
		// — the Responses API returns 400 "Unsupported parameter: temperature".
		// Only send it for non-reasoning calls.
		const reasoningOn = !!(
			request.reasoning && request.reasoning.effort !== "none"
		);
		if (request.temperature != null && !reasoningOn) {
			body.temperature = request.temperature;
		}
		return body;
	}

	/** Parse one SSE `data:` JSON payload into an LLMChunk (or null). */
	private chunkFromEvent(
		data: Record<string, unknown>,
		state: {
			text: string;
			thinking: string;
			toolCalls: LLMToolCall[];
			argsByItem: Map<string, { callId: string; name: string; args: string }>;
			usage?: LLMResponse["usage"];
			finishReason?: string;
			model?: string;
		},
	): LLMChunk | null {
		const type = data.type as string | undefined;
		switch (type) {
			case "response.output_text.delta": {
				const delta = (data.delta as string) ?? "";
				state.text += delta;
				return { content: delta };
			}
			case "response.output_text.done": {
				// Some Responses-API runs deliver the full text only via the
				// `.done` event with NO preceding `.delta` events (shorter
				// replies, certain provider modes). Without this, such a turn is
				// misread as empty. Only emit when we saw no deltas (state.text
				// empty) to avoid double-counting when deltas were streamed.
				if (!state.text) {
					const text = (data.text as string) ?? "";
					if (text) {
						state.text = text;
						return { content: text };
					}
				}
				return null;
			}
			case "response.refusal.delta": {
				// A moderation refusal streams as refusal text, not output_text.
				// Surface it as content so the user sees the refusal instead of
				// an opaque "empty response".
				const delta = (data.delta as string) ?? "";
				state.text += delta;
				return { content: delta };
			}
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta": {
				const delta = (data.delta as string) ?? "";
				state.thinking += delta;
				return { thinking: delta };
			}
			case "response.output_item.added": {
				const item = data.item as Record<string, unknown> | undefined;
				if (item?.type === "function_call") {
					const itemId = (item.id as string) ?? "";
					state.argsByItem.set(itemId, {
						callId: (item.call_id as string) ?? itemId,
						name: (item.name as string) ?? "",
						args: "",
					});
				}
				return null;
			}
			case "response.function_call_arguments.delta": {
				const itemId = (data.item_id as string) ?? "";
				const existing = state.argsByItem.get(itemId);
				if (existing) {
					existing.args += (data.delta as string) ?? "";
				}
				return null;
			}
			case "response.output_item.done": {
				const item = data.item as Record<string, unknown> | undefined;
				if (item?.type === "function_call") {
					const itemId = (item.id as string) ?? "";
					const callId = (item.call_id as string) ?? itemId;
					// Prefer arguments accumulated from the delta stream; fall back to
					// the final value on the done item.
					const accumulated = itemId ? state.argsByItem.get(itemId) : undefined;
					const name = (item.name as string) || accumulated?.name || "";
					const args = (item.arguments as string) ?? accumulated?.args ?? "";
					const toolCall: LLMToolCall = {
						id: callId,
						type: "function",
						function: { name, arguments: args },
					};
					state.toolCalls.push(toolCall);
					// Yield the completed tool call so streaming consumers receive it
					// (the runtime drives tool execution from stream chunks).
					return { toolCalls: toolCall };
				}
				return null;
			}
			case "response.completed": {
				const response = (data.response as Record<string, unknown>) ?? {};
				state.model = (response.model as string) ?? state.model;
				state.finishReason = state.toolCalls.length ? "tool_calls" : "stop";
				const usage = (response.usage as Record<string, unknown>) ?? {};
				const inputTokens =
					Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
				const outputTokens =
					Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
				// Reasoning tokens: the Responses API nests them under
				// output_tokens_details.reasoning_tokens. output_tokens already
				// includes them, so total stays input+output — reasoningTokens is a
				// breakdown metric, not additive. Also accept the Chat Completions
				// completion_tokens_details.reasoning_tokens shape as a fallback.
				const outputDetails = (usage.output_tokens_details ??
					usage.completion_tokens_details) as
					| { reasoning_tokens?: unknown }
					| undefined;
				const reasoningTokens =
					Number(
						outputDetails?.reasoning_tokens ?? usage.reasoning_tokens ?? 0,
					) || 0;
				if (inputTokens || outputTokens) {
					state.usage = {
						promptTokens: inputTokens,
						completionTokens: outputTokens,
						totalTokens: inputTokens + outputTokens,
						...(reasoningTokens ? { reasoningTokens } : {}),
					};
				}
				return {
					finishReason: state.finishReason,
					usage: state.usage,
				};
			}
			case "response.failed":
			case "response.incomplete": {
				state.finishReason = type === "response.failed" ? "error" : "length";
				return { finishReason: state.finishReason };
			}
			default:
				return null;
		}
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		const response = await this.codexFetch(`${this.baseUrl}/responses`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(this.buildBody(request, true)),
			// Bound the whole call so a stalled handshake or a hung upstream
			// can't pin the agent turn forever. Matches the anthropic / openai
			// providers; Codex was the only streaming provider missing this.
			signal: AbortSignal.timeout(600000),
		});
		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(
				`Codex backend error (${response.status}): ${text.slice(0, 400)}`,
			);
		}

		// Capture rate-limit / quota headers (x-codex-*) from every successful
		// response so the quota dashboard reflects real usage without extra calls.
		try {
			this.onResponseHeaders?.(response.headers);
		} catch {
			/* quota capture must never affect the stream */
		}

		const state = {
			text: "",
			thinking: "",
			toolCalls: [] as LLMToolCall[],
			argsByItem: new Map<
				string,
				{ callId: string; name: string; args: string }
			>(),
			finishReason: undefined as string | undefined,
		};
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		// Per-read timeout. If the backend (or an intermediary proxy / load
		// balancer) holds the socket open without sending bytes — a frequent
		// failure mode for long Codex generations — the raw reader.read() would
		// hang indefinitely and freeze the whole turn. The timed-out read throws
		// a retryable error so the runtime's stream-error retry path can recover
		// instead of the user having to pause and manually resume.
		const STREAM_READ_TIMEOUT_MS = 120_000;
		const readNext = async (): Promise<
			Readonly<{ done: boolean; value: Uint8Array | undefined }>
		> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					reader.read(),
					new Promise<
						Readonly<{ done: boolean; value: Uint8Array | undefined }>
					>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error(
										`Codex stream read timeout (no data for ${STREAM_READ_TIMEOUT_MS / 1000}s)`,
									),
								),
							STREAM_READ_TIMEOUT_MS,
						);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		};

		try {
			streamLoop: while (true) {
				const { done, value } = await readNext();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const rawLine of lines) {
					const line = rawLine.trim();
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (payload === "[DONE]") break streamLoop;
					if (!payload) continue;
					try {
						const data = JSON.parse(payload) as Record<string, unknown>;
						const chunk = this.chunkFromEvent(data, state);
						if (chunk) yield chunk;
					} catch {
						// Ignore non-JSON keepalive lines.
					}
				}
			}
			// Premature-close guard. The Responses API always terminates a run
			// with response.completed / response.failed / response.incomplete
			// (each sets state.finishReason). If the stream ended without any of
			// those, the socket was dropped mid-run by the backend or a proxy.
			// Throw a network-flavoured error so BOTH the router retry (which
			// keys off isRetryableProviderError on the message) and the runtime
			// stream-error retry recover it — instead of misclassifying it as an
			// empty response and silently burning the empty-response budget.
			if (!state.finishReason) {
				throw new Error(
					"Codex stream closed before completion (network: connection dropped)",
				);
			}
		} finally {
			// cancel() (not just releaseLock()) tears the underlying socket down
			// when we bail out on timeout or premature close.
			await reader.cancel().catch(() => {});
		}
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const state = {
			text: "",
			thinking: "",
			toolCalls: [] as LLMToolCall[],
			argsByItem: new Map<
				string,
				{ callId: string; name: string; args: string }
			>(),
			usage: undefined as LLMResponse["usage"] | undefined,
			finishReason: "stop" as string | undefined,
			model: this.mapModel(request.model),
		};
		for await (const chunk of this.chatStream(request)) {
			if (chunk.content) state.text += chunk.content;
			if (chunk.thinking) state.thinking += chunk.thinking;
			if (chunk.usage) state.usage = chunk.usage;
			if (chunk.finishReason) state.finishReason = chunk.finishReason;
			if (chunk.toolCalls) state.toolCalls.push(chunk.toolCalls as LLMToolCall);
		}
		return {
			content: state.text,
			model: state.model,
			usage: state.usage ?? {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
			},
			...(state.toolCalls.length ? { toolCalls: state.toolCalls } : {}),
			...(state.thinking
				? { thinking: [{ type: "thinking" as const, text: state.thinking }] }
				: {}),
			finishReason: state.finishReason ?? "stop",
		};
	}
}
