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
import { BaseLLMProvider } from "./base.js";
import type {
	LLMChunk,
	LLMMessage,
	LLMRequest,
	LLMResponse,
	LLMTool,
	LLMToolCall,
	ProviderConfig,
} from "../types.js";

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
	if (codexModelsCache && Date.now() - codexModelsCache.fetchedAt < CODEX_MODELS_TTL_MS) {
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

export class CodexProvider extends BaseLLMProvider {
	private baseUrl: string;
	private accessToken: string;
	private accountId?: string;

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
		if (this.accountId) headers["chatgpt_account_id"] = this.accountId;
		return headers;
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
				if (text) instructions.push(text);
				continue;
			}
			if (msg.role === "tool") {
				// Tool result → function_call_output.
				const output =
					typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
				input.push({
					type: "function_call_output",
					call_id: msg.toolCallId ?? "",
					output,
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
						content: [{ type: "output_text", text }],
					});
				}
				// Prior tool calls → function_call items.
				for (const tc of msg.toolCalls ?? []) {
					input.push({
						type: "function_call",
						call_id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments,
					});
				}
				continue;
			}
			// user
			const content: Array<Record<string, unknown>> = [];
			if (typeof msg.content === "string") {
				content.push({ type: "input_text", text: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "text") {
						content.push({ type: "input_text", text: part.text });
					} else if (part.type === "image_url") {
						content.push({ type: "input_image", image_url: part.image_url.url });
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

	private buildResponsesTools(tools?: LLMTool[]): Array<Record<string, unknown>> {
		if (!tools?.length) return [];
		return tools.map((t) => ({
			type: "function",
			name: t.function.name,
			description: t.function.description,
			parameters: t.function.parameters,
			strict: false,
		}));
	}

	private buildBody(request: LLMRequest, stream: boolean): Record<string, unknown> {
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
					const accumulated = itemId
						? state.argsByItem.get(itemId)
						: undefined;
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
				if (inputTokens || outputTokens) {
					state.usage = {
						promptTokens: inputTokens,
						completionTokens: outputTokens,
						totalTokens: inputTokens + outputTokens,
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
			case "response.created":
			default:
				return null;
		}
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		const response = await fetch(`${this.baseUrl}/responses`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(this.buildBody(request, true)),
		});
		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(`Codex backend error (${response.status}): ${text.slice(0, 400)}`);
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
			argsByItem: new Map<string, { callId: string; name: string; args: string }>(),
			finishReason: undefined as string | undefined,
		};
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const rawLine of lines) {
					const line = rawLine.trim();
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (payload === "[DONE]") return;
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
		} finally {
			reader.releaseLock();
		}
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const state = {
			text: "",
			thinking: "",
			toolCalls: [] as LLMToolCall[],
			argsByItem: new Map<string, { callId: string; name: string; args: string }>(),
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
