import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProvider } from "../ai/providers/codex.js";
import type { LLMRequest, ProviderConfig } from "../ai/types.js";

const config = {
	accessToken: "test-token",
	accountId: "acct-1",
} as ProviderConfig;

const baseRequest: LLMRequest = {
	model: "gpt-5.5",
	messages: [{ role: "user", content: "hi" }],
	stream: true,
};

/** Build a fetch Response whose body streams the given SSE chunks then closes. */
function sseResponse(
	chunks: string[],
	opts: { ok?: boolean; status?: number } = {},
): Response {
	const { ok = true, status = 200 } = opts;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		},
	});
	return {
		ok,
		status,
		statusText: ok ? "OK" : "Error",
		body: stream,
		headers: new Headers(),
		text: async () => "",
	} as unknown as Response;
}

const originalFetch = globalThis.fetch;

describe("CodexProvider chatStream resilience", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn();
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("throws a retryable error when the socket drops before response.completed", async () => {
		// Stream emits a partial delta, then the socket closes WITHOUT the
		// terminal response.completed event — the exact failure mode that used
		// to surface as a misleading "empty response".
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			sseResponse([
				'data: {"type":"response.output_text.delta","delta":"par"}\n\n',
				'data: {"type":"response.output_text.delta","delta":"tial"}\n\n',
			]),
		);

		const provider = new CodexProvider(config);

		const chunks: unknown[] = [];
		let thrown: unknown;
		try {
			for await (const c of provider.chatStream(baseRequest)) chunks.push(c);
		} catch (err) {
			thrown = err;
		}

		// Partial content was still yielded before the drop.
		expect(chunks.length).toBeGreaterThan(0);

		// The stream must surface the drop as an error...
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toMatch(/closed before completion/i);
		// ...and the message must be network-flavoured so isRetryableProviderError
		// (which keys off the message text) lets the router + runtime retry it.
		expect((thrown as Error).message).toMatch(/network/i);
	});

	it("completes normally when response.completed arrives", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			sseResponse([
				'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
				'data: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":5}}}\n\n',
			]),
		);

		const provider = new CodexProvider(config);
		const chunks: Array<{ content?: string; finishReason?: string }> = [];
		for await (const chunk of provider.chatStream(baseRequest)) {
			chunks.push(chunk as { content?: string; finishReason?: string });
		}

		const content = chunks.map((c) => c.content ?? "").join("");
		expect(content).toBe("hello");
		expect(chunks.some((c) => c.finishReason === "stop")).toBe(true);
	});

	it("captures full text delivered only via response.output_text.done (no deltas)", async () => {
		// Some Responses-API runs emit the complete text in a single .done
		// event with no preceding .delta events. Without handling .done this
		// turn is misread as empty.
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			sseResponse([
				'data: {"type":"response.output_text.done","text":"hola mundo"}\n\n',
				'data: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":1,"output_tokens":3}}}\n\n',
			]),
		);

		const provider = new CodexProvider(config);
		const chunks: Array<{ content?: string; finishReason?: string }> = [];
		for await (const chunk of provider.chatStream(baseRequest)) {
			chunks.push(chunk as { content?: string; finishReason?: string });
		}
		expect(chunks.map((c) => c.content ?? "").join("")).toBe("hola mundo");
	});

	it("surfaces a moderation refusal as content (not empty)", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			sseResponse([
				'data: {"type":"response.refusal.delta","delta":"I can\'t help with that."}\n\n',
				'data: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":1,"output_tokens":5}}}\n\n',
			]),
		);

		const provider = new CodexProvider(config);
		const chunks: Array<{ content?: string }> = [];
		for await (const chunk of provider.chatStream(baseRequest)) {
			chunks.push(chunk as { content?: string });
		}
		expect(chunks.map((c) => c.content ?? "").join("")).toContain(
			"I can't help with that.",
		);
	});

	it("surfaces a non-2xx response as an error", async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			sseResponse(['data: {"error":"nope"}\n\n'], { ok: false, status: 401 }),
		);

		const provider = new CodexProvider(config);
		await expect(async () => {
			for await (const _ of provider.chatStream(baseRequest)) {
				/* drain */
			}
		}).rejects.toThrow(/Codex backend error \(401\)/);
	});

	it("strips base64 data URIs from the request body so a multi-MB image never 400s", async () => {
		// The agent embeds generated images as base64 data URIs in its output;
		// replaying that to Codex exceeded the 10MB per-field limit (400
		// string_above_max_length) and broke the whole turn. The provider must
		// strip data URIs before sending.
		const dataUri = `data:image/png;base64,${"A".repeat(2_000_000)}`;
		const captured: string[] = [];
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			async (_url: string, init: RequestInit) => {
				captured.push(String(init.body ?? ""));
				return sseResponse([
					'data: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
				]);
			},
		);

		const provider = new CodexProvider(config);
		for await (const _ of provider.chatStream({
			...baseRequest,
			messages: [{ role: "user", content: `here is an image: ${dataUri}` }],
		})) {
			/* drain */
		}

		expect(captured).toHaveLength(1);
		// The 2MB base64 payload was stripped...
		expect(captured[0]).not.toContain("AAAA");
		expect(captured[0]).toContain("[data-uri omitted]");
		// ...so the request body stays tiny instead of multi-MB.
		expect(captured[0].length).toBeLessThan(100_000);
	});

	it("caps any single field that exceeds the provider per-field limit", async () => {
		// A non-base64 blob (e.g. a huge tool output) is truncated with a marker
		// rather than sent verbatim and rejected.
		const huge = "x".repeat(2_000_000);
		const captured: string[] = [];
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			async (_url: string, init: RequestInit) => {
				captured.push(String(init.body ?? ""));
				return sseResponse([
					'data: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
				]);
			},
		);

		const provider = new CodexProvider(config);
		for await (const _ of provider.chatStream({
			...baseRequest,
			messages: [{ role: "user", content: huge }],
		})) {
			/* drain */
		}

		expect(captured).toHaveLength(1);
		expect(captured[0]).toContain("content truncated");
		expect(captured[0].length).toBeLessThan(500_000);
	});
});
