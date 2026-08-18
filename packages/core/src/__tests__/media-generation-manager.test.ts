import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaults } from "../config/defaults.js";
import { MediaGenerationManager } from "../multimedia/manager.js";
import { MediaGenerationStore } from "../multimedia/media-generation-store.js";
import type {
	MediaPersistence,
	VideoProviderAdapter,
} from "../multimedia/types.js";
import { VideoSubmissionError } from "../multimedia/types.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

const route = {
	provider: "vertex" as const,
	model: "veo-3.1-generate-001",
	transport: "video-lro" as const,
};

describe("MediaGenerationManager", () => {
	let db: DatabaseAdapter | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
	});

	it("persists a completed video and stores its Media URL", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const adapter = createAdapter();
		const media = createMedia();
		const usage = { recordMedia: vi.fn(async () => undefined) };
		const config = getDefaults();
		config.multimedia!.video.primary = route;
		config.multimedia!.video.fallbacks = [];
		const manager = new MediaGenerationManager({
			db,
			config,
			media,
			usage,
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});

		const created = await manager.createVideoJob({
			action: "text_to_video",
			prompt: "A durable video job",
		});
		const completed = await manager.waitForJob(created.id, { intervalMs: 10 });

		expect(completed.status).toBe("succeeded");
		expect(completed.operationName).toBe("operations/op-1");
		expect(completed.mediaUrls).toEqual(["/api/media/file/video.mp4"]);
		expect(adapter.submit).toHaveBeenCalledTimes(1);
		expect(media.save).toHaveBeenCalledTimes(1);
		expect(usage.recordMedia).toHaveBeenCalledWith(
			expect.objectContaining({
				id: expect.stringMatching(`^video:${created.id}:`),
				status: "succeeded",
				outputCount: 1,
				requestedDurationSeconds: 8,
				generatedDurationSeconds: 8,
			}),
		);
		await manager.stop();
	});

	it("resumes an accepted operation after restart without resubmitting it", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const store = new MediaGenerationStore(db);
		const seeded = await store.create({
			mediaType: "video",
			provider: route.provider,
			model: route.model,
			transport: route.transport,
			action: "text_to_video",
			prompt: "Resume me",
			request: {
				action: "text_to_video",
				prompt: "Resume me",
				routes: [route],
			},
			maxAttempts: 1,
		});
		await store.markSubmitting(seeded.id, route, 1);
		await store.markSubmitted(seeded.id, "operations/already-accepted");

		const adapter = createAdapter();
		const manager = new MediaGenerationManager({
			db,
			config: getDefaults(),
			media: createMedia(),
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});
		await manager.start();
		const completed = await manager.waitForJob(seeded.id, { intervalMs: 10 });

		expect(completed.status).toBe("succeeded");
		expect(adapter.submit).not.toHaveBeenCalled();
		expect(adapter.poll).toHaveBeenCalledWith(
			route,
			"operations/already-accepted",
			expect.objectContaining({ prompt: "Resume me" }),
			expect.any(AbortSignal),
		);
		await manager.stop();
	});

	it("falls back to the next route only when submission fails before acceptance", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const fallback = { ...route, model: "veo-3.1-fast-generate-001" };
		const adapter = createAdapter();
		vi.mocked(adapter.submit)
			.mockRejectedValueOnce(
				new VideoSubmissionError("submit 429: quota exhausted", true),
			)
			.mockResolvedValueOnce({ operationName: "operations/fallback" });
		const config = getDefaults();
		config.multimedia!.video.primary = route;
		config.multimedia!.video.fallbacks = [fallback];
		const manager = new MediaGenerationManager({
			db,
			config,
			media: createMedia(),
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});

		const fallbackRequest = {
			action: "text_to_video",
			prompt: "Fallback before acceptance",
		} as const;
		const created = await manager.createVideoJob(fallbackRequest, {
			idempotencyKey: "fallback-replay",
		});
		const completed = await manager.waitForJob(created.id, { intervalMs: 10 });
		const replayed = await manager.createVideoJob(fallbackRequest, {
			idempotencyKey: "fallback-replay",
		});

		expect(completed.status).toBe("succeeded");
		expect(completed.model).toBe(fallback.model);
		expect(adapter.submit).toHaveBeenCalledTimes(2);
		expect(replayed.id).toBe(created.id);
		await manager.stop();
	});

	it("retries an accepted failed job by resuming its operation instead of resubmitting", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const store = new MediaGenerationStore(db);
		const seeded = await store.create({
			mediaType: "video",
			provider: route.provider,
			model: route.model,
			transport: route.transport,
			action: "text_to_video",
			request: { action: "text_to_video", prompt: "Resume accepted", routes: [route] },
		});
		await store.markSubmitting(seeded.id, route, 1);
		await store.markSubmitted(seeded.id, "operations/accepted-before-error");
		await store.markFailed(seeded.id, "temporary download failure");
		const adapter = createAdapter();
		const manager = new MediaGenerationManager({
			db,
			config: getDefaults(),
			media: createMedia(),
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});

		await manager.retry(seeded.id);
		const completed = await manager.waitForJob(seeded.id, { intervalMs: 10 });

		expect(completed.status).toBe("succeeded");
		expect(adapter.submit).not.toHaveBeenCalled();
		expect(adapter.poll).toHaveBeenCalledWith(
			route,
			"operations/accepted-before-error",
			expect.any(Object),
			expect.any(AbortSignal),
		);
		await manager.stop();
	});

	it("deduplicates concurrent creates with the same idempotency key", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const store = new MediaGenerationStore(db);
		const input = {
			mediaType: "video" as const,
			provider: route.provider,
			model: route.model,
			transport: route.transport,
			request: { action: "text_to_video", prompt: "Exactly once" },
			idempotencyKey: "same-request",
		};

		const [first, second] = await Promise.all([
			store.create(input),
			store.create(input),
		]);

		expect(first.id).toBe(second.id);
		expect(await store.list()).toHaveLength(1);
	});

	it("rejects reuse of an idempotency key for different request content", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const store = new MediaGenerationStore(db);
		await store.create({
			mediaType: "video",
			provider: route.provider,
			model: route.model,
			transport: route.transport,
			prompt: "First request",
			request: { action: "text_to_video", prompt: "First request" },
			idempotencyKey: "bound-request",
		});

		await expect(
			store.create({
				mediaType: "video",
				provider: route.provider,
				model: route.model,
				transport: route.transport,
				prompt: "Different request",
				request: { action: "text_to_video", prompt: "Different request" },
				idempotencyKey: "bound-request",
			}),
		).rejects.toThrow("Idempotency key conflict");
	});

	it("leases a shared queued job so two managers submit it only once", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		let acceptSubmission: (() => void) | undefined;
		const submissionGate = new Promise<void>((resolve) => {
			acceptSubmission = resolve;
		});
		const adapter = createAdapter();
		vi.mocked(adapter.submit).mockImplementation(async () => {
			await submissionGate;
			return { operationName: "operations/leased" };
		});
		const config = getDefaults();
		config.multimedia!.video.primary = route;
		config.multimedia!.video.fallbacks = [];
		const firstManager = new MediaGenerationManager({
			db,
			config,
			media: createMedia(),
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});
		const secondManager = new MediaGenerationManager({
			db,
			config,
			media: createMedia(),
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});

		const [first, second] = await Promise.all([
			firstManager.createVideoJob(
				{ action: "text_to_video", prompt: "Lease exactly once" },
				{ idempotencyKey: "leased-request" },
			),
			secondManager.createVideoJob(
				{ action: "text_to_video", prompt: "Lease exactly once" },
				{ idempotencyKey: "leased-request" },
			),
		]);
		await waitUntil(() => vi.mocked(adapter.submit).mock.calls.length > 0);

		expect(first.id).toBe(second.id);
		expect(adapter.submit).toHaveBeenCalledTimes(1);
		acceptSubmission?.();
		const completed = await firstManager.waitForJob(first.id, { intervalMs: 10 });
		expect(completed.status).toBe("succeeded");
		await Promise.all([firstManager.stop(), secondManager.stop()]);
	});

	it("does not fallback or safely retry an ambiguous submission failure", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const adapter = createAdapter();
		vi.mocked(adapter.submit).mockRejectedValue(
			new VideoSubmissionError("fetch failed after request transmission", false),
		);
		const config = getDefaults();
		config.multimedia!.video.primary = route;
		config.multimedia!.video.fallbacks = [
			{ ...route, model: "veo-3.1-fast-generate-001" },
		];
		const manager = new MediaGenerationManager({
			db,
			config,
			media: createMedia(),
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});

		const created = await manager.createVideoJob({
			action: "text_to_video",
			prompt: "Do not duplicate me",
		});
		const failed = await manager.waitForJob(created.id, { intervalMs: 10 });

		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("remote acceptance state is unknown");
		expect(adapter.submit).toHaveBeenCalledTimes(1);
		await expect(manager.retry(created.id)).rejects.toThrow(
			"cannot be retried safely",
		);
		await manager.stop();
	});

	it("rejects signed media URLs before persisting a durable job", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const manager = new MediaGenerationManager({
			db,
			config: getDefaults(),
			media: createMedia(),
			adapters: [createAdapter()],
		});

		await expect(
			manager.createVideoJob({
				action: "image_to_video",
				prompt: "Signed input",
				imageUrl: "https://example.com/frame.png?X-Goog-Signature=secret",
			}),
		).rejects.toThrow("Import the file into the Media library first");
		expect(await manager.list()).toEqual([]);
	});

	it("does not resubmit a recovered submitting job with unknown acceptance", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const store = new MediaGenerationStore(db);
		const seeded = await store.create({
			mediaType: "video",
			provider: route.provider,
			model: route.model,
			transport: route.transport,
			request: { action: "text_to_video", prompt: "Unknown acceptance", routes: [route] },
		});
		await store.markSubmitting(seeded.id, route, 1);
		const adapter = createAdapter();
		const manager = new MediaGenerationManager({
			db,
			config: getDefaults(),
			media: createMedia(),
			adapters: [adapter],
		});

		await manager.start();
		const failed = await manager.waitForJob(seeded.id, { intervalMs: 10 });

		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("remote acceptance state is unknown");
		expect(adapter.submit).not.toHaveBeenCalled();
		await manager.stop();
	});

	it("restores a running job when remote cancellation is not confirmed", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const store = new MediaGenerationStore(db);
		const seeded = await store.create({
			mediaType: "video",
			provider: "gemini",
			model: "gemini-omni-flash-preview",
			transport: "interactions",
			request: { action: "text_to_video", prompt: "Keep running" },
		});
		const interactionRoute = {
			provider: "gemini" as const,
			model: "gemini-omni-flash-preview",
			transport: "interactions" as const,
		};
		await store.markSubmitting(seeded.id, interactionRoute, 1);
		await store.markSubmitted(seeded.id, "interaction-running");
		const adapter: VideoProviderAdapter = {
			provider: "gemini",
			transport: "interactions",
			submit: vi.fn(),
			poll: vi.fn(),
			download: vi.fn(),
			cancel: vi.fn(async () => false),
		};
		const manager = new MediaGenerationManager({
			db,
			config: getDefaults(),
			media: createMedia(),
			adapters: [adapter],
		});

		const result = await manager.cancel(seeded.id);

		expect(result.cancelledRemote).toBe(false);
		expect(result.job?.status).toBe("running");
		expect(adapter.cancel).toHaveBeenCalledOnce();
		await manager.stop();
	});

	it("commits a late Interactions cancellation confirmation as cancelled", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		let rejectPoll: ((reason: Error) => void) | undefined;
		const pollResult = new Promise<never>((_resolve, reject) => {
			rejectPoll = reject;
		});
		const interactionRoute = {
			provider: "gemini" as const,
			model: "gemini-omni-flash-preview",
			transport: "interactions" as const,
		};
		const adapter: VideoProviderAdapter = {
			provider: "gemini",
			transport: "interactions",
			submit: vi.fn(async () => ({ operationName: "interaction-late-cancel" })),
			poll: vi.fn(() => pollResult),
			download: vi.fn(),
			cancel: vi.fn(async () => {
				throw new Error("Interactions cancel timed out");
			}),
		};
		const config = getDefaults();
		config.multimedia!.video.primary = interactionRoute;
		config.multimedia!.video.fallbacks = [];
		const usage = { recordMedia: vi.fn(async () => undefined) };
		const manager = new MediaGenerationManager({
			db,
			config,
			media: createMedia(),
			usage,
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});
		const created = await manager.createVideoJob({
			action: "text_to_video",
			prompt: "Cancel after timeout",
		});
		await waitUntil(() => vi.mocked(adapter.poll).mock.calls.length > 0);

		const cancellation = await manager.cancel(created.id);
		expect(cancellation.job?.status).toBe("cancel_requested");
		rejectPoll?.(new Error("Interaction was cancelled"));
		const cancelled = await manager.waitForJob(created.id, { intervalMs: 10 });

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.error).toBeUndefined();
		expect(usage.recordMedia).toHaveBeenCalledWith(
			expect.objectContaining({ status: "cancelled" }),
		);
		await manager.stop();
	});

	it("does not let a poll failure beat an in-flight confirmed cancellation", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		let rejectPoll: ((reason: Error) => void) | undefined;
		let resolveCancel: ((cancelled: boolean) => void) | undefined;
		const pollResult = new Promise<never>((_resolve, reject) => {
			rejectPoll = reject;
		});
		const cancelResult = new Promise<boolean>((resolve) => {
			resolveCancel = resolve;
		});
		const interactionRoute = {
			provider: "gemini" as const,
			model: "gemini-omni-flash-preview",
			transport: "interactions" as const,
		};
		const adapter: VideoProviderAdapter = {
			provider: "gemini",
			transport: "interactions",
			submit: vi.fn(async () => ({ operationName: "interaction-cancel-race" })),
			poll: vi.fn(() => pollResult),
			download: vi.fn(),
			cancel: vi.fn(() => cancelResult),
		};
		const config = getDefaults();
		config.multimedia!.video.primary = interactionRoute;
		config.multimedia!.video.fallbacks = [];
		const manager = new MediaGenerationManager({
			db,
			config,
			media: createMedia(),
			adapters: [adapter],
			pollIntervalMs: 5,
			maxPollMs: 1000,
		});
		const created = await manager.createVideoJob({
			action: "text_to_video",
			prompt: "Cancellation race",
		});
		await waitUntil(() => vi.mocked(adapter.poll).mock.calls.length > 0);

		const cancellation = manager.cancel(created.id);
		await waitUntil(() => vi.mocked(adapter.cancel).mock.calls.length > 0);
		rejectPoll?.(new Error("poll transport disconnected"));
		const internal = manager as unknown as { active: Map<string, Promise<void>> };
		await waitUntil(() => !internal.active.has(created.id));
		expect((await manager.get(created.id))?.status).toBe("cancel_requested");

		resolveCancel?.(true);
		const result = await cancellation;
		expect(result.cancelledRemote).toBe(true);
		expect(result.job?.status).toBe("cancelled");
		await manager.stop();
	});

	it("allows retrying an Interactions cancellation after its deadline", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const store = new MediaGenerationStore(db);
		const interactionRoute = {
			provider: "gemini" as const,
			model: "gemini-omni-flash-preview",
			transport: "interactions" as const,
		};
		const seeded = await store.create({
			mediaType: "video",
			...interactionRoute,
			request: { action: "text_to_video", prompt: "Retry cancellation" },
		});
		await store.markSubmitting(seeded.id, interactionRoute, 1);
		await store.markSubmitted(seeded.id, "interaction-cancel-retry");
		const adapter: VideoProviderAdapter = {
			provider: "gemini",
			transport: "interactions",
			submit: vi.fn(),
			poll: vi.fn(),
			download: vi.fn(),
			cancel: vi
				.fn()
				.mockRejectedValueOnce(new Error("Interactions cancel timed out"))
				.mockResolvedValueOnce(true),
		};
		const manager = new MediaGenerationManager({
			db,
			config: getDefaults(),
			media: createMedia(),
			adapters: [adapter],
		});

		const first = await manager.cancel(seeded.id);
		const second = await manager.cancel(seeded.id);

		expect(first.job?.status).toBe("cancel_requested");
		expect(second.cancelledRemote).toBe(true);
		expect(second.job?.status).toBe("cancelled");
		expect(adapter.cancel).toHaveBeenCalledTimes(2);
		await manager.stop();
	});

	it("preserves long prompts in the durable executable request", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:", sqliteDriver: "sqljs" });
		await db.initialize();
		const adapter = createAdapter();
		const manager = new MediaGenerationManager({
			db,
			config: getDefaults(),
			media: createMedia(),
			adapters: [adapter],
		});
		const prompt = "cinematic detail ".repeat(400);

		const created = await manager.createVideoJob({
			action: "text_to_video",
			prompt,
			routes: [route],
		});
		await manager.waitForJob(created.id, { intervalMs: 10 });

		expect(adapter.submit).toHaveBeenCalledWith(
			route,
			expect.objectContaining({ prompt }),
			expect.any(AbortSignal),
		);
		await manager.stop();
	});
});

function createAdapter(): VideoProviderAdapter {
	return {
		provider: "vertex",
		transport: "video-lro",
		submit: vi.fn(async () => ({ operationName: "operations/op-1" })),
		poll: vi.fn(async () => ({
			done: true,
			progress: 1,
			outputs: [
				{
					buffer: Buffer.from("00000018667479706d703432", "hex"),
					mimeType: "video/mp4",
				},
			],
			result: { done: true },
		})),
		download: vi.fn(async (output) => ({
			buffer: output.buffer ?? Buffer.alloc(0),
			mimeType: output.mimeType,
		})),
	};
}

function createMedia(): MediaPersistence {
	return {
		save: vi.fn(async (_buffer, mimeType, _description, metadata) => ({
			id: "video",
			url: "/api/media/file/video.mp4",
			filename: "video.mp4",
			size: 12,
			mimetype: mimeType,
			metadata,
		})),
		resolve: vi.fn(async () => ({ buffer: Buffer.alloc(0), mimeType: "image/png" })),
	};
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > 2000) throw new Error("Timed out waiting for predicate");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
