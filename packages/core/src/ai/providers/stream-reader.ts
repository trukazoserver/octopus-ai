/**
 * Streaming-read helpers shared by every provider's `chatStream`.
 *
 * Octopus parses SSE manually via `response.body.getReader()`. Each `read()`
 * resolves only when bytes arrive, so a per-read timeout IS chunk-gap/stale
 * detection: if the provider stops sending data (keep-alive pings with no
 * content, a hung prefill, a dropped connection that never EOFs), the timeout
 * rejects and the router's retry/fallback engages — instead of the run hanging
 * until the worker wall-clock cap (`workerTimeoutMs`).
 *
 * Mirrors HermesAgent's `HERMES_STREAM_READ_TIMEOUT` (+ the local-provider
 * auto-raise to 30 min, since local LLMs can take minutes on large prefills
 * before emitting the first token) and opencode's `chunkTimeout`.
 */

/**
 * True when `url` points at a local/self-hosted endpoint. For local endpoints
 * the stream-read timeout is auto-raised (long prefills) and stale-detection is
 * more lenient — matching HermesAgent's local-provider behavior.
 */
export function isLocalBaseUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		if (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "0.0.0.0" ||
			host === "::1"
		) {
			return true;
		}
		if (host.endsWith(".local")) return true;
		return false;
	} catch {
		return false;
	}
}

/** One chunk returned by `reader.read()` (done flag + optional bytes). */
export type StreamReaderChunk = {
	done: boolean;
	value: Uint8Array | undefined;
};

/**
 * Reads one chunk from `reader`, rejecting with `<label> stream read timeout`
 * if no data arrives within `timeoutMs`. The timer is cleared on every
 * resolution so a busy stream never trips the guard.
 */
export async function readNextWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
	label: string,
): Promise<StreamReaderChunk> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<StreamReaderChunk>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`${label} stream read timeout (no data for ${Math.round(
									timeoutMs / 1000,
								)}s)`,
							),
						),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
