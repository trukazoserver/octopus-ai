import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexProvider } from "../ai/providers/codex.js";
import type { LLMRequest, ProviderConfig } from "../ai/types.js";

const config = {
	accessToken: "old-token",
	accountId: "acct-1",
} as ProviderConfig;

const baseRequest: LLMRequest = {
	model: "gpt-5.5",
	messages: [{ role: "user", content: "hi" }],
	stream: true,
};

/** Build a fetch Response whose body streams SSE chunks then closes. */
function sseResponse(
	chunks: string[],
	status = 200,
	statusText = "OK",
): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (status === 200) {
				const enc = new TextEncoder();
				for (const c of chunks) controller.enqueue(enc.encode(c));
			}
			controller.close();
		},
	});
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		body: stream,
		headers: new Headers(),
		text: async () => "",
	} as unknown as Response;
}

const COMPLETED = [
	'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
	'data: {"type":"response.completed","response":{"model":"gpt-5.5","usage":{"input_tokens":1,"output_tokens":2}}}\n\n',
];

const originalFetch = globalThis.fetch;

/**
 * Mock fetch that returns 401 when the Authorization header holds the stale
 * token, and 200 (valid SSE) when it holds the refreshed token. Records how
 * many times fetch was called and with which tokens.
 */
function makeFetchTrackingRefresher() {
	const calls: string[] = [];
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		const headers = init.headers as Record<string, string>;
		const auth = (headers.Authorization ?? "").replace(/^Bearer\s+/i, "");
		calls.push(auth);
		if (auth === "old-token") {
			return sseResponse([], 401, "Unauthorized");
		}
		return sseResponse(COMPLETED, 200);
	});
	return { fetchMock, calls };
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of gen) {
		/* consume */
	}
}

describe("CodexProvider reactive 401 token refresh", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn() as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("refreshes on 401, retries, and succeeds", async () => {
		const { fetchMock, calls } = makeFetchTrackingRefresher();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = new CodexProvider(config);
		provider.onTokenRefresh = async () => ({
			accessToken: "new-token",
			expiresAt: Date.now() + 3_600_000,
		});

		await drain(provider.chatStream(baseRequest));

		// First call used the stale token (401); second used the refreshed one (200).
		expect(calls).toEqual(["old-token", "new-token"]);
	});

	it("propagates the original 401 when the refresh hook throws", async () => {
		const { fetchMock, calls } = makeFetchTrackingRefresher();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = new CodexProvider(config);
		provider.onTokenRefresh = async () => {
			throw new Error("refresh token revoked");
		};

		await expect(drain(provider.chatStream(baseRequest))).rejects.toThrow(
			/Codex backend error \(401\)/,
		);
		// Only the initial stale-token call happened (no retry).
		expect(calls).toEqual(["old-token"]);
	});

	it("propagates the 401 when no refresh hook is wired", async () => {
		const { fetchMock } = makeFetchTrackingRefresher();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const provider = new CodexProvider(config); // no onTokenRefresh

		await expect(drain(provider.chatStream(baseRequest))).rejects.toThrow(
			/Codex backend error \(401\)/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("dedupes concurrent 401s to a single refresh", async () => {
		const { fetchMock, calls } = makeFetchTrackingRefresher();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		let refreshCalls = 0;
		const provider = new CodexProvider(config);
		provider.onTokenRefresh = async () => {
			refreshCalls++;
			// Yield so both callers overlap on the in-flight promise.
			await Promise.resolve();
			return { accessToken: "new-token", expiresAt: Date.now() + 3_600_000 };
		};

		await Promise.all([
			drain(provider.chatStream(baseRequest)),
			drain(provider.chatStream(baseRequest)),
		]);

		// The refresh hook fired exactly once despite two concurrent 401s.
		expect(refreshCalls).toBe(1);
		// Each chatStream did stale(401) then refreshed(200) → 4 fetches, all
		// paired old/new.
		expect(calls).toHaveLength(4);
		expect(calls.filter((t) => t === "new-token")).toHaveLength(2);
	});

	it("refreshes PROACTIVELY before the request when the token is near expiry", async () => {
		// Fresh token → 200 on first fetch; the proactive refresh fires first.
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const headers = init.headers as Record<string, string>;
			const auth = (headers.Authorization ?? "").replace(/^Bearer\s+/i, "");
			// The proactive refresh replaces the token before any fetch, so the
			// only fetch we see carries the refreshed token and succeeds.
			return auth === "fresh-token"
				? sseResponse(COMPLETED, 200)
				: sseResponse([], 401, "Unauthorized");
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const nearExpiry = {
			...config,
			oauthExpiresAt: Date.now() + 60_000,
		} as ProviderConfig;
		const provider = new CodexProvider(nearExpiry);
		provider.onTokenRefresh = async () => ({
			accessToken: "fresh-token",
			expiresAt: Date.now() + 3_600_000,
		});

		await drain(provider.chatStream(baseRequest));

		// No 401 ever happened — the token was refreshed proactively, so the lone
		// fetch already carried "fresh-token" and succeeded.
		const auths = fetchMock.mock.calls.map((c) =>
			((c[1]?.headers as Record<string, string>)?.Authorization ?? "").replace(
				/^Bearer\s+/i,
				"",
			),
		);
		expect(auths).toContain("fresh-token");
		expect(auths).not.toContain("old-token");
	});
});
