import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactVerifier } from "../agent/artifact-verifier.js";
import { KanbanDispatcher } from "../agent/kanban-dispatcher.js";
import { KanbanPlanner } from "../agent/kanban-planner.js";
import { OctopusOrchestrator } from "../agent/orchestrator.js";
import { RequirementResolver } from "../agent/requirement-resolver.js";
import { WorkflowManager } from "../agent/workflow-manager.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";
import { createWorkflowTools } from "../tools/workflow.js";

describe("Kanban Swarm artifact dependencies", () => {
	let db: DatabaseAdapter;
	let workflowManager: WorkflowManager;
	let verifier: ArtifactVerifier;
	let resolver: RequirementResolver;
	let mediaDir: string;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		workflowManager = new WorkflowManager(db);
		mediaDir = join(tmpdir(), `octopus-kanban-${Date.now()}`);
		mkdirSync(mediaDir, { recursive: true });
		verifier = new ArtifactVerifier(db, mediaDir);
		resolver = new RequirementResolver(workflowManager, verifier);
	});

	afterEach(async () => {
		if (existsSync(mediaDir))
			rmSync(mediaDir, { recursive: true, force: true });
		await db.close();
	});

	it("unlocks only the video whose specific image artifact is verified", async () => {
		const run = await workflowManager.createRun({ goal: "create videos" });
		const image1 = await workflowManager.createTask({
			runId: run.id,
			title: "Image 1",
			produces: [{ artifactKey: "image_video_1", artifactType: "image" }],
		});
		await workflowManager.createTask({
			runId: run.id,
			title: "Image 2",
			produces: [{ artifactKey: "image_video_2", artifactType: "image" }],
		});
		const video1 = await workflowManager.createTask({
			runId: run.id,
			title: "Video 1",
			status: "waiting_dependency",
			produces: [{ artifactKey: "video_1", artifactType: "video" }],
		});
		const video2 = await workflowManager.createTask({
			runId: run.id,
			title: "Video 2",
			status: "waiting_dependency",
			produces: [{ artifactKey: "video_2", artifactType: "video" }],
		});
		await workflowManager.createRequirement({
			runId: run.id,
			taskId: video1.id,
			requirementKey: "video_1:image",
			requirementType: "artifact",
			artifactKey: "image_video_1",
			artifactType: "image",
		});
		await workflowManager.createRequirement({
			runId: run.id,
			taskId: video2.id,
			requirementKey: "video_2:image",
			requirementType: "artifact",
			artifactKey: "image_video_2",
			artifactType: "image",
		});

		const imagePath = join(mediaDir, "image-1.png");
		writeFileSync(imagePath, "fake image");
		await workflowManager.recordArtifact({
			runId: run.id,
			taskId: image1.id,
			artifactType: "image",
			artifactKey: "image_video_1",
			path: imagePath,
		});

		const result = await resolver.evaluatePendingRequirements({
			runId: run.id,
		});

		expect(result.satisfied).toBe(1);
		expect(result.unlockedTasks).toBe(1);
		expect((await workflowManager.getTask(video1.id))?.status).toBe("ready");
		expect((await workflowManager.getTask(video2.id))?.status).toBe(
			"waiting_dependency",
		);
	});

	it("claims a ready task once and records a lease", async () => {
		const run = await workflowManager.createRun({ goal: "claim once" });
		const task = await workflowManager.createTask({
			runId: run.id,
			title: "Do work",
		});
		const dispatcher = new KanbanDispatcher(workflowManager, resolver, {
			maxConcurrentTasks: 2,
			maxConcurrentPerArm: 2,
			defaultAgentId: "agent-test",
			taskExecutor: async ({ task: claimedTask, leaseToken }) => {
				await workflowManager.heartbeatTaskLease({
					taskId: claimedTask.id,
					leaseToken,
				});
			},
		});

		const first = await dispatcher.tick();
		const second = await dispatcher.tick();
		const leases = await workflowManager.listTaskLeases(run.id);

		expect(first.claimed).toBe(1);
		expect(second.claimed).toBe(0);
		expect(leases).toHaveLength(1);
		expect((await workflowManager.getTask(task.id))?.status).toBe("running");
	});

	it("can pause and resume dispatcher claims without changing ready cards", async () => {
		const run = await workflowManager.createRun({ goal: "pause dispatcher" });
		const task = await workflowManager.createTask({
			runId: run.id,
			title: "Ready work",
		});
		const dispatcher = new KanbanDispatcher(workflowManager, resolver, {
			maxConcurrentTasks: 3,
			maxConcurrentPerArm: 1,
			defaultAgentId: "agent-test",
			taskExecutor: async () => undefined,
		});

		const pausedStatus = await dispatcher.setEnabled(false);
		const pausedTick = await dispatcher.tick();

		expect(pausedStatus.enabled).toBe(false);
		expect(pausedStatus.config.maxConcurrentTasks).toBe(3);
		expect(pausedStatus.availableSlots).toBe(3);
		expect(pausedTick.claimed).toBe(0);
		expect((await workflowManager.getTask(task.id))?.status).toBe("ready");

		const resumedStatus = await dispatcher.setEnabled(true);
		const resumedTick = await dispatcher.tick();

		expect(resumedStatus.enabled).toBe(true);
		expect(resumedTick.claimed).toBe(1);
		expect((await workflowManager.getTask(task.id))?.status).toBe("running");
	});

	it("persists dispatcher pause state across dispatcher instances", async () => {
		const dispatcher = new KanbanDispatcher(workflowManager, resolver);
		await dispatcher.setEnabled(false);

		const reloaded = new KanbanDispatcher(workflowManager, resolver, {
			enabled: true,
		});
		const status = await reloaded.loadPersistedState();

		expect(status.enabled).toBe(false);
	});

	it("creates a granular image-to-video plan from a natural goal without JSON", async () => {
		const planner = new KanbanPlanner(workflowManager);

		const result = await planner.planFromGoal({
			goal: "crea 2 videos con una imagen especifica para cada video",
		});
		const snapshot = await workflowManager.getRunSnapshot(result.run.id);

		expect(snapshot.tasks).toHaveLength(4);
		expect(snapshot.requirements).toHaveLength(2);
		expect(
			snapshot.requirements.map((requirement) => requirement.artifact_key),
		).toEqual(expect.arrayContaining(["image_video_1", "image_video_2"]));
	});

	it("creates a generic granular artifact plan outside image and video work", async () => {
		const planner = new KanbanPlanner(workflowManager);

		const result = await planner.planFromGoal({
			goal: "crea 3 informes, cada uno con su investigacion especifica",
		});
		const snapshot = await workflowManager.getRunSnapshot(result.run.id);

		expect(snapshot.tasks).toHaveLength(6);
		expect(snapshot.requirements).toHaveLength(3);
		expect(
			snapshot.requirements.map((requirement) => requirement.artifact_key),
		).toEqual(
			expect.arrayContaining([
				"investigacion_informes_1",
				"investigacion_informes_2",
				"investigacion_informes_3",
			]),
		);
		expect(
			snapshot.requirements.map((requirement) => requirement.artifact_type),
		).toEqual(expect.arrayContaining(["investigacion"]));
		expect(snapshot.dependencyEdges).toHaveLength(3);
		expect(snapshot.dependencyEdges.map((edge) => edge.artifactKey)).toEqual(
			expect.arrayContaining([
				"investigacion_informes_1",
				"investigacion_informes_2",
				"investigacion_informes_3",
			]),
		);
		expect(snapshot.dependencyEdges.every((edge) => edge.fromTaskId)).toBe(
			true,
		);
	});

	it("executes a Kanban decomposition without duplicating planned cards", async () => {
		const planner = new KanbanPlanner(workflowManager);
		const router = {
			chat: vi.fn().mockResolvedValue({
				content: "worker result",
				model: "test-model",
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				finishReason: "stop",
			}),
		};
		const orchestrator = new OctopusOrchestrator(
			router as never,
			{ list: () => [] } as never,
			{ execute: vi.fn() } as never,
			{
				id: "root-agent",
				name: "Root Agent",
				description: "test",
				systemPrompt: "test",
				model: "test-model",
			},
			{ maxWorkers: 2, workerConfig: { maxToolIterations: 1, timeoutMs: 5000 } },
			workflowManager,
		);
		orchestrator.setKanbanPlanner(planner, resolver);

		const decomposition = await orchestrator.decomposeViaKanban("crea 2 informes");
		const before = await workflowManager.getRunSnapshot(
			decomposition.kanbanPlanRunId as string,
		);
		expect(before.tasks).toHaveLength(2);

		for await (const _event of orchestrator.executeParallel(decomposition)) {
			// consume events
		}

		const after = await workflowManager.getRunSnapshot(
			decomposition.kanbanPlanRunId as string,
		);
		expect(after.tasks).toHaveLength(2);
		expect(after.run?.status).toBe("done");
	});

	it("requires min_count verified artifacts before satisfying artifact requirements", async () => {
		const run = await workflowManager.createRun({ goal: "analyze datasets" });
		const producer = await workflowManager.createTask({
			runId: run.id,
			title: "Prepare datasets",
			produces: [{ artifactKey: "dataset_analysis", artifactType: "dataset" }],
		});
		const consumer = await workflowManager.createTask({
			runId: run.id,
			title: "Analyze datasets",
			status: "waiting_dependency",
		});
		await workflowManager.createRequirement({
			runId: run.id,
			taskId: consumer.id,
			requirementKey: "analysis:datasets",
			requirementType: "artifact",
			artifactKey: "dataset_analysis",
			artifactType: "dataset",
			minCount: 2,
		});
		const dataset1Path = join(mediaDir, "dataset-1.csv");
		writeFileSync(dataset1Path, "id,value\n1,10");
		await workflowManager.recordArtifact({
			runId: run.id,
			taskId: producer.id,
			artifactType: "dataset",
			artifactKey: "dataset_analysis",
			path: dataset1Path,
			existsVerified: true,
		});

		const first = await resolver.evaluatePendingRequirements({ runId: run.id });

		expect(first.satisfied).toBe(0);
		expect((await workflowManager.getTask(consumer.id))?.status).toBe(
			"waiting_dependency",
		);

		const dataset2Path = join(mediaDir, "dataset-2.csv");
		writeFileSync(dataset2Path, "id,value\n2,20");
		await workflowManager.recordArtifact({
			runId: run.id,
			taskId: producer.id,
			artifactType: "dataset",
			artifactKey: "dataset_analysis",
			path: dataset2Path,
			existsVerified: true,
		});
		const second = await resolver.evaluatePendingRequirements({
			runId: run.id,
		});

		expect(second.satisfied).toBe(1);
		expect((await workflowManager.getTask(consumer.id))?.status).toBe("ready");
	});

	it("refuses to complete a task until declared produces artifacts are verified", async () => {
		const run = await workflowManager.createRun({ goal: "strict completion" });
		const task = await workflowManager.createTask({
			runId: run.id,
			title: "Create image",
			produces: [{ artifactKey: "image_video_1", artifactType: "image" }],
		});
		const claim = await workflowManager.claimTask({
			taskId: task.id,
			agentId: "agent-test",
		});
		const tools = createWorkflowTools(
			workflowManager,
			resolver,
			undefined,
			verifier,
		);
		const complete = tools.find(
			(tool) => tool.name === "workflow_complete_task",
		);
		const record = tools.find(
			(tool) => tool.name === "workflow_record_artifact",
		);
		if (!claim || !complete || !record) throw new Error("Missing test setup");

		const rejected = await complete.handler(
			{
				task_id: task.id,
				claim_token: claim.lease.lease_token,
				summary: "done",
			},
			{} as never,
		);
		expect(rejected.success).toBe(false);

		const imagePath = join(mediaDir, "verified-image.png");
		writeFileSync(imagePath, "fake image");
		await record.handler(
			{
				task_id: task.id,
				claim_token: claim.lease.lease_token,
				artifact_type: "image",
				artifact_key: "image_video_1",
				path: imagePath,
			},
			{} as never,
		);
		const accepted = await complete.handler(
			{
				task_id: task.id,
				claim_token: claim.lease.lease_token,
				summary: "done",
			},
			{} as never,
		);

		expect(accepted.success).toBe(true);
		expect((await workflowManager.getTask(task.id))?.status).toBe("done");
		expect((await workflowManager.getRun(run.id))?.status).toBe("done");
	});

	it("persists task comments and exposes them in run snapshots", async () => {
		const run = await workflowManager.createRun({ goal: "comment cards" });
		const task = await workflowManager.createTask({
			runId: run.id,
			title: "Review asset",
			status: "review",
		});

		const comment = await workflowManager.recordTaskComment({
			runId: run.id,
			taskId: task.id,
			authorAgentId: "octavio",
			commentType: "review_rejected",
			body: "Improve contrast before approval.",
		});
		await workflowManager.updateTaskStatus(task.id, "ready", {
			metadata: { reviewFeedback: comment.body },
		});
		const snapshot = await workflowManager.getRunSnapshot(run.id);

		expect(snapshot.comments).toHaveLength(1);
		expect(snapshot.comments[0]?.body).toBe(
			"Improve contrast before approval.",
		);
		expect(snapshot.comments[0]?.comment_type).toBe("review_rejected");
		expect((await workflowManager.getTask(task.id))?.status).toBe("ready");
	});

	it("returns detailed task context for blocked or waiting cards", async () => {
		const run = await workflowManager.createRun({ goal: "inspect context" });
		const task = await workflowManager.createTask({
			runId: run.id,
			title: "Create video",
			status: "waiting_dependency",
		});
		await workflowManager.createRequirement({
			runId: run.id,
			taskId: task.id,
			requirementKey: "video:image",
			requirementType: "artifact",
			artifactKey: "image_video_1",
			artifactType: "image",
		});
		await workflowManager.recordBlocker({
			runId: run.id,
			taskId: task.id,
			blockerType: "dependency",
			reason: "Image is missing",
		});
		await workflowManager.recordTaskComment({
			runId: run.id,
			taskId: task.id,
			body: "Waiting for exact image key.",
			commentType: "handoff",
		});

		const context = await workflowManager.getTaskContext(task.id);

		expect(context?.task.id).toBe(task.id);
		expect(context?.missingRequirements).toHaveLength(1);
		expect(context?.missingRequirements[0]?.artifact_key).toBe("image_video_1");
		expect(context?.blockers).toHaveLength(1);
		expect(context?.comments[0]?.body).toBe("Waiting for exact image key.");
		expect(context?.matchingArtifacts).toHaveLength(0);
	});

	it("supports manual requirement satisfy and reset", async () => {
		const run = await workflowManager.createRun({ goal: "manual gate" });
		const task = await workflowManager.createTask({
			runId: run.id,
			title: "Human approved card",
			status: "waiting_dependency",
		});
		const requirement = await workflowManager.createRequirement({
			runId: run.id,
			taskId: task.id,
			requirementKey: "human:approval",
			requirementType: "manual",
		});

		await workflowManager.markRequirementSatisfied(requirement.id, {});
		const unlocked = await resolver.unlockSatisfiedTasks(run.id);

		expect(unlocked).toBe(1);
		expect((await workflowManager.getTask(task.id))?.status).toBe("ready");
		expect((await workflowManager.getRequirement(requirement.id))?.status).toBe(
			"satisfied",
		);

		await workflowManager.markRequirementPending(
			requirement.id,
			"needs revision",
		);
		const reset = await workflowManager.getRequirement(requirement.id);

		expect(reset?.status).toBe("pending");
		expect(reset?.satisfied_at).toBeNull();
		expect(reset?.satisfied_by_artifact_id).toBeNull();
		expect(reset?.satisfied_by_task_id).toBeNull();
	});

	it("invalidates completed cards when a requirement is reset", async () => {
		const run = await workflowManager.createRun({ goal: "invalidate done" });
		const task = await workflowManager.createTask({
			runId: run.id,
			title: "Already approved card",
			status: "done",
		});
		const requirement = await workflowManager.createRequirement({
			runId: run.id,
			taskId: task.id,
			requirementKey: "manual:approval",
			requirementType: "manual",
		});
		await workflowManager.markRequirementSatisfied(requirement.id, {});
		expect(await workflowManager.completeRunIfAllTasksTerminal(run.id)).toBe(
			true,
		);
		expect((await workflowManager.getRun(run.id))?.status).toBe("done");
		await workflowManager.markRequirementPending(
			requirement.id,
			"approval revoked",
		);

		const invalidated =
			await workflowManager.invalidateTaskForPendingRequirement({
				taskId: task.id,
				requirementId: requirement.id,
				reason: "approval revoked",
			});

		expect(invalidated).toBe(true);
		expect((await workflowManager.getTask(task.id))?.status).toBe(
			"waiting_dependency",
		);
		const reopenedRun = await workflowManager.getRun(run.id);
		expect(reopenedRun?.status).toBe("running");
		expect(reopenedRun?.completed_at).toBeNull();
		const context = await workflowManager.getTaskContext(task.id);
		expect(context?.missingRequirements).toHaveLength(1);
		expect(context?.missingRequirements[0]?.id).toBe(requirement.id);
	});

	it("computes kanban run metrics from tasks, requirements, blockers, artifacts, and leases", async () => {
		const run = await workflowManager.createRun({ goal: "metrics" });
		const done = await workflowManager.createTask({
			runId: run.id,
			title: "Done card",
			status: "done",
		});
		const waiting = await workflowManager.createTask({
			runId: run.id,
			title: "Waiting card",
			status: "waiting_dependency",
		});
		const ready = await workflowManager.createTask({
			runId: run.id,
			title: "Ready card",
		});
		await workflowManager.createRequirement({
			runId: run.id,
			taskId: waiting.id,
			requirementKey: "needs:image",
			requirementType: "artifact",
			artifactKey: "image_1",
		});
		await workflowManager.recordBlocker({
			runId: run.id,
			taskId: waiting.id,
			blockerType: "manual",
			reason: "Needs user input",
		});
		const artifactPath = join(mediaDir, "done.txt");
		writeFileSync(artifactPath, "artifact");
		await workflowManager.recordArtifact({
			runId: run.id,
			taskId: done.id,
			artifactType: "text",
			artifactKey: "report_1",
			path: artifactPath,
			existsVerified: true,
		});
		await workflowManager.claimTask({
			taskId: ready.id,
			agentId: "agent-test",
		});

		const metrics = await workflowManager.getRunMetrics(run.id);

		expect(metrics.totalTasks).toBe(3);
		expect(metrics.byStatus.done).toBe(1);
		expect(metrics.byStatus.waiting_dependency).toBe(1);
		expect(metrics.blockedOpen).toBe(1);
		expect(metrics.requirementsPending).toBe(1);
		expect(metrics.verifiedArtifacts).toBe(1);
		expect(metrics.activeLeases).toBe(1);
		expect(metrics.completedTasks).toBe(1);
		expect(metrics.completionRatio).toBeCloseTo(1 / 3);
	});
});
