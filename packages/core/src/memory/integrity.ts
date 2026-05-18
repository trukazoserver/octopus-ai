import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import type {
	MemoryCandidate,
	MemorySourceTrustLevel,
	MemoryValidationResult,
} from "./types.js";

const TRUST_CAPS: Record<MemorySourceTrustLevel, number> = {
	system: 1,
	agent: 0.85,
	user_explicit: 0.7,
	user_inferred: 0.55,
	external: 0.45,
};

const INJECTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "remember_directive", pattern: /\b(recuerda que|remember that)\b/i },
	{ label: "from_now_on", pattern: /\b(a partir de ahora|from now on)\b/i },
	{ label: "forget_directive", pattern: /\b(olvida que|forget that)\b/i },
	{
		label: "system_override",
		pattern:
			/\b(ignora (tus|las) instrucciones|ignore (your|previous) instructions|olvida tus instrucciones)\b/i,
	},
	{
		label: "privilege_claim",
		pattern:
			/\b(soy (admin|administrador|root)|i am (admin|administrator|root)|tengo permisos de admin)\b/i,
	},
];

const SENSITIVE_PATTERNS: RegExp[] = [
	/\b(?:api[_-]?key|token|secret|password|contrase(?:ñ|n)a)\s*[:=]\s*[^\s,;]+/gi,
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
	/\b(?:\+?\d[\d\s().-]{8,}\d)\b/g,
];

export class MemoryIntegrityLayer {
	private initialized = false;

	constructor(private db: DatabaseAdapter) {}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.db.run(
			`CREATE TABLE IF NOT EXISTS memory_integrity_log (
				id TEXT PRIMARY KEY,
				tenant_id TEXT NOT NULL,
				user_id TEXT,
				session_id TEXT,
				attempted_content TEXT NOT NULL,
				rejection_reason TEXT NOT NULL,
				detected_pattern TEXT NOT NULL,
				logged_at TEXT NOT NULL
			)`,
		);
		await this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_memory_integrity_tenant ON memory_integrity_log (tenant_id, logged_at)",
		);
		this.initialized = true;
	}

	async validate(candidate: MemoryCandidate): Promise<MemoryValidationResult> {
		await this.initialize();
		const detectedPatterns = INJECTION_PATTERNS.filter(({ pattern }) =>
			pattern.test(candidate.content),
		).map(({ label }) => label);
		const { content, redactions } = this.redactSensitive(candidate.content);
		const confidenceCap = TRUST_CAPS[candidate.sourceTrust];
		const normalizedCandidate: MemoryCandidate = {
			...candidate,
			content,
			confidence: Math.min(
				candidate.confidence ?? confidenceCap,
				confidenceCap,
			),
			metadata: {
				...candidate.metadata,
				integrity: {
					detectedPatterns,
					redactions,
					confidenceCap,
				},
			},
		};

		const privilegedPattern = detectedPatterns.find(
			(pattern) =>
				pattern === "system_override" || pattern === "privilege_claim",
		);
		if (privilegedPattern) {
			await this.log(
				candidate,
				"Rejected privileged memory injection",
				privilegedPattern,
			);
			return {
				allowed: false,
				reason: "Rejected privileged memory injection",
				detectedPatterns,
				redactions,
				confidenceCap,
			};
		}

		if (detectedPatterns.length > 0) {
			await this.log(
				candidate,
				"Downgraded user memory directive",
				detectedPatterns[0],
			);
			normalizedCandidate.sourceTrust =
				candidate.sourceTrust === "system" || candidate.sourceTrust === "agent"
					? candidate.sourceTrust
					: "user_explicit";
			normalizedCandidate.confidence = Math.min(
				normalizedCandidate.confidence ?? confidenceCap,
				TRUST_CAPS.user_explicit,
			);
		}

		return {
			allowed: true,
			candidate: normalizedCandidate,
			detectedPatterns,
			redactions,
			confidenceCap,
		};
	}

	private redactSensitive(content: string): {
		content: string;
		redactions: number;
	} {
		let redactions = 0;
		let redacted = content;
		for (const pattern of SENSITIVE_PATTERNS) {
			redacted = redacted.replace(pattern, () => {
				redactions += 1;
				return "[REDACTED]";
			});
		}
		return { content: redacted, redactions };
	}

	private async log(
		candidate: MemoryCandidate,
		rejectionReason: string,
		detectedPattern: string,
	): Promise<void> {
		await this.db.run(
			`INSERT INTO memory_integrity_log
				(id, tenant_id, user_id, session_id, attempted_content, rejection_reason, detected_pattern, logged_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				nanoid(),
				candidate.scope.tenantId,
				candidate.scope.userId ?? null,
				candidate.scope.sessionId ?? null,
				candidate.content.slice(0, 2000),
				rejectionReason,
				detectedPattern,
				new Date().toISOString(),
			],
		);
	}
}
