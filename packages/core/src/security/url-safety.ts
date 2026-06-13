import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface UrlSafetyPolicyConfig {
	enabled?: boolean;
	allowedProtocols?: string[];
	allowPrivateNetworks?: boolean;
	dnsLookup?: {
		enabled?: boolean;
		failClosed?: boolean;
	};
	blocklist?: string[];
	allowlist?: string[];
}

export interface UrlSafetyDecision {
	allowed: boolean;
	reason?: string;
	url?: URL;
}

export interface UrlSafetyPolicyOptions {
	lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
}

const DEFAULT_ALLOWED_PROTOCOLS = ["https:", "http:"];
const DEFAULT_BLOCKLIST = ["localhost", "*.localhost", "169.254.169.254"];

export class UrlSafetyPolicy {
	private readonly enabled: boolean;
	private readonly allowedProtocols: Set<string>;
	private readonly allowPrivateNetworks: boolean;
	private readonly dnsLookupEnabled: boolean;
	private readonly dnsLookupFailClosed: boolean;
	private readonly blocklist: string[];
	private readonly allowlist: string[];
	private readonly lookup: (
		hostname: string,
	) => Promise<Array<{ address: string }>>;

	constructor(
		config: UrlSafetyPolicyConfig = {},
		options: UrlSafetyPolicyOptions = {},
	) {
		this.enabled = config.enabled ?? true;
		this.allowedProtocols = new Set(
			(config.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS).map((protocol) =>
				protocol.endsWith(":")
					? protocol.toLowerCase()
					: `${protocol.toLowerCase()}:`,
			),
		);
		this.allowPrivateNetworks = config.allowPrivateNetworks ?? false;
		this.dnsLookupEnabled = config.dnsLookup?.enabled ?? true;
		this.dnsLookupFailClosed = config.dnsLookup?.failClosed ?? true;
		this.blocklist = [...DEFAULT_BLOCKLIST, ...(config.blocklist ?? [])];
		this.allowlist = config.allowlist ?? [];
		this.lookup =
			options.lookup ??
			((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
	}

	assertAllowed(rawUrl: string, context = "URL"): URL {
		const decision = this.evaluate(rawUrl);
		if (!decision.allowed || !decision.url) {
			throw new Error(
				`${context} blocked by URL safety policy: ${decision.reason}`,
			);
		}
		return decision.url;
	}

	async assertAllowedAsync(rawUrl: string, context = "URL"): Promise<URL> {
		const decision = await this.evaluateAsync(rawUrl);
		if (!decision.allowed || !decision.url) {
			throw new Error(
				`${context} blocked by URL safety policy: ${decision.reason}`,
			);
		}
		return decision.url;
	}

	async evaluateAsync(rawUrl: string): Promise<UrlSafetyDecision> {
		const decision = this.evaluate(rawUrl);
		if (!decision.allowed || !decision.url || !this.enabled) return decision;
		if (this.allowPrivateNetworks || !this.dnsLookupEnabled) return decision;

		const hostname = normalizeHostname(decision.url.hostname);
		if (isIP(hostname)) return decision;

		try {
			const records = await this.lookup(hostname);
			const privateRecord = records.find((record) =>
				isPrivateOrLocalHost(normalizeHostname(record.address)),
			);
			if (privateRecord) {
				return {
					allowed: false,
					reason: `host '${hostname}' resolves to private or local address '${privateRecord.address}'`,
					url: decision.url,
				};
			}
			return decision;
		} catch (error) {
			if (!this.dnsLookupFailClosed) return decision;
			return {
				allowed: false,
				reason: `DNS lookup failed for host '${hostname}': ${error instanceof Error ? error.message : String(error)}`,
				url: decision.url,
			};
		}
	}

	evaluate(rawUrl: string): UrlSafetyDecision {
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return { allowed: false, reason: "invalid URL" };
		}

		if (!this.enabled) return { allowed: true, url };

		if (!this.allowedProtocols.has(url.protocol.toLowerCase())) {
			return {
				allowed: false,
				reason: `protocol '${url.protocol}' is not allowed`,
				url,
			};
		}

		const hostname = normalizeHostname(url.hostname);
		if (!hostname) return { allowed: false, reason: "missing hostname", url };

		if (
			matchesAny(hostname, this.blocklist) &&
			!matchesAny(hostname, this.allowlist)
		) {
			return {
				allowed: false,
				reason: `host '${hostname}' is blocklisted`,
				url,
			};
		}

		if (!this.allowPrivateNetworks && isPrivateOrLocalHost(hostname)) {
			return {
				allowed: false,
				reason: `host '${hostname}' resolves to a private or local network`,
				url,
			};
		}

		return { allowed: true, url };
	}
}

function normalizeHostname(hostname: string): string {
	return hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
}

function matchesAny(hostname: string, patterns: string[]): boolean {
	return patterns.some((pattern) => matchesHostPattern(hostname, pattern));
}

function matchesHostPattern(hostname: string, pattern: string): boolean {
	const normalized = normalizeHostname(pattern.trim());
	if (!normalized) return false;
	if (normalized.startsWith("*.")) {
		const suffix = normalized.slice(1);
		return hostname.endsWith(suffix) && hostname.length > suffix.length;
	}
	return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function isPrivateOrLocalHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (hostname.endsWith(".local") || hostname.endsWith(".internal"))
		return true;

	const ipVersion = isIP(hostname);
	if (ipVersion === 4) return isPrivateIpv4(hostname);
	if (ipVersion === 6) return isPrivateIpv6(hostname);
	return false;
}

function isPrivateIpv4(hostname: string): boolean {
	const octets = hostname.split(".").map((part) => Number(part));
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
		return true;
	}
	const [a, b] = octets;
	if (a === undefined || b === undefined) return true;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	if (normalized === "::1" || normalized === "::") return true;
	if (
		normalized.startsWith("fe80:") ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd")
	) {
		return true;
	}
	if (normalized.startsWith("::ffff:")) {
		const mappedIpv4 = normalized.slice("::ffff:".length);
		return isIP(mappedIpv4) === 4 ? isPrivateIpv4(mappedIpv4) : true;
	}
	return false;
}
