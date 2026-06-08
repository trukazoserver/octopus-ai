import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseAdapter } from "../storage/database.js";
import type { DatabaseAdapter } from "../storage/database.js";
import { WorkflowManager } from "../agent/workflow-manager.js";
import { ArtifactVerifier } from "../agent/artifact-verifier.js";
import { SubtaskTracker } from "../agent/subtask-tracker.js";
import { ReconciliationService } from "../agent/reconciliation-service.js";

describe("Subtask Tracking & Artifact Verification", () => {
	let db: DatabaseAdapter;
	let workflowManager: WorkflowManager;
	let verifier: ArtifactVerifier;
	let tracker: SubtaskTracker;
	let reconciliation: ReconciliationService;
	let mediaDir: string;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		workflowManager = new WorkflowManager(db);

		mediaDir = join(tmpdir(), `octopus-test-media-${Date.now()}`);
		mkdirSync(mediaDir, { recursive: true });

		verifier = new ArtifactVerifier(db, mediaDir);
		tracker = new SubtaskTracker(workflowManager, verifier, db);
		reconciliation = new ReconciliationService(tracker, workflowManager);
	});

	afterEach(async () => {
		if (existsSync(mediaDir)) {
			rmSync(mediaDir, { recursive: true, force: true });
		}
		await db.close();
	});

	describe("SubtaskTracker lifecycle", () => {
		it("should create an inline run and subtasks", async () => {
			const runId = await tracker.beginInlineRun({
				conversationId: "conv-1",
				agentId: "agent-1",
				goal: "Generate timelapse images",
			});

			expect(runId).toBeTruthy();

			const taskId = await tracker.declareSubtask({
				runId,
				title: "Generate image 1",
				toolName: "save_media",
				expectedArtifacts: [{ artifactType: "image", description: "Keyframe 1", count: 1 }],
			});

			expect(taskId).toBeTruthy();

			await tracker.startSubtask(taskId);

			await tracker.completeSubtask(taskId, [
				{ artifactType: "image", url: "/api/media/file/abc-123.png", description: "Keyframe 1" },
			]);

			const tasks = await workflowManager.listRunTasks(runId);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].status).toBe("done");
			expect(tasks[0].title).toBe("Generate image 1");
		});

		it("should track failed subtasks", async () => {
			const runId = await tracker.beginInlineRun({
				conversationId: "conv-2",
				agentId: "agent-1",
				goal: "Generate video",
			});

			const taskId = await tracker.declareSubtask({
				runId,
				title: "Generate clip",
				toolName: "generate_video",
			});

			await tracker.startSubtask(taskId);
			await tracker.failSubtask(taskId, "API rate limit exceeded");

			const tasks = await workflowManager.listRunTasks(runId);
			expect(tasks[0].status).toBe("failed");
		});

		it("should interrupt an inline run and mark running tasks", async () => {
			const runId = await tracker.beginInlineRun({
				conversationId: "conv-3",
				agentId: "agent-1",
				goal: "Big task",
			});

			const t1 = await tracker.declareSubtask({ runId, title: "Task 1", toolName: "tool" });
			const t2 = await tracker.declareSubtask({ runId, title: "Task 2", toolName: "tool" });

			await tracker.startSubtask(t1);
			await tracker.completeSubtask(t1, [{ artifactType: "image", url: "/api/media/file/img.png" }]);

			await tracker.startSubtask(t2);

			await tracker.interruptInlineRun(runId, "timeout");

			const run = await workflowManager.getRun(runId);
			expect(run?.status).toBe("interrupted");

			const tasks = await workflowManager.listRunTasks(runId);
			const task2 = tasks.find((t) => t.id === t2);
			expect(task2?.status).toBe("interrupted");
		});
	});

	describe("ArtifactVerifier", () => {
		it("should verify existing media files", async () => {
			const runId = await tracker.beginInlineRun({
				conversationId: "conv-v1",
				agentId: "agent-1",
				goal: "Test verification",
			});

			const filename = "test-image-123.png";
			writeFileSync(join(mediaDir, filename), "fake image data");

			const taskId = await tracker.declareSubtask({ runId, title: "Save image", toolName: "save_media" });
			await tracker.startSubtask(taskId);
			await tracker.completeSubtask(taskId, [
				{ artifactType: "image", url: `/api/media/file/${filename}`, description: "Test image" },
			]);

			const results = await verifier.verifyRunArtifacts(runId);
			expect(results).toHaveLength(1);
			expect(results[0].exists).toBe(true);
		});

		it("should detect missing media files", async () => {
			const runId = await tracker.beginInlineRun({
				conversationId: "conv-v2",
				agentId: "agent-1",
				goal: "Test missing",
			});

			const taskId = await tracker.declareSubtask({ runId, title: "Save image", toolName: "save_media" });
			await tracker.startSubtask(taskId);
			await tracker.completeSubtask(taskId, [
				{ artifactType: "image", url: "/api/media/file/nonexistent-file.png", description: "Missing" },
			]);

			const results = await verifier.verifyRunArtifacts(runId);
			expect(results).toHaveLength(1);
			expect(results[0].exists).toBe(false);
			expect(results[0].error).toContain("not found");
		});

		it("should verify artifacts with file paths", async () => {
			const runId = await tracker.beginInlineRun({
				conversationId: "conv-v3",
				agentId: "agent-1",
				goal: "Path verification",
			});

			const testFile = join(mediaDir, "output.mp4");
			writeFileSync(testFile, "fake video data");

			const taskId = await tracker.declareSubtask({ runId, title: "Save video", toolName: "import_media_file" });
			await tracker.startSubtask(taskId);
			await tracker.completeSubtask(taskId, [
				{ artifactType: "video", path: testFile, description: "Test video" },
			]);

			const results = await verifier.verifyRunArtifacts(runId);
			expect(results[0].exists).toBe(true);
		});
	});

	describe("ReconciliationService", () => {
		it("should return null when no interrupted runs exist", async () => {
			const report = await reconciliation.reconcileOnResume({ conversationId: "no-such-conv" });
			expect(report).toBeNull();
		});

		it("should reconcile an interrupted run with verified artifacts", async () => {
			const convId = "conv-recon-1";

			// Create an interrupted run with completed subtasks
			const runId = await tracker.beginInlineRun({
				conversationId: convId,
				agentId: "agent-1",
				goal: "Timelapse generation",
			});

			// Task 1: images (all present)
			const imgTask = await tracker.declareSubtask({
				runId,
				title: "Generate 17 keyframe images",
				toolName: "save_media",
				expectedArtifacts: [{ artifactType: "image", description: "Keyframes", count: 17 }],
			});
			await tracker.startSubtask(imgTask);

			const imgArtifacts: Array<{ artifactType: string; url?: string; description?: string }> = [];
			for (let i = 1; i <= 17; i++) {
				const fname = `keyframe-${i}.png`;
				writeFileSync(join(mediaDir, fname), `image ${i}`);
				imgArtifacts.push({ artifactType: "image", url: `/api/media/file/${fname}`, description: `Keyframe ${i}` });
			}
			await tracker.completeSubtask(imgTask, imgArtifacts);

			// Task 2: clips (all present)
			const clipTask = await tracker.declareSubtask({
				runId,
				title: "Generate 16 video clips",
				toolName: "generate_video",
				expectedArtifacts: [{ artifactType: "video", description: "Clips", count: 16 }],
			});
			await tracker.startSubtask(clipTask);

			const clipArtifacts: Array<{ artifactType: string; url?: string; description?: string }> = [];
			for (let i = 1; i <= 16; i++) {
				const fname = `clip-${i}.mp4`;
				writeFileSync(join(mediaDir, fname), `video ${i}`);
				clipArtifacts.push({ artifactType: "video", url: `/api/media/file/${fname}`, description: `Clip ${i}` });
			}
			await tracker.completeSubtask(clipTask, clipArtifacts);

			// Task 3: final concat (NOT done - missing)
			const concatTask = await tracker.declareSubtask({
				runId,
				title: "Concatenate final video",
				toolName: "ffmpeg",
				expectedArtifacts: [{ artifactType: "video", description: "Final video", count: 1 }],
			});
			await tracker.startSubtask(concatTask);

			// Simulate interruption
			await tracker.interruptInlineRun(runId, "timeout during concatenation");

			// Run reconciliation
			const report = await reconciliation.reconcileOnResume({ conversationId: convId });

			expect(report).not.toBeNull();
			expect(report!.totalSubtasks).toBe(3);
			expect(report!.verifiedCompleted).toBeGreaterThanOrEqual(2);
			expect(report!.genuinelyMissing).toBeGreaterThanOrEqual(1);
			expect(report!.verifiedContext).toContain("VERIFIED RECOVERY STATE");
			expect(report!.verifiedContext).toContain("Generate 17 keyframe images");
			expect(report!.verifiedContext).toContain("Generate 16 video clips");
			expect(report!.verifiedContext).toContain("Do NOT regenerate confirmed artifacts");
		});

		it("should detect partial tasks where some artifacts are missing", async () => {
			const convId = "conv-recon-2";

			const runId = await tracker.beginInlineRun({
				conversationId: convId,
				agentId: "agent-1",
				goal: "Partial test",
			});

			const taskId = await tracker.declareSubtask({
				runId,
				title: "Generate 5 images",
				toolName: "save_media",
				expectedArtifacts: [{ artifactType: "image", description: "Images", count: 5 }],
			});
			await tracker.startSubtask(taskId);

			// Only create 3 of 5 files
			const artifacts: Array<{ artifactType: string; url?: string; description?: string }> = [];
			for (let i = 1; i <= 5; i++) {
				const fname = `partial-${i}.png`;
				if (i <= 3) writeFileSync(join(mediaDir, fname), `image ${i}`);
				artifacts.push({ artifactType: "image", url: `/api/media/file/${fname}`, description: `Image ${i}` });
			}
			await tracker.completeSubtask(taskId, artifacts);
			await tracker.interruptInlineRun(runId, "crash");

			const report = await reconciliation.reconcileOnResume({ conversationId: convId });
			expect(report).not.toBeNull();
			expect(report!.verifiedPartial).toBeGreaterThanOrEqual(1);
		});

		it("should detect tasks that completed but were never marked done", async () => {
			const convId = "conv-recon-3";

			const runId = await tracker.beginInlineRun({
				conversationId: convId,
				agentId: "agent-1",
				goal: "Unmarked test",
			});

			const taskId = await tracker.declareSubtask({
				runId,
				title: "Generate image",
				toolName: "save_media",
			});
			await tracker.startSubtask(taskId);

			// Create the file but DON'T call completeSubtask (simulates crash after tool execution)
			const fname = "unmarked-img.png";
			writeFileSync(join(mediaDir, fname), "image data");
			await workflowManager.recordArtifact({
				runId,
				taskId,
				artifactType: "image",
				url: `/api/media/file/${fname}`,
				existsVerified: false,
			});

			// Task is still "running", artifact exists
			await tracker.interruptInlineRun(runId, "crash before status update");

			const report = await reconciliation.reconcileOnResume({ conversationId: convId });
			expect(report).not.toBeNull();
			// Should detect the running task has an artifact and upgrade it
			expect(report!.subtaskDetails.some((d) => d.status === "done" || d.verifiedArtifactCount > 0)).toBe(true);
		});
	});
});
