import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import type {
	UrlSafetyPolicy,
	UrlSafetyResolution,
} from "./url-safety.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchSafeImage(
	rawUrl: string,
	options: {
		policy: UrlSafetyPolicy;
		context: string;
		maxBytes?: number;
		timeoutMs?: number;
		maxRedirects?: number;
	},
): Promise<{ buffer: Buffer; mimeType: string; finalUrl: string }> {
	const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const maxRedirects = options.maxRedirects ?? 3;
	let currentUrl = rawUrl;

	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		const resolution = await options.policy.resolveAllowedAsync(
			currentUrl,
			options.context,
		);
		const response = await requestResolvedImage(resolution, timeoutMs, maxBytes);
		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("location");
			if (!location) throw new Error(`${options.context} redirect is missing Location.`);
			if (redirects === maxRedirects) {
				throw new Error(`${options.context} exceeded ${maxRedirects} redirects.`);
			}
			currentUrl = new URL(location, currentUrl).toString();
			continue;
		}
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`${options.context} failed (${response.status}).`);
		}
		const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
		if (!mimeType?.startsWith("image/")) {
			throw new Error(`${options.context} returned non-image content (${mimeType || "unknown"}).`);
		}
		return { buffer: response.buffer, mimeType, finalUrl: currentUrl };
	}

	throw new Error(`${options.context} could not be fetched.`);
}

async function requestResolvedImage(
	resolution: UrlSafetyResolution,
	timeoutMs: number,
	maxBytes: number,
): Promise<{ status: number; headers: Headers; buffer: Buffer }> {
	if (resolution.addresses.length === 0) {
		const response = await fetch(resolution.url, {
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		return {
			status: response.status,
			headers: response.headers,
			buffer: await readWebBody(response, maxBytes),
		};
	}
	return requestPinned(resolution, timeoutMs, maxBytes);
}

async function requestPinned(
	resolution: UrlSafetyResolution,
	timeoutMs: number,
	maxBytes: number,
): Promise<{ status: number; headers: Headers; buffer: Buffer }> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	for (const address of resolution.addresses) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		try {
			return await requestPinnedAddress(
				resolution.url,
				address,
				remainingMs,
				maxBytes,
			);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("URL safety lookup returned no reachable address.");
}

async function requestPinnedAddress(
	url: URL,
	address: { address: string; family: 4 | 6 },
	timeoutMs: number,
	maxBytes: number,
): Promise<{ status: number; headers: Headers; buffer: Buffer }> {
	const lookup: LookupFunction = (_hostname, _options, callback) => {
		if (_options.all) {
			(callback as unknown as (
				error: NodeJS.ErrnoException | null,
				addresses: Array<{ address: string; family: number }>,
			) => void)(null, [address]);
			return;
		}
		callback(null, address.address, address.family);
	};
	const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
	const response = await new Promise<IncomingMessage>((resolve, reject) => {
		const request = transport(
			url,
			{
				method: "GET",
				headers: { accept: "image/*" },
				lookup,
				signal: AbortSignal.timeout(timeoutMs),
			},
			resolve,
		);
		request.on("error", reject);
		request.end();
	});
	return {
		status: response.statusCode ?? 0,
		headers: normalizeHeaders(response.headers),
		buffer: await readNodeBody(response, maxBytes),
	};
}

async function readWebBody(response: Response, maxBytes: number): Promise<Buffer> {
	assertDeclaredSize(response.headers, maxBytes);
	if (!response.body) return Buffer.alloc(0);
	const chunks: Buffer[] = [];
	let received = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maxBytes) {
				await reader.cancel();
				throw new Error(`Image response exceeds the ${maxBytes}-byte limit.`);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

async function readNodeBody(
	response: IncomingMessage,
	maxBytes: number,
): Promise<Buffer> {
	const headers = normalizeHeaders(response.headers);
	assertDeclaredSize(headers, maxBytes);
	const chunks: Buffer[] = [];
	let received = 0;
	for await (const chunk of response) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		received += buffer.length;
		if (received > maxBytes) {
			response.destroy();
			throw new Error(`Image response exceeds the ${maxBytes}-byte limit.`);
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function assertDeclaredSize(headers: Headers, maxBytes: number): void {
	const declaredLength = Number(headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`Image response exceeds the ${maxBytes}-byte limit.`);
	}
}

function normalizeHeaders(headers: IncomingHttpHeaders): Headers {
	const normalized = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const item of value) normalized.append(name, item);
		} else if (value !== undefined) {
			normalized.set(name, String(value));
		}
	}
	return normalized;
}
