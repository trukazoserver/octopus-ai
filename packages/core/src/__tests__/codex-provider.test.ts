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
});
