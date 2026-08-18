import { createHash, randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "../storage/database.js";
import type { MediaRoute } from "./catalog.js";

export type MediaGenerationJobStatus =
	| "queued"
	| "submitting"
	| "running"
	| "succeeded"
	| "failed"
	| "cancel_requested"
	| "cancelled";

export interface MediaGenerationJobInput {
	mediaType: "image" | "video" | "audio";
	provider: string;
	model?: string;
	transport?: string;
	toolName?: string;
	action?: string;
	prompt?: string;
	request?: Record<string, unknown>;
	idempotencyKey?: string;
	agentId?: string;
	conversationId?: string;
	channelId?: string;
	runId?: string;
	workerId?: string;
	taskId?: string;
	maxAttempts?: number;
}

export interface MediaGenerationJob extends Required<Pick<MediaGenerationJobInput, "mediaType" | "provider">> {
	id: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	status: MediaGenerationJobStatus;
	model?: string;
	transport?: string;
	toolName?: string;
	action?: string;
	prompt?: string;
	request: Record<string, unknown>;
	operationName?: string;
	externalJobId?: string;
	idempotencyKey?: string;
	attempt: number;
	submissionSequence: number;
	maxAttempts: number;
	progress: number;
	error?: string;
	result: Record<string, unknown>;
	mediaUrls: string[];
	agentId?: string;
	conversationId?: string;
	channelId?: string;
	runId?: string;
	workerId?: string;
	taskId?: string;
	estimatedCost?: number;
}

interface MediaGenerationJobRow {
	id: string;
	created_at: string;
	updated_at: string;
	completed_at?: string | null;
	status: MediaGenerationJobStatus;
	media_type: "image" | "video" | "audio";
	provider: string;
	model?: string | null;
	transport?: string | null;
	tool_name?: string | null;
	action?: string | null;
	prompt?: string | null;
	request_json: string;
	operation_name?: string | null;
	external_job_id?: string | null;
	idempotency_key?: string | null;
	attempt: number;
	submission_sequence: number;
	max_attempts: number;
	progress: number;
	error?: string | null;
	result_json: string;
	media_urls_json: string;
	agent_id?: string | null;
	conversation_id?: string | null;
	channel_id?: string | null;
	run_id?: string | null;
	worker_id?: string | null;
	task_id?: string | null;
	estimated_cost?: number | null;
	lease_token?: string | null;
	lease_expires_at?: string | null;
}

function nowIso(): string {
	return new Date().toISOString();
}

function sanitizeJson(value: unknown, parentKey = ""): unknown {
	if (typeof value === "string") {
		if (
			value.startsWith("data:") ||
			(value.length > 4096 && /base64|bytes|binary|data/i.test(parentKey))
		) {
			return "[omitted]";
		}
		if (/url|uri|href|source/i.test(parentKey)) {
			try {
				const url = new URL(value);
				if (url.protocol === "http:" || url.protocol === "https:") {
					url.username = "";
					url.password = "";
					url.search = "";
					url.hash = "";
					return url.toString();
				}
			} catch {
				// Non-URL strings are persisted unchanged.
			}
		}
		return value;
	}
	if (Array.isArray(value))
		return value.map((item) => sanitizeJson(item, parentKey));
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (/token|secret|key|password|credential/i.test(key)) {
			out[key] = "[redacted]";
		} else {
			out[key] = sanitizeJson(item, key);
		}
	}
	return out;
}

function parseJsonObject(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseJsonArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function rowToJob(row: MediaGenerationJobRow): MediaGenerationJob {
	return {
		id: row.id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at ?? undefined,
		status: row.status,
		mediaType: row.media_type,
		provider: row.provider,
		model: row.model ?? undefined,
		transport: row.transport ?? undefined,
		toolName: row.tool_name ?? undefined,
		action: row.action ?? undefined,
		prompt: row.prompt ?? undefined,
		request: parseJsonObject(row.request_json),
		operationName: row.operation_name ?? undefined,
		externalJobId: row.external_job_id ?? undefined,
		idempotencyKey: row.idempotency_key ?? undefined,
		attempt: row.attempt,
		submissionSequence: row.submission_sequence ?? 0,
		maxAttempts: row.max_attempts,
		progress: row.progress,
		error: row.error ?? undefined,
		result: parseJsonObject(row.result_json),
		mediaUrls: parseJsonArray(row.media_urls_json),
		agentId: row.agent_id ?? undefined,
		conversationId: row.conversation_id ?? undefined,
		channelId: row.channel_id ?? undefined,
		runId: row.run_id ?? undefined,
		workerId: row.worker_id ?? undefined,
		taskId: row.task_id ?? undefined,
		estimatedCost: row.estimated_cost ?? undefined,
	};
}

export class MediaGenerationStore {
	constructor(private readonly db: DatabaseAdapter) {}

	async create(input: MediaGenerationJobInput): Promise<MediaGenerationJob> {
		if (input.idempotencyKey) {
			const existing = await this.findByIdempotencyKey(input.idempotencyKey);
			if (existing) {
				assertIdempotencyMatch(existing, input);
				return existing;
			}
		}
		const id = randomUUID();
		const ts = nowIso();
		try {
			await this.db.run(
				`INSERT INTO media_generation_jobs (
				id, created_at, updated_at, status, media_type, provider, model, transport,
				tool_name, action, prompt, request_json, idempotency_key, max_attempts,
				agent_id, conversation_id, channel_id, run_id, worker_id, task_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
				id,
				ts,
				ts,
				"queued",
				input.mediaType,
				input.provider,
				input.model ?? null,
				input.transport ?? null,
				input.toolName ?? null,
				input.action ?? null,
				input.prompt ?? null,
				JSON.stringify(sanitizeJson(input.request ?? {})),
				input.idempotencyKey ?? null,
				input.maxAttempts ?? 1,
				input.agentId ?? null,
				input.conversationId ?? null,
				input.channelId ?? null,
				input.runId ?? null,
				input.workerId ?? null,
				input.taskId ?? null,
				],
			);
		} catch (error) {
			if (input.idempotencyKey) {
				const existing = await this.findByIdempotencyKey(input.idempotencyKey);
				if (existing) {
					assertIdempotencyMatch(existing, input);
					return existing;
				}
			}
			throw error;
		}
		const created = await this.get(id);
		if (!created) throw new Error("Failed to create media generation job");
		return created;
	}

	async list(limit = 50): Promise<MediaGenerationJob[]> {
		const rows = await this.db.all<MediaGenerationJobRow>(
			"SELECT * FROM media_generation_jobs ORDER BY created_at DESC LIMIT ?",
			[Math.max(1, Math.min(200, limit))],
		);
		return rows.map(rowToJob);
	}

	async get(id: string): Promise<MediaGenerationJob | undefined> {
		const row = await this.db.get<MediaGenerationJobRow>(
			"SELECT * FROM media_generation_jobs WHERE id = ?",
			[id],
		);
		return row ? rowToJob(row) : undefined;
	}

	async listResumable(): Promise<MediaGenerationJob[]> {
		const rows = await this.db.all<MediaGenerationJobRow>(
			"SELECT * FROM media_generation_jobs WHERE status IN ('queued', 'submitting', 'running', 'cancel_requested') ORDER BY created_at ASC",
		);
		return rows.map(rowToJob);
	}

	async listForUsageReconciliation(): Promise<MediaGenerationJob[]> {
		const rows = await this.db.all<MediaGenerationJobRow>(
			`SELECT * FROM media_generation_jobs
			 WHERE operation_name IS NOT NULL
			    OR (status = 'failed' AND error LIKE '%acceptance state is unknown%')
			 ORDER BY created_at ASC`,
		);
		return rows.map(rowToJob);
	}

	async claim(
		id: string,
		leaseToken: string,
		leaseMs: number,
	): Promise<boolean> {
		const now = nowIso();
		const expiresAt = new Date(Date.now() + Math.max(1000, leaseMs)).toISOString();
		await this.db.run(
			`UPDATE media_generation_jobs
			SET lease_token = ?, lease_expires_at = ?, updated_at = ?
			WHERE id = ?
			AND status IN ('queued', 'submitting', 'running', 'cancel_requested')
			AND (lease_token IS NULL OR lease_token = ? OR lease_expires_at IS NULL OR lease_expires_at < ?)`,
			[leaseToken, expiresAt, now, id, leaseToken, now],
		);
		const row = await this.db.get<{
			lease_token?: string | null;
		}>("SELECT lease_token FROM media_generation_jobs WHERE id = ?", [id]);
		return row?.lease_token === leaseToken;
	}

	async renewLease(
		id: string,
		leaseToken: string,
		leaseMs: number,
	): Promise<boolean> {
		await this.db.run(
			"UPDATE media_generation_jobs SET lease_expires_at = ? WHERE id = ? AND lease_token = ?",
			[
				new Date(Date.now() + Math.max(1000, leaseMs)).toISOString(),
				id,
				leaseToken,
			],
		);
		const row = await this.db.get<{ lease_token?: string | null }>(
			"SELECT lease_token FROM media_generation_jobs WHERE id = ?",
			[id],
		);
		return row?.lease_token === leaseToken;
	}

	async releaseLease(id: string, leaseToken: string): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?",
			[id, leaseToken],
		);
	}

	async markSubmitting(
		id: string,
		route: MediaRoute,
		attempt: number,
		leaseToken?: string,
	): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ?, provider = ?, model = ?, transport = ?, attempt = ?, submission_sequence = submission_sequence + 1, operation_name = NULL, external_job_id = NULL, progress = ?, error = NULL WHERE id = ? AND status IN ('queued', 'submitting') AND (? IS NULL OR lease_token = ?)",
			[
				"submitting",
				nowIso(),
				route.provider,
				route.model,
				route.transport,
				attempt,
				0.02,
				id,
				leaseToken ?? null,
				leaseToken ?? null,
			],
		);
	}

	async markSubmitted(
		id: string,
		operationName: string,
		externalJobId?: string,
		leaseToken?: string,
	): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ?, operation_name = ?, external_job_id = ?, progress = ? WHERE id = ? AND status = 'submitting' AND (? IS NULL OR lease_token = ?)",
			[
				"running",
				nowIso(),
				operationName,
				externalJobId ?? null,
				0.1,
				id,
				leaseToken ?? null,
				leaseToken ?? null,
			],
		);
	}

	async markProgress(
		id: string,
		progress: number,
		leaseToken?: string,
	): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET updated_at = ?, progress = ? WHERE id = ? AND status = 'running' AND (? IS NULL OR lease_token = ?)",
			[
				nowIso(),
				Math.max(0.1, Math.min(0.99, progress)),
				id,
				leaseToken ?? null,
				leaseToken ?? null,
			],
		);
	}

	async markCompleted(
		id: string,
		mediaUrls: string[],
		result: Record<string, unknown> = {},
		leaseToken?: string,
	): Promise<void> {
		const ts = nowIso();
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ?, completed_at = ?, progress = ?, result_json = ?, media_urls_json = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status IN ('running', 'cancel_requested') AND (? IS NULL OR lease_token = ?)",
			[
				"succeeded",
				ts,
				ts,
				1,
				JSON.stringify(sanitizeJson(result)),
				JSON.stringify(mediaUrls),
				id,
				leaseToken ?? null,
				leaseToken ?? null,
			],
		);
	}

	async appendMediaUrl(
		id: string,
		url: string,
		leaseToken?: string,
	): Promise<string[]> {
		const job = await this.get(id);
		if (!job) throw new Error(`Media job not found: ${id}`);
		const mediaUrls = job.mediaUrls.includes(url)
			? job.mediaUrls
			: [...job.mediaUrls, url];
		await this.db.run(
			"UPDATE media_generation_jobs SET media_urls_json = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'cancel_requested') AND (? IS NULL OR lease_token = ?)",
			[
				JSON.stringify(mediaUrls),
				nowIso(),
				id,
				leaseToken ?? null,
				leaseToken ?? null,
			],
		);
		return (await this.get(id))?.mediaUrls ?? mediaUrls;
	}

	async markFailed(
		id: string,
		error: string,
		leaseToken?: string,
	): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ?, completed_at = ?, error = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status NOT IN ('succeeded', 'cancelled') AND (? IS NULL OR lease_token = ?)",
			[
				"failed",
				nowIso(),
				nowIso(),
				error,
				id,
				leaseToken ?? null,
				leaseToken ?? null,
			],
		);
	}

	async markCancelled(id: string): Promise<void> {
		const ts = nowIso();
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ?, completed_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')",
			["cancelled", ts, ts, id],
		);
	}

	async cancelQueued(id: string): Promise<boolean> {
		const ts = nowIso();
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ?, completed_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'queued'",
			["cancelled", ts, ts, id],
		);
		return (await this.get(id))?.status === "cancelled";
	}

	async requeue(id: string): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ?, completed_at = NULL, operation_name = NULL, external_job_id = NULL, attempt = 0, progress = 0, error = NULL, result_json = '{}', media_urls_json = '[]', lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status IN ('failed', 'cancelled')",
			["queued", nowIso(), id],
		);
	}

	async resumeAccepted(id: string): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ?, completed_at = NULL, progress = 0.1, error = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'failed' AND operation_name IS NOT NULL",
			["running", nowIso(), id],
		);
	}

	async requestCancel(id: string): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'submitting', 'running')",
			["cancel_requested", nowIso(), id],
		);
	}

	async restoreRunningAfterCancel(id: string): Promise<void> {
		await this.db.run(
			"UPDATE media_generation_jobs SET status = ?, updated_at = ? WHERE id = ? AND status = 'cancel_requested'",
			["running", nowIso(), id],
		);
	}

	private async findByIdempotencyKey(idempotencyKey: string): Promise<MediaGenerationJob | undefined> {
		const row = await this.db.get<MediaGenerationJobRow>(
			"SELECT * FROM media_generation_jobs WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1",
			[idempotencyKey],
		);
		return row ? rowToJob(row) : undefined;
	}
}

function assertIdempotencyMatch(
	existing: MediaGenerationJob,
	input: MediaGenerationJobInput,
): void {
	const existingHash = hashRequest({
		mediaType: existing.mediaType,
		action: existing.action,
		prompt: existing.prompt,
		request: existing.request,
	});
	const inputHash = hashRequest({
		mediaType: input.mediaType,
		action: input.action,
		prompt: input.prompt,
		request: sanitizeJson(input.request ?? {}),
	});
	if (existingHash !== inputHash) {
		throw new Error(
			"Idempotency key conflict: the key is already bound to a different media request",
		);
	}
}

function hashRequest(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
