import { createHash, randomUUID } from "node:crypto";
import type {
	MediaUsageSink,
	MediaUsageStatus,
} from "../ai/usage-store.js";
import type { OctopusConfig } from "../config/schema.js";
import type { DatabaseAdapter } from "../storage/database.js";
import type { MediaRoute } from "./catalog.js";
import {
	type MediaGenerationJob,
	type MediaGenerationJobInput,
	MediaGenerationStore,
} from "./media-generation-store.js";
import { AgentPlatformVideoAdapter } from "./providers/agent-platform.js";
import { GeminiApiVideoAdapter } from "./providers/gemini-api.js";
import { InteractionsVideoAdapter } from "./providers/interactions.js";
import { VideoSubmissionError } from "./types.js";
import type {
	MediaPersistence,
	VideoGenerationRequest,
	VideoOperationPollResult,
	VideoProviderAdapter,
} from "./types.js";

export interface MediaGenerationManagerOptions {
	db: DatabaseAdapter;
	config: OctopusConfig;
	media: MediaPersistence;
	adapters?: VideoProviderAdapter[];
	pollIntervalMs?: number;
	maxPollMs?: number;
	usage?: MediaUsageSink;
}

export interface CreateVideoJobOptions {
	idempotencyKey?: string;
	toolName?: string;
	agentId?: string;
	conversationId?: string;
	channelId?: string;
	runId?: string;
	workerId?: string;
	taskId?: string;
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export class MediaGenerationManager {
	readonly store: MediaGenerationStore;
	private config: OctopusConfig;
	private readonly media: MediaPersistence;
	private readonly adapters = new Map<string, VideoProviderAdapter>();
	private readonly active = new Map<string, Promise<void>>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly pollIntervalOverride?: number;
	private readonly maxPollOverride?: number;
	private readonly usage?: MediaUsageSink;
	private readonly leaseToken = randomUUID();
	private stopping = false;

	constructor(options: MediaGenerationManagerOptions) {
		this.store = new MediaGenerationStore(options.db);
		this.config = options.config;
		this.media = options.media;
		this.pollIntervalOverride = options.pollIntervalMs;
		this.maxPollOverride = options.maxPollMs;
		this.usage = options.usage;
		const adapters = options.adapters ?? this.defaultAdapters(options.config);
		for (const adapter of adapters) this.adapters.set(this.adapterKey(adapter), adapter);
	}

	async start(): Promise<void> {
		this.stopping = false;
		const launchAfterReconciliation: string[] = [];
		for (const job of await this.store.listResumable()) {
			if (job.status === "cancel_requested") {
				if (await this.recoverCancellation(job)) {
					launchAfterReconciliation.push(job.id);
				}
				continue;
			}
			launchAfterReconciliation.push(job.id);
		}
		await this.reconcileUsage();
		for (const id of launchAfterReconciliation) this.launch(id);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const activeIds = [...this.controllers.keys()];
		for (const controller of this.controllers.values()) controller.abort();
		await Promise.allSettled(this.active.values());
		await Promise.allSettled(
			activeIds.map((id) => this.store.releaseLease(id, this.leaseToken)),
		);
		this.controllers.clear();
		this.active.clear();
	}

	updateConfig(config: OctopusConfig): void {
		this.config = config;
		for (const adapter of this.adapters.values()) {
			if (adapter instanceof AgentPlatformVideoAdapter) {
				adapter.updateConfig(config.ai.providers.vertex);
			} else if (adapter instanceof GeminiApiVideoAdapter) {
				adapter.updateConfig(config.ai.providers.gemini);
			} else if (adapter instanceof InteractionsVideoAdapter) {
				adapter.updateConfig(config);
			}
		}
	}

	async createVideoJob(
		request: VideoGenerationRequest,
		options: CreateVideoJobOptions = {},
	): Promise<MediaGenerationJob> {
		if (this.config.multimedia?.video.enabled === false) {
			throw new Error("Video generation is disabled in Ajustes > Multimedia");
		}
		validateDurableRequestUrls(request);
		const routes = this.routesFor(request);
		const first = routes[0];
		if (!first) throw new Error("No video generation routes are configured");
		const persistedRequest = {
			...request,
			routes,
		} as unknown as Record<string, unknown>;
		const input: MediaGenerationJobInput = {
			mediaType: "video",
			provider: first.provider,
			model: first.model,
			transport: first.transport,
			toolName: options.toolName ?? "generate_video",
			action: request.action,
			prompt: request.prompt,
			request: persistedRequest,
			idempotencyKey: options.idempotencyKey,
			agentId: options.agentId,
			conversationId: options.conversationId,
			channelId: options.channelId,
			runId: options.runId,
			workerId: options.workerId,
			taskId: options.taskId,
			maxAttempts: routes.length,
		};
		const job = await this.store.create(input);
		if (!TERMINAL_STATUSES.has(job.status)) this.launch(job.id);
		return (await this.store.get(job.id)) ?? job;
	}

	async list(limit?: number): Promise<MediaGenerationJob[]> {
		return this.store.list(limit);
	}

	async get(id: string): Promise<MediaGenerationJob | undefined> {
		return this.store.get(id);
	}

	async retry(id: string): Promise<MediaGenerationJob | undefined> {
		await this.active.get(id)?.catch(() => undefined);
		const job = await this.store.get(id);
		if (!job) return undefined;
		if (job.status !== "failed" && job.status !== "cancelled") {
			throw new Error("Only failed or cancelled media jobs can be retried");
		}
		if (job.status === "failed" && job.operationName) {
			if (isConfirmedTerminalProviderFailure(job.error)) {
				await this.store.requeue(id);
			} else {
				await this.store.resumeAccepted(id);
			}
		} else {
			if (job.error?.includes("remote acceptance state is unknown")) {
				throw new Error(
					"This job cannot be retried safely because the previous provider acceptance state is unknown. Create a new job only after confirming the original operation was not accepted.",
				);
			}
			await this.store.requeue(id);
		}
		this.launch(id);
		return this.store.get(id);
	}

	async cancel(id: string): Promise<{
		job?: MediaGenerationJob;
		cancelledRemote: boolean;
		message: string;
	}> {
		const job = await this.store.get(id);
		if (!job) return { cancelledRemote: false, message: "Media job not found" };
		if (job.status === "queued") {
			const cancelled = await this.store.cancelQueued(id);
			if (cancelled) this.controllers.get(id)?.abort();
			return {
				job: await this.store.get(id),
				cancelledRemote: false,
				message: cancelled
					? "The local job was cancelled before submission."
					: "The job began submission before cancellation could be claimed. Wait for its remote operation state before trying again.",
			};
		}
		if (job.status === "submitting" && !job.operationName) {
			return {
				job,
				cancelledRemote: false,
				message: "Provider submission is in progress. Cancelling now could orphan a billable operation, so cancellation is blocked until acceptance is known.",
			};
		}
		if (
			(job.status !== "running" && job.status !== "cancel_requested") ||
			!job.operationName
		) {
			return { job, cancelledRemote: job.status === "cancelled", message: "The job is already terminal." };
		}
		const route = routeFromJob(job);
		const adapter = route ? this.adapterFor(route) : undefined;
		if (!route || !adapter?.cancel) {
			return {
				job,
				cancelledRemote: false,
				message: "This provider does not support remote cancellation. The accepted operation will continue and may still incur charges.",
			};
		}
		await this.store.requestCancel(id);
		let cancelled = false;
		try {
			cancelled = await adapter.cancel(route, job.operationName);
		} catch (error) {
			if (/interactions cancel (?:timed out|aborted)/i.test(errorMessage(error))) {
				return {
					job: await this.store.get(id),
					cancelledRemote: false,
					message:
						"Remote cancellation is still pending confirmation. The request can be retried and will also be reconciled on restart.",
				};
			}
			await this.store.restoreRunningAfterCancel(id);
			this.resumeMonitoringAfterCurrentTask(id);
			throw error;
		}
		if (cancelled) {
			this.controllers.get(id)?.abort();
			await this.store.markCancelled(id);
			const persistedJob = await this.store.get(id);
			if (persistedJob?.status === "cancelled") {
				await this.recordVideoUsage(
					persistedJob,
					route,
					requestFromJob(persistedJob),
					"cancelled",
					persistedJob.mediaUrls.length,
				);
			}
		} else {
			await this.store.restoreRunningAfterCancel(id);
			this.resumeMonitoringAfterCurrentTask(id);
		}
		const persistedJob = await this.store.get(id);
		const cancellationWon = cancelled && persistedJob?.status === "cancelled";
		return {
			job: persistedJob,
			cancelledRemote: cancellationWon,
			message: cancellationWon
				? "The remote interaction was cancelled."
				: cancelled && persistedJob?.status === "succeeded"
					? "The job completed before cancellation could be committed; the successful outputs were preserved."
				: "The provider did not confirm remote cancellation.",
		};
	}

	async waitForJob(
		id: string,
		options: {
			signal?: AbortSignal;
			onProgress?: (status: string) => void;
			intervalMs?: number;
		} = {},
	): Promise<MediaGenerationJob> {
		const intervalMs = Math.max(100, options.intervalMs ?? 1000);
		while (true) {
			const job = await this.store.get(id);
			if (!job) throw new Error(`Media job not found: ${id}`);
			options.onProgress?.(
				`Video job ${job.id}: ${job.status} (${Math.round(job.progress * 100)}%)`,
			);
			if (TERMINAL_STATUSES.has(job.status)) return job;
			if (options.signal?.aborted) return job;
			await delay(intervalMs, options.signal).catch(() => undefined);
		}
	}

	private launch(id: string): void {
		if (this.stopping || this.active.has(id)) return;
		const controller = new AbortController();
		this.controllers.set(id, controller);
		const task = this.run(id, controller.signal)
			.catch(async (error) => {
				if (this.stopping || controller.signal.aborted) return;
				const message = errorMessage(error);
				const current = await this.store.get(id);
				if (current && isRemoteCancellationConfirmation(message)) {
					await this.store.markCancelled(id);
					const cancelled = await this.store.get(id);
					const route = cancelled ? routeFromJob(cancelled) : undefined;
					if (cancelled && route) {
						await this.recordVideoUsage(
							cancelled,
							route,
							requestFromJob(cancelled),
							"cancelled",
							cancelled.mediaUrls.length,
						);
					}
					return;
				}
				if (current?.status === "cancel_requested") {
					return;
				}
				await this.store.markFailed(id, message, this.leaseToken);
				const failed = await this.store.get(id);
				const route = failed ? routeFromJob(failed) : undefined;
				if (
					failed &&
					route &&
					(failed.operationName ||
						message.includes("acceptance state is unknown"))
				) {
					await this.recordVideoUsage(
						failed,
						route,
						requestFromJob(failed),
						failed.operationName ? "failed" : "unknown",
						failed.mediaUrls.length,
					);
				}
			})
			.finally(() => {
				this.controllers.delete(id);
				this.active.delete(id);
			});
		this.active.set(id, task);
	}

	private resumeMonitoringAfterCurrentTask(id: string): void {
		const active = this.active.get(id);
		if (!active) {
			this.launch(id);
			return;
		}
		void active
			.finally(async () => {
				if (this.stopping) return;
				const job = await this.store.get(id);
				if (job?.status === "running" && job.operationName) this.launch(id);
			})
			.catch((error) => {
				console.error("[multimedia] failed to resume monitoring after cancel:", error);
			});
	}

	private async run(id: string, signal: AbortSignal): Promise<void> {
		const claimed = await this.store.claim(id, this.leaseToken, this.leaseMs());
		if (!claimed) return;
		let job = await this.requiredJob(id);
		const request = requestFromJob(job);
		if (job.status === "submitting" && !job.operationName) {
			await this.store.markFailed(
				job.id,
				"Process stopped during provider submission. The remote acceptance state is unknown, so the job was not resubmitted automatically.",
				this.leaseToken,
			);
			const route = routeFromJob(job);
			if (route) {
				await this.recordVideoUsage(
					job,
					route,
					request,
					"unknown",
					job.mediaUrls.length,
				);
			}
			return;
		}
		if (
			(job.status === "running" || job.status === "cancel_requested") &&
			job.operationName
		) {
			const route = routeFromJob(job);
			if (!route) throw new Error("Persisted media job route is incomplete");
			await this.monitorAccepted(job, route, request, signal);
			return;
		}

		const routes = this.routesFor(request);
		let lastError = "No route accepted the media job";
		for (let index = Math.max(0, job.attempt); index < routes.length; index++) {
			if (signal.aborted || this.stopping) return;
			const route = routes[index];
			if (!route) continue;
			const adapter = this.adapterFor(route);
			if (!adapter) {
				lastError = `No adapter is available for ${route.provider}/${route.transport}`;
				continue;
			}
			await this.store.markSubmitting(
				id,
				route,
				index + 1,
				this.leaseToken,
			);
			try {
				const submitted = await this.submitWithLeaseHeartbeat(
					job.id,
					adapter,
					route,
					request,
					signal,
				);
				await this.store.markSubmitted(
					id,
					submitted.operationName,
					undefined,
					this.leaseToken,
				);
				job = await this.requiredJob(id);
				if (job.operationName !== submitted.operationName) {
					throw new Error(
						"Lease ownership changed after provider acceptance; the operation could not be fenced safely",
					);
				}
				await this.monitorAccepted(job, route, request, signal);
				return;
			} catch (error) {
				lastError = errorMessage(error);
				if (signal.aborted || this.stopping) return;
				const accepted = (await this.store.get(id))?.operationName;
				const safeToFallback = isSafeToFallback(error);
				if (!accepted && !safeToFallback) {
					throw new Error(
						`Provider submission failed because the remote acceptance state is unknown and will not be retried automatically: ${errorMessage(error)}`,
					);
				}
				if (accepted || !safeToFallback || index === routes.length - 1) {
					throw error;
				}
			}
		}
		throw new Error(lastError);
	}

	private async monitorAccepted(
		job: MediaGenerationJob,
		route: MediaRoute,
		request: VideoGenerationRequest,
		signal: AbortSignal,
	): Promise<void> {
		if (!job.operationName) throw new Error("Remote operation name is missing");
		const adapter = this.adapterFor(route);
		if (!adapter) throw new Error(`No adapter is available for ${route.provider}/${route.transport}`);
		await this.recordVideoUsage(
			job,
			route,
			request,
			"accepted",
			job.mediaUrls.length,
		);
		const startedAt = Date.now();
		const maxPollMs = this.maxPollMs();
		while (!signal.aborted && !this.stopping) {
			if (
				!(await this.store.renewLease(
					job.id,
					this.leaseToken,
					this.leaseMs(),
				))
			) {
				throw new Error("Media job lease ownership was lost");
			}
			const latest = await this.requiredJob(job.id);
			if (latest.status === "cancelled") return;
			let poll: VideoOperationPollResult;
			try {
				poll = await this.withLeaseHeartbeat(
					job.id,
					signal,
					(heartbeatSignal) =>
						adapter.poll(
							route,
							job.operationName as string,
							request,
							heartbeatSignal,
						),
				);
			} catch (error) {
				const elapsed = Date.now() - startedAt;
				if (!isTransientPollError(error) || elapsed >= maxPollMs) throw error;
				await this.store.markProgress(
					job.id,
					Math.min(0.9, 0.1 + (elapsed / maxPollMs) * 0.8),
					this.leaseToken,
				);
				await delay(this.pollIntervalMs(), signal);
				continue;
			}
			if (poll.done) {
				let urls = [...latest.mediaUrls];
				const outputs = poll.outputs ?? [];
				for (let index = urls.length; index < outputs.length; index++) {
					const output = outputs[index];
					if (!output) continue;
					const downloaded = await this.withLeaseHeartbeat(
						job.id,
						signal,
						(heartbeatSignal) => adapter.download(output, heartbeatSignal),
					);
					const saved = await this.withLeaseHeartbeat(
						job.id,
						signal,
						() =>
							this.media.save(
								downloaded.buffer,
								downloaded.mimeType,
								request.prompt ?? `Video generated with ${route.model}`,
								{
									mediaGenerationJobId: job.id,
									provider: route.provider,
									model: route.model,
									transport: route.transport,
									action: request.action,
									sampleIndex: index,
								},
							),
					);
					urls = await this.store.appendMediaUrl(
						job.id,
						saved.url,
						this.leaseToken,
					);
					if (!urls.includes(saved.url)) {
						throw new Error("Media job lease ownership was lost while saving output");
					}
				}
				if (urls.length === 0) throw new Error("Provider completed without downloadable video outputs");
				await this.store.markCompleted(
					job.id,
					urls,
					poll.result ?? {},
					this.leaseToken,
				);
				const persisted = await this.requiredJob(job.id);
				if (persisted.status !== "succeeded") {
					if (persisted.status === "cancelled") {
						await this.recordVideoUsage(
							persisted,
							route,
							request,
							"cancelled",
							persisted.mediaUrls.length,
						);
						return;
					}
					throw new Error("Media job completion lost its fenced terminal transition");
				}
				await this.recordVideoUsage(
					persisted,
					route,
					request,
					"succeeded",
					urls.length,
				);
				return;
			}
			const elapsed = Date.now() - startedAt;
			if (elapsed >= maxPollMs) {
				throw new Error(`Video operation timed out after ${Math.round(maxPollMs / 1000)} seconds`);
			}
			await this.store.markProgress(
				job.id,
				poll.progress ?? Math.min(0.9, 0.1 + (elapsed / maxPollMs) * 0.8),
				this.leaseToken,
			);
			await delay(this.pollIntervalMs(), signal);
		}
	}

	private async recordVideoUsage(
		job: MediaGenerationJob,
		route: MediaRoute,
		request: VideoGenerationRequest,
		status: MediaUsageStatus,
		outputCount: number,
	): Promise<void> {
		if (!this.usage) return;
		const requestedOutputs = Math.max(1, request.numberOfVideos ?? 1);
		const effectiveDuration =
			request.durationSeconds ?? (request.action === "extend_video" ? 7 : 8);
		const requestedDurationSeconds = effectiveDuration * requestedOutputs;
		const generatedDurationSeconds = effectiveDuration * outputCount;
		const operationIdentity = job.operationName
			? createHash("sha256").update(job.operationName).digest("hex").slice(0, 24)
			: `unknown-${job.submissionSequence}`;
		await this.usage
			.recordMedia({
				id: `video:${job.id}:${operationIdentity}`,
				mediaType: "video",
				provider: route.provider,
				model: route.model,
				transport: route.transport,
				status,
				jobId: job.id,
				toolName: job.toolName ?? "generate_video",
				agentId: job.agentId,
				conversationId: job.conversationId,
				requestedOutputs,
				outputCount,
				requestedDurationSeconds,
				generatedDurationSeconds,
				estimatedCost: job.estimatedCost,
				costSource:
					job.estimatedCost === undefined ? undefined : "media-generation-job",
			})
			.catch((error) => {
				console.error("[multimedia] failed to persist video usage:", error);
			});
	}

	private async reconcileUsage(): Promise<void> {
		if (!this.usage) return;
		for (const job of await this.store.listForUsageReconciliation()) {
			const route = routeFromJob(job);
			if (!route) continue;
			let status: MediaUsageStatus = "accepted";
			if (job.status === "succeeded") status = "succeeded";
			else if (job.status === "cancelled") status = "cancelled";
			else if (job.status === "failed") {
				status = job.operationName ? "failed" : "unknown";
			}
			await this.recordVideoUsage(
				job,
				route,
				requestFromJob(job),
				status,
				job.mediaUrls.length,
			);
		}
	}

	private async recoverCancellation(job: MediaGenerationJob): Promise<boolean> {
		const claimed = await this.store.claim(
			job.id,
			this.leaseToken,
			this.leaseMs(),
		);
		if (!claimed) return false;
		if (!job.operationName) {
			await this.store.markCancelled(job.id);
			const persisted = await this.store.get(job.id);
			const route = persisted ? routeFromJob(persisted) : undefined;
			if (persisted && route) {
				await this.recordVideoUsage(
					persisted,
					route,
					requestFromJob(persisted),
					"cancelled",
					persisted.mediaUrls.length,
				);
			}
			return false;
		}
		const route = routeFromJob(job);
		const adapter = route ? this.adapterFor(route) : undefined;
		if (route && adapter?.cancel) {
			const cancelled = await adapter.cancel(route, job.operationName).catch(() => false);
			if (cancelled) {
				await this.store.markCancelled(job.id);
				const persisted = await this.store.get(job.id);
				if (persisted?.status === "cancelled") {
					await this.recordVideoUsage(
						persisted,
						route,
						requestFromJob(persisted),
						"cancelled",
						persisted.mediaUrls.length,
					);
				}
				return false;
			}
		}
		return true;
	}

	private routesFor(request: VideoGenerationRequest): MediaRoute[] {
		const configured = request.routes?.length
			? request.routes
			: this.config.multimedia?.video
				? [
						this.config.multimedia.video.primary,
						...this.config.multimedia.video.fallbacks,
					]
				: [];
		return configured.filter(
			(route): route is MediaRoute =>
				Boolean(route?.provider && route.model && route.transport),
		);
	}

	private adapterFor(route: MediaRoute): VideoProviderAdapter | undefined {
		return this.adapters.get(`${route.provider}:${route.transport}`);
	}

	private adapterKey(adapter: VideoProviderAdapter): string {
		return `${adapter.provider}:${adapter.transport}`;
	}

	private defaultAdapters(config: OctopusConfig): VideoProviderAdapter[] {
		return [
			new AgentPlatformVideoAdapter(config.ai.providers.vertex, this.media),
			new GeminiApiVideoAdapter(config.ai.providers.gemini, this.media),
			new InteractionsVideoAdapter("gemini", config),
			new InteractionsVideoAdapter("vertex", config),
		];
	}

	private pollIntervalMs(): number {
		return Math.max(
			100,
			this.pollIntervalOverride ??
				this.config.multimedia?.video.pollIntervalMs ??
				5000,
		);
	}

	private maxPollMs(): number {
		return Math.max(
			1000,
			this.maxPollOverride ?? this.config.multimedia?.video.maxPollMs ?? 1_800_000,
		);
	}

	private leaseMs(): number {
		return Math.max(300_000, this.pollIntervalMs() * 4);
	}

	private async submitWithLeaseHeartbeat(
		jobId: string,
		adapter: VideoProviderAdapter,
		route: MediaRoute,
		request: VideoGenerationRequest,
		signal: AbortSignal,
	): Promise<{ operationName: string }> {
		return this.withLeaseHeartbeat(jobId, signal, (heartbeatSignal) =>
			adapter.submit(route, request, heartbeatSignal),
		);
	}

	private async withLeaseHeartbeat<T>(
		jobId: string,
		signal: AbortSignal,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		const combinedSignal = AbortSignal.any([signal, controller.signal]);
		let leaseLost = false;
		const timer = setInterval(() => {
			void this.store
				.renewLease(jobId, this.leaseToken, this.leaseMs())
				.then((renewed) => {
					if (!renewed) {
						leaseLost = true;
						controller.abort();
					}
				})
				.catch(() => {
					leaseLost = true;
					controller.abort();
				});
		}, Math.max(1000, Math.floor(this.leaseMs() / 3)));
		try {
			const result = await work(combinedSignal);
			const renewed = await this.store.renewLease(
				jobId,
				this.leaseToken,
				this.leaseMs(),
			);
			if (leaseLost || !renewed) {
				throw new Error("Media job lease ownership was lost during external I/O");
			}
			return result;
		} finally {
			clearInterval(timer);
		}
	}

	private async requiredJob(id: string): Promise<MediaGenerationJob> {
		const job = await this.store.get(id);
		if (!job) throw new Error(`Media job not found: ${id}`);
		return job;
	}
}

function requestFromJob(job: MediaGenerationJob): VideoGenerationRequest {
	const request = job.request as unknown as VideoGenerationRequest;
	if (!request.action) throw new Error("Persisted video request is incomplete");
	return request;
}

function routeFromJob(job: MediaGenerationJob): MediaRoute | undefined {
	if (!job.model || !job.transport) return undefined;
	if (job.provider !== "openai" && job.provider !== "gemini" && job.provider !== "vertex") {
		return undefined;
	}
	if (
		job.transport !== "openai-images" &&
		job.transport !== "generate-content" &&
		job.transport !== "interactions" &&
		job.transport !== "video-lro"
	) {
		return undefined;
	}
	return {
		provider: job.provider,
		model: job.model,
		transport: job.transport,
	};
}

function isSafeToFallback(error: unknown): boolean {
	if (error instanceof VideoSubmissionError) return error.safeToFallback;
	const message = errorMessage(error).toLowerCase();
	return (
		/auth|credential|api key|projectid|required|unsupported|no adapter|access token request/.test(
			message,
		)
	);
}

function isTransientPollError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	return (
		/\b429\b|\b5\d\d\b|fetch failed|network|timeout|temporar|unavailable/.test(
			message,
		) && !/operation failed|cancelled|completed without/.test(message)
	);
}

function isConfirmedTerminalProviderFailure(error: string | undefined): boolean {
	return /operation failed|interaction (?:failed|incomplete|was cancelled)|completed without generated/i.test(
		error ?? "",
	);
}

function validateDurableRequestUrls(request: VideoGenerationRequest): void {
	const urls = [
		request.imageUrl,
		request.lastFrameUrl,
		request.videoUrl,
		...(request.referenceImages ?? []),
	].filter((value): value is string => Boolean(value));
	for (const value of urls) {
		if (!/^https?:\/\//i.test(value)) continue;
		const parsed = new URL(value);
		if (parsed.search || parsed.username || parsed.password) {
			throw new Error(
				"Signed or credential-bearing HTTP media URLs cannot be persisted in durable jobs. Import the file into the Media library first and use its /api/media/file/ URL.",
			);
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRemoteCancellationConfirmation(message: string): boolean {
	return /interaction (?:was )?cancelled|remote interaction (?:was )?cancelled/i.test(
		message,
	);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}
