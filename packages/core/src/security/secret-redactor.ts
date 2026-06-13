const DEFAULT_SECRET_KEY_RE =
	/(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|bearer|password|passwd|secret|credential|private[_-]?key|client[_-]?secret|cookie|session)/i;

const HIGH_ENTROPY_TOKEN_RE =
	/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[baprs]|ya29|AIza)[A-Za-z0-9_\-]{12,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g;
const AUTH_HEADER_RE =
	/\b(Authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;\r\n]+/gi;
const ASSIGNMENT_RE =
	/\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|credential|private[_-]?key|client[_-]?secret|cookie|session)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)([^"'\s,;}]+)/gi;

export interface SecretRedactorOptions {
	enabled?: boolean;
	mask?: string;
	extraSecretKeys?: string[];
}

export class SecretRedactor {
	private readonly enabled: boolean;
	private readonly mask: string;
	private readonly extraSecretKeys: string[];

	constructor(options: SecretRedactorOptions = {}) {
		this.enabled = options.enabled ?? true;
		this.mask = options.mask ?? "[REDACTED]";
		this.extraSecretKeys = options.extraSecretKeys ?? [];
	}

	redactText(value: string): string {
		if (!this.enabled) return value;
		return value
			.replace(AUTH_HEADER_RE, `$1${this.mask}`)
			.replace(ASSIGNMENT_RE, `$1$2${this.mask}`)
			.replace(JWT_RE, this.mask)
			.replace(HIGH_ENTROPY_TOKEN_RE, this.mask);
	}

	redact<T>(value: T): T {
		if (!this.enabled) return value;
		return this.redactValue(value, new WeakSet()) as T;
	}

	private isSecretKey(key: string): boolean {
		return (
			DEFAULT_SECRET_KEY_RE.test(key) ||
			this.extraSecretKeys.some(
				(secretKey) => secretKey.toLowerCase() === key.toLowerCase(),
			)
		);
	}

	private redactValue(value: unknown, seen: WeakSet<object>): unknown {
		if (typeof value === "string") return this.redactText(value);
		if (value === null || typeof value !== "object") return value;
		if (seen.has(value)) return "[Circular]";
		seen.add(value);

		if (Array.isArray(value)) {
			return value.map((item) => this.redactValue(item, seen));
		}

		const redacted: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			redacted[key] = this.isSecretKey(key)
				? this.mask
				: this.redactValue(item, seen);
		}
		return redacted;
	}
}

export const secretRedactor = new SecretRedactor();
