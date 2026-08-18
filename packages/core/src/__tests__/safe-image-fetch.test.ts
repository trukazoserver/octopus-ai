import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { fetchSafeImage } from "../security/safe-image-fetch.js";
import { UrlSafetyPolicy } from "../security/url-safety.js";

describe("fetchSafeImage", () => {
	const originalFetch = globalThis.fetch;
	const policy = new UrlSafetyPolicy({ dnsLookup: { enabled: false } });

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("revalidates redirects and blocks private redirect targets", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/private.png" },
			}),
		) as typeof fetch;

		await expect(
			fetchSafeImage("https://public.example/image.png", {
				policy,
				context: "Test image",
			}),
		).rejects.toThrow(/blocked by URL safety policy/i);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("rejects oversized responses before buffering them", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(new Uint8Array([1]), {
				headers: {
					"content-type": "image/png",
					"content-length": "1000",
				},
			}),
		) as typeof fetch;

		await expect(
			fetchSafeImage("https://public.example/image.png", {
				policy,
				context: "Test image",
				maxBytes: 100,
			}),
		).rejects.toThrow(/exceeds the 100-byte limit/i);
	});

	it("rejects non-image content", async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response("not an image", {
				headers: { "content-type": "text/plain" },
			}),
		) as typeof fetch;

		await expect(
			fetchSafeImage("https://public.example/image.png", {
				policy,
				context: "Test image",
			}),
		).rejects.toThrow(/non-image content/i);
	});

	it("pins the HTTP connection to the address validated by the policy", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "image/png" });
			response.end(Buffer.from([1, 2, 3]));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing test port");
			const pinnedPolicy = {
				resolveAllowedAsync: async (rawUrl: string) => ({
					url: new URL(rawUrl),
					addresses: [
						{ address: "127.0.0.2", family: 4 as const },
						{ address: "127.0.0.1", family: 4 as const },
					],
				}),
			} as UrlSafetyPolicy;
			globalThis.fetch = vi.fn(async () => {
				throw new Error("global fetch must not perform a second DNS lookup");
			}) as typeof fetch;

			const result = await fetchSafeImage(
				`http://validated.example:${address.port}/image.png`,
				{ policy: pinnedPolicy, context: "Pinned image" },
			);

			expect(result.buffer).toEqual(Buffer.from([1, 2, 3]));
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
