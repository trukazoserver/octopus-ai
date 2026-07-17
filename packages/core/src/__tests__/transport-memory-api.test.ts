import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanbanPlanner } from "../agent/kanban-planner.js";
import { RequirementResolver } from "../agent/requirement-resolver.js";
import { WorkflowManager } from "../agent/workflow-manager.js";
import { getDefaults } from "../config/defaults.js";
import { createDatabaseAdapter } from "../storage/database.js";
import { TransportServer } from "../transport/server.js";

type JsonObject = Record<string, unknown>;

let server: TransportServer | undefined;

afterEach(async () => {
	await server?.stop();
	server = undefined;
	vi.unstubAllEnvs();
});

function serverBaseUrl(instance: TransportServer): string {
	const holder = instance as unknown as { httpServer: Server | null };
	const address = holder.httpServer?.address();
	if (!address || typeof address === "string") {
		throw new Error("TransportServer did not expose a TCP address");
	}
	return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function startServer(
	memoryOrchestrator: JsonObject,
	extraSystemContext: JsonObject = {},
	host = "127.0.0.1",
): Promise<string> {
	server = new TransportServer({ port: 0, host });
	server.setSystemContext({
		config: getDefaults(),
		memoryOrchestrator,
		...extraSystemContext,
	});
	await server.start();
	return serverBaseUrl(server);
}

async function getJson(
	url: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: JsonObject }> {
	const response = await fetch(url, { headers });
	return {
		status: response.status,
		body: (await response.json()) as JsonObject,
	};
}

async function postJson(
	url: string,
	body: JsonObject,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: JsonObject }> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as JsonObject,
	};
}

describe("memory API endpoints", () => {
	it("rejects hostile browser origins without blocking local owner requests", async () => {
		const baseUrl = await startServer({});
		const hostile = await fetch(`${baseUrl}/api/status`, {
			headers: { Origin: "https://attacker.example" },
		});
		expect(hostile.status).toBe(403);
		const local = await fetch(`${baseUrl}/api/status`, {
			headers: { Origin: "http://localhost:3000" },
		});
		expect(local.status).toBe(200);
	});

	it("uses explicit admin access for learning dashboard operations", async () => {
		const learningEngine = {
			listInsights: vi.fn(async () => []),
			listExperiences: vi.fn(async () => []),
			addFeedback: vi.fn(async () => true),
			forgetInsight: vi.fn(async () => true),
		};
		const baseUrl = await startServer({}, { learningEngine });

		expect((await getJson(`${baseUrl}/api/learning/insights`)).status).toBe(200);
		expect((await getJson(`${baseUrl}/api/learning/experiences`)).status).toBe(
			200,
		);
		expect(
			(
				await postJson(`${baseUrl}/api/learning/feedback`, {
					experienceId: "experience-a",
					rating: "negative",
				})
			).status,
		).toBe(200);
		const deleted = await fetch(
			`${baseUrl}/api/learning/insights/insight-a`,
			{ method: "DELETE" },
		);
		expect(deleted.status).toBe(200);

		expect(learningEngine.listInsights).toHaveBeenCalledWith(
			{ kind: "admin" },
			expect.objectContaining({ limit: 50 }),
		);
		expect(learningEngine.listExperiences).toHaveBeenCalledWith(
			{ kind: "admin" },
			expect.objectContaining({ limit: 30 }),
		);
		expect(learningEngine.addFeedback).toHaveBeenCalledWith(
			{ kind: "admin" },
			expect.objectContaining({
				experienceId: "experience-a",
				rating: "negative",
			}),
		);
		expect(learningEngine.forgetInsight).toHaveBeenCalledWith(
			{ kind: "admin" },
			"insight-a",
		);
	});

	it("rejects invalid learning feedback instead of treating it as positive", async () => {
		const learningEngine = {
			addFeedback: vi.fn(async () => true),
		};
		const baseUrl = await startServer({}, { learningEngine });
		const response = await postJson(`${baseUrl}/api/learning/feedback`, {
			experienceId: "experience-a",
			rating: "invalid",
		});
		expect(response.status).toBe(400);
		expect(learningEngine.addFeedback).not.toHaveBeenCalled();
	});

	it("exposes cognitive memory metrics from the orchestrator", async () => {
		const snapshot = {
			totalMemories: 10,
			versionedEmbeddings: 8,
			fallbackEmbeddings: 2,
			annIndexedMemories: 8,
			annCoverage: 0.8,
			temporalClaims: 4,
			activeInsights: 6,
			invalidatedInsights: 1,
			operationsByStatus: { completed: 3 },
		};
		const memoryOrchestrator = {
			getMetricsSnapshot: vi.fn(async () => snapshot),
		};
		const baseUrl = await startServer({}, { memoryOrchestrator });
		const response = await getJson(`${baseUrl}/api/memory/metrics`);
		expect(response.status).toBe(200);
		expect(response.body).toEqual(snapshot);
		expect(memoryOrchestrator.getMetricsSnapshot).toHaveBeenCalledTimes(1);
	});

	it("previews and applies legacy vector payload migration", async () => {
		const report = { supported: true, mode: "preview", eligible: 2, migrated: 0 };
		const memoryOrchestrator = {
			migrateLegacyVectorPayloads: vi.fn(async () => report),
		};
		const baseUrl = await startServer({}, { memoryOrchestrator });
		const response = await postJson(
			`${baseUrl}/api/memory/vector-payloads/migrate`,
			{ mode: "preview", limit: 50 },
		);
		expect(response).toMatchObject({ status: 200, body: report });
		expect(memoryOrchestrator.migrateLegacyVectorPayloads).toHaveBeenCalledWith({
			mode: "preview",
			limit: 50,
			cursor: undefined,
			upperBoundId: undefined,
		});
		expect(
			(
				await postJson(`${baseUrl}/api/memory/vector-payloads/migrate`, {
					mode: "destroy",
				})
			).status,
		).toBe(400);
	});

	it("imports, lists, and executes persisted memory benchmarks", async () => {
		const memoryOrchestrator = {
			importMemoryBenchmark: vi.fn(async () => ({ id: "dataset-1", documentCount: 1, caseCount: 1 })),
			listMemoryBenchmarkDatasets: vi.fn(async () => [{ id: "dataset-1" }]),
			createMemoryBenchmarkRun: vi.fn(async () => ({ id: "run-1", metrics: { recallAtK: 1 } })),
			listMemoryBenchmarkRuns: vi.fn(async () => [{ id: "run-1", status: "completed" }]),
		};
		const baseUrl = await startServer({}, { memoryOrchestrator });
		const imported = await postJson(`${baseUrl}/api/memory/benchmarks/datasets`, {
			name: "Fixture",
			format: "longmemeval",
			sourceName: "fixture.json",
			source: [],
		});
		expect(imported.status).toBe(201);
		expect((await getJson(`${baseUrl}/api/memory/benchmarks/datasets`)).status).toBe(200);
		const run = await postJson(`${baseUrl}/api/memory/benchmarks/runs`, {
			datasetId: "dataset-1",
			k: 10,
			condition: "octopus-isolated",
		});
		expect(run).toMatchObject({ status: 201, body: { id: "run-1" } });
		expect(memoryOrchestrator.createMemoryBenchmarkRun).toHaveBeenCalledWith(
			"dataset-1",
			expect.objectContaining({ condition: "octopus-isolated" }),
		);
		expect((await getJson(`${baseUrl}/api/memory/benchmarks/runs`)).status).toBe(200);
	});

	it("manages resumable memory operations through administrative routes", async () => {
		const operation = {
			id: "operation-1",
			type: "embedding.reindex",
			status: "pending",
			request: { batchSize: 10 },
			progress: {},
			attemptCount: 0,
			leaseState: "none",
			resumable: true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		const memoryOrchestrator = {
			previewMemoryOperation: vi.fn(async () => ({ mode: "preview", scanned: 0 })),
			createMemoryOperation: vi
				.fn()
				.mockResolvedValueOnce({ operation, replayed: false })
				.mockResolvedValueOnce({ operation, replayed: true }),
			listMemoryOperations: vi.fn(async () => [operation]),
			getMemoryOperation: vi.fn(async () => operation),
			resumeMemoryOperation: vi.fn(async () => ({
				...operation,
				status: "completed",
				resumable: false,
			})),
			pauseMemoryOperation: vi.fn(async () => ({
				...operation,
				status: "paused",
				controlAction: "run",
				resumable: true,
			})),
			cancelMemoryOperation: vi.fn(async () => ({
				...operation,
				status: "cancelled",
				controlAction: "run",
				resumable: false,
			})),
		};
		const baseUrl = await startServer({}, { memoryOrchestrator });
		expect(
			(
				await postJson(`${baseUrl}/api/memory/operations/preview`, {
					type: "embedding.reindex",
					batchSize: 10,
				})
			).status,
		).toBe(200);
		expect(
			(
				await postJson(
					`${baseUrl}/api/memory/operations/operation-1/pause`,
					{},
				)
			).status,
		).toBe(200);
		expect(
			(
				await postJson(
					`${baseUrl}/api/memory/operations/operation-1/cancel`,
					{},
				)
			).status,
		).toBe(200);
		expect(memoryOrchestrator.pauseMemoryOperation).toHaveBeenCalledWith(
			"operation-1",
		);
		expect(memoryOrchestrator.cancelMemoryOperation).toHaveBeenCalledWith(
			"operation-1",
		);
		const create = await fetch(`${baseUrl}/api/memory/operations`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": "operation-key",
			},
			body: JSON.stringify({ type: "embedding.reindex", batchSize: 10 }),
		});
		expect(create.status).toBe(201);
		expect(create.headers.get("location")).toBe(
			"/api/memory/operations/operation-1",
		);
		const replay = await fetch(`${baseUrl}/api/memory/operations`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": "operation-key",
			},
			body: JSON.stringify({ type: "embedding.reindex", batchSize: 10 }),
		});
		expect(replay.status).toBe(200);
		expect(memoryOrchestrator.createMemoryOperation).toHaveBeenCalledWith(
			expect.objectContaining({ type: "embedding.reindex", batchSize: 10 }),
			"operation-key",
		);
		expect((await getJson(`${baseUrl}/api/memory/operations`)).status).toBe(200);
		expect(
			(await getJson(`${baseUrl}/api/memory/operations/operation-1`)).status,
		).toBe(200);
		expect(
			(
				await postJson(
					`${baseUrl}/api/memory/operations/operation-1/resume`,
					{},
				)
			).status,
		).toBe(200);
		expect(
			(
				await postJson(`${baseUrl}/api/memory/operations/preview`, {
					type: "embedding.reindex",
					batchSize: 0,
				})
			).status,
		).toBe(400);
	});

	it("rejects encoded traversal in dynamic tool names", async () => {
		const baseUrl = await startServer({});
		const response = await fetch(
			`${baseUrl}/api/tools/dynamic/..%2Fcredentials`,
		);
		expect(response.status).not.toBe(200);
	});

	it("lists and updates environment variables without exposing secret values", async () => {
		const now = new Date(0).toISOString();
		const safeSecret = {
			id: "env-1",
			key: "OPENAI_API_KEY",
			value: "••••••••",
			description: "OpenAI key",
			is_secret: 1,
			created_at: now,
			updated_at: now,
		};
		const envVarManager = {
			list: vi.fn(async () => [safeSecret]),
			get: vi.fn(async () => "real-secret"),
			set: vi.fn(async () => ({
				...safeSecret,
				value: "enc:v1:ciphertext",
			})),
			delete: vi.fn(),
		};
		const baseUrl = await startServer({}, { envVarManager });

		const listed = await getJson(`${baseUrl}/api/env`);
		const blocked = await getJson(`${baseUrl}/api/env?showSecrets=true`);
		const revealed = await getJson(`${baseUrl}/api/env/OPENAI_API_KEY`);
		const saved = await postJson(`${baseUrl}/api/env`, {
			key: "OPENAI_API_KEY",
			value: "real-secret",
			description: "OpenAI key",
			isSecret: true,
		});

		expect(listed.status).toBe(200);
		expect(listed.body).toEqual([safeSecret]);
		expect(blocked.status).toBe(403);
		expect(revealed.status).toBe(200);
		expect(revealed.body.value).toBe("real-secret");
		expect(saved.status).toBe(200);
		expect(saved.body.value).toBe("••••••••");
		expect(JSON.stringify(saved.body)).not.toContain("real-secret");
		expect(JSON.stringify(saved.body)).not.toContain("ciphertext");
		expect(envVarManager.set).toHaveBeenCalledWith(
			"OPENAI_API_KEY",
			"real-secret",
			{
				isSecret: true,
				description: "OpenAI key",
			},
		);
	});

	it("rejects invalid environment variable names before writing", async () => {
		const envVarManager = {
			list: vi.fn(async () => []),
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
		};
		const baseUrl = await startServer({}, { envVarManager });

		const response = await postJson(`${baseUrl}/api/env`, {
			key: "../BAD",
			value: "value",
		});

		expect(response.status).toBe(400);
		expect(envVarManager.set).not.toHaveBeenCalled();
	});

	it("keeps health and status public when an API key is configured", async () => {
		const config = getDefaults();
		config.security.memoryApiKey = "test-api-key";
		const baseUrl = await startServer({}, { config });

		const health = await getJson(`${baseUrl}/health`);
		const status = await getJson(`${baseUrl}/api/status`);

		expect(health.status).toBe(200);
		expect(status.status).toBe(200);
		expect(status.body.status).toBe("running");
	});

	it("requires the configured API key for non-memory sensitive endpoints", async () => {
		const config = getDefaults();
		config.security.memoryApiKey = "test-api-key";
		const baseUrl = await startServer({}, { config });

		const missing = await getJson(`${baseUrl}/api/config`);
		const wrong = await getJson(`${baseUrl}/api/config`, {
			Authorization: "Bearer wrong",
		});
		const allowed = await getJson(`${baseUrl}/api/config`, {
			"X-Octopus-Api-Key": "test-api-key",
		});

		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect(allowed.status).toBe(200);
		expect(allowed.body.version).toBe(1);
	});

	it("redacts secrets from the config API response", async () => {
		const config = getDefaults();
		config.security.memoryApiKey = "test-api-key";
		config.ai.providers.openai.apiKey = "sk-testSecretValue12345";
		config.ai.providers.openai.baseUrl =
			"https://url-user:url-password@example.com/v1";
		(config.ai.providers.openai as JsonObject).oauthAccessToken =
			"ya29.testSecretValue12345";
		const baseUrl = await startServer({}, { config });

		const response = await getJson(`${baseUrl}/api/config`, {
			"X-Octopus-Api-Key": "test-api-key",
		});
		const body = JSON.stringify(response.body);
		const security = response.body.security as JsonObject;
		const ai = response.body.ai as JsonObject;
		const providers = ai.providers as JsonObject;
		const openai = providers.openai as JsonObject;

		expect(response.status).toBe(200);
		expect(security.memoryApiKey).toBe("****");
		expect(openai.apiKey).toBe("****");
		expect(openai.oauthAccessToken).toBe("****");
		expect(body).not.toContain("test-api-key");
		expect(body).not.toContain("sk-testSecretValue12345");
		expect(body).not.toContain("ya29.testSecretValue12345");
		expect(body).not.toContain("url-user");
		expect(body).not.toContain("url-password");
	});

	it("returns active conversation execution for reconnect recovery", async () => {
		const activeExecution = {
			id: "exec-1",
			request_id: "req-1",
			conversation_id: "conv-1",
			agent_id: null,
			status: "running",
			current_status: "responding",
			activities: "[]",
			assistant_message_id: "msg-1",
			error: null,
			started_at: new Date(0).toISOString(),
			updated_at: new Date(0).toISOString(),
			completed_at: null,
		};
		const chatManager = {
			getActiveExecutionForConversation: vi.fn(async () => activeExecution),
			getLatestExecutionForConversation: vi.fn(),
		};
		const baseUrl = await startServer({}, { chatManager });

		const response = await getJson(
			`${baseUrl}/api/conversations/conv-1/execution`,
		);

		expect(response.status).toBe(200);
		expect(response.body.execution).toMatchObject({
			id: "exec-1",
			status: "running",
			assistant_message_id: "msg-1",
		});
		expect(
			chatManager.getLatestExecutionForConversation,
		).not.toHaveBeenCalled();
	});

	it("lists resumable workflows and exposes recovery actions", async () => {
		const workflowManager = {
			listRuns: vi.fn(async () => []),
			listResumableRuns: vi.fn(async () => [
				{ id: "wf-1", status: "interrupted", goal: "Resume me" },
			]),
			markStaleRunsInterrupted: vi.fn(async () => ({ runs: 1, tasks: 2 })),
			retryRun: vi.fn(async () => {}),
			cancelRun: vi.fn(async () => {}),
		};
		const baseUrl = await startServer({}, { workflowManager });

		const resumable = await getJson(
			`${baseUrl}/api/workflows?resumable=true&conversationId=conv-1&limit=5`,
		);
		const recovered = await postJson(`${baseUrl}/api/workflows/recover`, {});
		const retried = await postJson(`${baseUrl}/api/workflows/wf-1/retry`, {});
		const cancelled = await postJson(`${baseUrl}/api/workflows/wf-1/cancel`, {
			reason: "test",
		});

		expect(resumable.status).toBe(200);
		expect(Array.isArray(resumable.body)).toBe(true);
		expect(workflowManager.listResumableRuns).toHaveBeenCalledWith({
			conversationId: "conv-1",
			limit: 5,
			offset: 0,
		});
		expect(recovered.body).toEqual({ ok: true, runs: 1, tasks: 2 });
		expect(retried.body).toEqual({ ok: true, id: "wf-1", action: "retry" });
		expect(cancelled.body).toEqual({ ok: true, id: "wf-1", action: "cancel" });
		expect(workflowManager.retryRun).toHaveBeenCalledWith("wf-1");
		expect(workflowManager.cancelRun).toHaveBeenCalledWith("wf-1", "test");
	});

	it("exposes Kanban dispatcher status, tick, pause, and resume actions", async () => {
		const status = {
			enabled: true,
			ticking: false,
			activeTaskIds: [],
			activeCount: 0,
			availableSlots: 3,
			config: {
				limit: 3,
				leaseTtlMs: 60000,
				maxConcurrentTasks: 3,
				maxConcurrentPerArm: 1,
				defaultAgentId: "octavio",
			},
			lastTickAt: null,
			lastTickResult: null,
		};
		const tick = {
			expiredLeases: 1,
			requirementsEvaluated: 2,
			requirementsSatisfied: 1,
			unlockedTasks: 1,
			claimed: 1,
			skipped: 0,
		};
		const kanbanDispatcher = {
			getStatus: vi.fn(() => status),
			tick: vi.fn(async () => tick),
			setEnabled: vi.fn((enabled: boolean) => ({ ...status, enabled })),
		};
		const baseUrl = await startServer({}, { kanbanDispatcher });

		const listed = await getJson(`${baseUrl}/api/kanban/dispatcher/status`);
		const ticked = await postJson(`${baseUrl}/api/kanban/dispatcher/tick`, {});
		const paused = await postJson(`${baseUrl}/api/kanban/dispatcher/pause`, {});
		const resumed = await postJson(
			`${baseUrl}/api/kanban/dispatcher/resume`,
			{},
		);

		expect(listed.status).toBe(200);
		expect(listed.body.enabled).toBe(true);
		expect(ticked.body.claimed).toBe(1);
		expect(paused.body.enabled).toBe(false);
		expect(resumed.body.enabled).toBe(true);
		expect(kanbanDispatcher.setEnabled).toHaveBeenCalledWith(false);
		expect(kanbanDispatcher.setEnabled).toHaveBeenCalledWith(true);
	});

	it("exposes all known models for active providers", async () => {
		const baseUrl = await startServer(
			{},
			{
				router: {
					getAvailableProviders: () => ["zhipu"],
				},
				config: {
					ai: {
						providers: {
							zhipu: {
								models: ["glm-5.1"],
							},
						},
					},
				},
			},
		);

		const response = await getJson(`${baseUrl}/api/models`);

		expect(response.status).toBe(200);
		expect(response.body.providers[0].provider).toBe("zhipu");
		expect(response.body.providers[0].models).toEqual(
			expect.arrayContaining(["glm-5.1", "glm-4.7", "glm-4.6"]),
		);
	});

	it("creates Kanban plans through the planner API", async () => {
		const run = { id: "run-1", goal: "generic plan", status: "running" };
		const snapshot = {
			run,
			tasks: [{ id: "task-1", title: "Research", status: "ready" }],
			requirements: [],
			dependencyEdges: [],
		};
		const kanbanPlanner = {
			planFromGoal: vi.fn(async () => ({
				run,
				tasks: snapshot.tasks,
				plan: {},
			})),
			persistPlan: vi.fn(),
		};
		const workflowManager = {
			getRunSnapshot: vi.fn(async () => snapshot),
		};
		const requirementResolver = {
			evaluatePendingRequirements: vi.fn(async () => ({
				evaluated: 0,
				satisfied: 0,
				unlockedTasks: 0,
			})),
		};
		const baseUrl = await startServer(
			{},
			{ workflowManager, kanbanPlanner, requirementResolver },
		);

		const response = await postJson(`${baseUrl}/api/kanban/plan`, {
			goal: "crea 2 reportes con investigacion especifica",
			conversationId: "conv-1",
			rootAgentId: "octavio",
		});

		expect(response.status).toBe(201);
		expect(response.body.run).toEqual(run);
		expect(kanbanPlanner.planFromGoal).toHaveBeenCalledWith({
			goal: "crea 2 reportes con investigacion especifica",
			conversationId: "conv-1",
			rootAgentId: "octavio",
		});
		expect(
			requirementResolver.evaluatePendingRequirements,
		).toHaveBeenCalledWith({
			runId: "run-1",
		});
	});

	it("rejects invalid Kanban plan payloads with 400", async () => {
		const workflowManager = { getRunSnapshot: vi.fn() };
		const kanbanPlanner = { planFromGoal: vi.fn(), persistPlan: vi.fn() };
		const baseUrl = await startServer({}, { workflowManager, kanbanPlanner });

		const missingGoal = await postJson(`${baseUrl}/api/kanban/plan`, {});
		const badTasks = await postJson(`${baseUrl}/api/kanban/plan`, {
			goal: "valid goal",
			tasks: "not-an-array",
		});
		const longGoal = await postJson(`${baseUrl}/api/kanban/plan`, {
			goal: "x".repeat(4001),
		});

		expect(missingGoal.status).toBe(400);
		expect(missingGoal.body.error).toBe("goal is required");
		expect(badTasks.status).toBe(400);
		expect(badTasks.body.error).toBe("tasks must be an array when provided");
		expect(longGoal.status).toBe(400);
		expect(String(longGoal.body.error)).toContain("goal must be");
		expect(kanbanPlanner.planFromGoal).not.toHaveBeenCalled();
		expect(kanbanPlanner.persistPlan).not.toHaveBeenCalled();
	});

	it("creates a real generic Kanban Swarm plan over HTTP", async () => {
		const db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		try {
			const workflowManager = new WorkflowManager(db);
			const kanbanPlanner = new KanbanPlanner(workflowManager);
			const requirementResolver = new RequirementResolver(workflowManager);
			const baseUrl = await startServer(
				{},
				{ workflowManager, kanbanPlanner, requirementResolver },
			);

			const response = await postJson(`${baseUrl}/api/kanban/plan`, {
				goal: "crea 2 informes, cada uno con su investigacion especifica",
				rootAgentId: "octavio",
			});

			expect(response.status).toBe(201);
			expect(response.body.tasks as unknown[]).toHaveLength(4);
			expect(response.body.requirements as unknown[]).toHaveLength(2);
			expect(response.body.dependencyEdges as unknown[]).toHaveLength(2);
			expect(
				(response.body.requirements as Array<{ artifact_key: string }>).map(
					(requirement) => requirement.artifact_key,
				),
			).toEqual(
				expect.arrayContaining([
					"investigacion_informes_1",
					"investigacion_informes_2",
				]),
			);
		} finally {
			await db.close();
		}
	});

	it("exposes Kanban task context and manual requirement actions", async () => {
		const requirement = {
			id: "req-1",
			run_id: "run-1",
			task_id: "task-1",
			requirement_key: "manual:approval",
		};
		const context = {
			task: {
				id: "task-1",
				run_id: "run-1",
				title: "Review",
				status: "waiting_dependency",
			},
			missingRequirements: [requirement],
			requirements: [requirement],
			artifacts: [],
			matchingArtifacts: [],
			blockers: [],
			comments: [],
			leases: [],
		};
		const snapshot = { run: { id: "run-1" }, tasks: [context.task] };
		const workflowManager = {
			getTaskContext: vi.fn(async () => context),
			getRequirement: vi.fn(async () => requirement),
			markRequirementSatisfied: vi.fn(async () => {}),
			markRequirementPending: vi.fn(async () => {}),
			recordEvent: vi.fn(async () => {}),
			completeRunIfAllTasksTerminal: vi.fn(async () => false),
			invalidateTaskForPendingRequirement: vi.fn(async () => true),
			getRunSnapshot: vi.fn(async () => snapshot),
		};
		const requirementResolver = {
			unlockSatisfiedTasks: vi.fn(async () => 1),
		};
		const kanbanDispatcher = { tick: vi.fn(async () => ({ claimed: 0 })) };
		const baseUrl = await startServer(
			{},
			{ workflowManager, requirementResolver, kanbanDispatcher },
		);

		const loaded = await getJson(`${baseUrl}/api/kanban/tasks/task-1/context`);
		const satisfied = await postJson(
			`${baseUrl}/api/kanban/requirements/req-1/satisfy`,
			{},
		);
		const reset = await postJson(
			`${baseUrl}/api/kanban/requirements/req-1/reset`,
			{ reason: "needs revision" },
		);

		expect(loaded.status).toBe(200);
		expect(loaded.body.task).toEqual(context.task);
		expect(satisfied.status).toBe(200);
		expect(reset.status).toBe(200);
		expect(workflowManager.markRequirementSatisfied).toHaveBeenCalledWith(
			"req-1",
			{},
		);
		expect(workflowManager.markRequirementPending).toHaveBeenCalledWith(
			"req-1",
			"needs revision",
		);
		expect(
			workflowManager.invalidateTaskForPendingRequirement,
		).toHaveBeenCalledWith({
			taskId: "task-1",
			requirementId: "req-1",
			reason: "needs revision",
		});
		expect(kanbanDispatcher.tick).toHaveBeenCalledTimes(2);
	});

	it("rejects oversized Kanban comments and reasons", async () => {
		const task = { id: "task-1", run_id: "run-1", title: "Review" };
		const workflowManager = {
			getTask: vi.fn(async () => task),
			recordTaskComment: vi.fn(),
			recordBlocker: vi.fn(),
			updateTaskStatus: vi.fn(),
			getRunSnapshot: vi.fn(),
		};
		const baseUrl = await startServer({}, { workflowManager });

		const comment = await postJson(
			`${baseUrl}/api/kanban/tasks/task-1/comment`,
			{
				body: "x".repeat(4001),
			},
		);
		const block = await postJson(`${baseUrl}/api/kanban/tasks/task-1/block`, {
			reason: "x".repeat(4001),
		});

		expect(comment.status).toBe(400);
		expect(String(comment.body.error)).toContain("body must be");
		expect(block.status).toBe(400);
		expect(String(block.body.error)).toContain("reason must be");
		expect(workflowManager.recordTaskComment).not.toHaveBeenCalled();
		expect(workflowManager.recordBlocker).not.toHaveBeenCalled();
	});

	it("exposes agent message inbox, send, and read actions", async () => {
		const message = {
			id: "msg-1",
			run_id: null,
			from_agent_id: "agent-main",
			to_agent_id: "agent-qa",
			task_id: null,
			message_type: "question",
			content: "Can you verify this?",
			created_at: "2026-01-01T00:00:00.000Z",
			read_at: null,
			metadata: null,
		};
		const agentManager = {
			listInbox: vi.fn(async () => [message]),
			sendMessage: vi.fn(async () => message),
			markMessagesRead: vi.fn(async () => 1),
		};
		const baseUrl = await startServer({}, { agentManager });

		const inbox = await getJson(
			`${baseUrl}/api/agents/agent-qa/messages?unreadOnly=true&limit=5`,
		);
		const sent = await postJson(`${baseUrl}/api/agents/messages`, {
			fromAgentId: "agent-main",
			toAgentId: "agent-qa",
			messageType: "question",
			content: "Can you verify this?",
		});
		const read = await postJson(
			`${baseUrl}/api/agents/agent-qa/messages/read`,
			{ messageIds: ["msg-1"] },
		);

		expect(inbox.status).toBe(200);
		expect(sent.status).toBe(201);
		expect(read.body).toEqual({ ok: true, updated: 1 });
		expect(agentManager.listInbox).toHaveBeenCalledWith({
			agentId: "agent-qa",
			runId: undefined,
			includeBroadcasts: true,
			unreadOnly: true,
			limit: 5,
		});
		expect(agentManager.sendMessage).toHaveBeenCalledWith({
			fromAgentId: "agent-main",
			toAgentId: "agent-qa",
			runId: undefined,
			taskId: undefined,
			messageType: "question",
			content: "Can you verify this?",
			metadata: undefined,
		});
		expect(agentManager.markMessagesRead).toHaveBeenCalledWith("agent-qa", [
			"msg-1",
		]);
	});

	it("returns workflow snapshot details and 404 for missing workflow", async () => {
		const workflowManager = {
			listRuns: vi.fn(async () => []),
			getRunSnapshot: vi.fn(async (id: string) =>
				id === "missing"
					? { run: null, tasks: [], events: [], artifacts: [] }
					: {
							run: { id, status: "done", goal: "Complete" },
							tasks: [],
							events: [],
							artifacts: [],
						},
			),
		};
		const baseUrl = await startServer({}, { workflowManager });

		const found = await getJson(`${baseUrl}/api/workflows/wf-2`);
		const missing = await getJson(`${baseUrl}/api/workflows/missing`);

		expect(found.status).toBe(200);
		expect((found.body.run as JsonObject).id).toBe("wf-2");
		expect(missing.status).toBe(404);
	});

	it("uses OCTOPUS_API_KEY as a fallback for sensitive endpoint auth", async () => {
		vi.stubEnv("OCTOPUS_API_KEY", "fallback-api-key");
		const baseUrl = await startServer({});

		const missing = await getJson(`${baseUrl}/api/tasks`);
		const allowed = await getJson(`${baseUrl}/api/tasks`, {
			Authorization: "Bearer fallback-api-key",
		});

		expect(missing.status).toBe(401);
		expect(allowed.status).not.toBe(401);
	});

	it("requires an API key for sensitive endpoints on non-loopback hosts", async () => {
		const baseUrl = await startServer({}, {}, "0.0.0.0");

		const response = await getJson(`${baseUrl}/api/config`);

		expect(response.status).toBe(403);
		expect(response.body.error).toContain("OCTOPUS_API_KEY");
	});

	it("requires the configured memory API key before invoking handlers", async () => {
		const config = getDefaults();
		config.security.memoryApiKey = "test-memory-key";
		const backfillAdvancedMemory = vi.fn(async () => ({ scanned: 1 }));
		const baseUrl = await startServer({ backfillAdvancedMemory }, { config });

		const missing = await postJson(`${baseUrl}/api/memory/backfill`, {
			limit: 1,
		});
		const wrong = await postJson(
			`${baseUrl}/api/memory/backfill`,
			{ limit: 1 },
			{ "X-Octopus-Api-Key": "wrong" },
		);
		const allowed = await postJson(
			`${baseUrl}/api/memory/backfill`,
			{ limit: 1 },
			{ Authorization: "Bearer test-memory-key" },
		);

		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect(allowed.status).toBe(200);
		expect(backfillAdvancedMemory).toHaveBeenCalledTimes(1);
	});

	it("blocks direct source reads when memory permissions deny access", async () => {
		const getSources = vi.fn(async () => []);
		const baseUrl = await startServer({
			filterReadableMemoryIds: vi.fn(async () => []),
			getSources,
		});

		const response = await getJson(`${baseUrl}/api/memory/sources?id=private`);

		expect(response.status).toBe(403);
		expect(response.body.error).toBe("Memory is not accessible");
		expect(getSources).not.toHaveBeenCalled();
	});

	it("requires an id and redacts audit snapshots", async () => {
		const baseUrl = await startServer({
			filterReadableMemoryIds: vi.fn(async (ids: string[]) => ids),
			listAudit: vi.fn(async () => [
				{
					id: "audit-1",
					actorId: "agent",
					action: "write",
					memoryId: "memory-1",
					before: { id: "memory-1", content: "secret before" },
					after: {
						id: "memory-1",
						type: "semantic",
						content: "secret after",
						confidence: 0.9,
						status: "active",
					},
					createdAt: new Date(0),
				},
			]),
		});

		const missing = await getJson(`${baseUrl}/api/memory/audit`);
		const redacted = await getJson(`${baseUrl}/api/memory/audit?id=memory-1`);

		expect(missing.status).toBe(400);
		expect(missing.body.error).toBe("Missing memory id");
		expect(redacted.status).toBe(200);
		expect(JSON.stringify(redacted.body)).not.toContain("secret");
		expect(redacted.body.audit).toMatchObject([
			{
				before: { id: "memory-1", redacted: true },
				after: {
					id: "memory-1",
					type: "semantic",
					confidence: 0.9,
					status: "active",
					redacted: true,
				},
			},
		]);
	});

	it("reports audit log integrity without exposing audit payloads", async () => {
		const verifyAuditIntegrity = vi.fn(async () => ({
			valid: true,
			generatedAt: new Date(0),
			audit: {
				table: "memory_audit_logs",
				valid: true,
				checked: 2,
				legacy: 0,
				missingHash: 0,
				mismatches: [],
				chainBreaks: [],
			},
			actions: {
				table: "memory_action_logs",
				valid: true,
				checked: 1,
				legacy: 0,
				missingHash: 0,
				mismatches: [],
				chainBreaks: [],
			},
		}));
		const baseUrl = await startServer({ verifyAuditIntegrity });

		const response = await getJson(`${baseUrl}/api/memory/audit/integrity`);

		expect(response.status).toBe(200);
		expect(response.body.report).toMatchObject({
			valid: true,
			audit: { checked: 2 },
			actions: { checked: 1 },
		});
		expect(JSON.stringify(response.body)).not.toContain("secret");
		expect(verifyAuditIntegrity).toHaveBeenCalledOnce();
	});

	it("filters verify requests to readable memory ids", async () => {
		const verify = vi.fn(async (ids: string[]) =>
			ids.map((id) => ({ memoryId: id, verification: { status: "verified" } })),
		);
		const explain = vi.fn(async (ids: string[]) =>
			ids.map((id) => ({
				memoryId: id,
				content: "redacted in test fixture",
				type: "semantic",
				confidence: 0.9,
				sourceTrust: "system",
				evidence: [],
				usage: [],
			})),
		);
		const baseUrl = await startServer({
			filterReadableMemoryIds: vi.fn(async (ids: string[]) =>
				ids.filter((id) => id === "allowed"),
			),
			verify,
			explain,
		});

		const response = await postJson(`${baseUrl}/api/memory/verify`, {
			memoryIds: ["allowed", "denied"],
		});

		expect(response.status).toBe(200);
		expect(response.body.memoryIds).toEqual(["allowed"]);
		expect(verify).toHaveBeenCalledWith(["allowed"]);
		expect(explain).toHaveBeenCalledWith(["allowed"]);
	});

	it("supports entity graph lookup and bounded graph traversal", async () => {
		const getGraphByEntity = vi.fn(async () => ({
			memoryIds: ["memory-1"],
			nodes: [],
			relations: [],
			paths: [],
		}));
		const traverseGraph = vi.fn(async () => ({
			memoryIds: ["memory-1", "memory-2"],
			nodes: [],
			relations: [],
			paths: [
				{
					fromMemoryId: "memory-1",
					toMemoryId: "memory-2",
					nodeIds: ["node-1"],
					relationIds: [],
					depth: 1,
					explanation: "Reached readable memory through graph node node-1.",
				},
			],
		}));
		const baseUrl = await startServer({
			getGraphByEntity,
			traverseGraph,
		});

		const byEntity = await getJson(
			`${baseUrl}/api/memory/graph?entity=Acme&agentRole=agent-writer&maxDepth=1&relationTypes=prefers,invalid`,
		);
		const traversed = await postJson(`${baseUrl}/api/memory/graph/traverse`, {
			memoryIds: ["memory-1"],
			agentRole: "agent-writer",
			maxDepth: 1,
			maxNodes: 10,
			relationTypes: ["prefers", "invalid"],
		});

		expect(byEntity.status).toBe(200);
		expect(byEntity.body.graph).toMatchObject({ memoryIds: ["memory-1"] });
		expect(getGraphByEntity).toHaveBeenCalledWith(
			"Acme",
			expect.objectContaining({ agentRole: "agent-writer" }),
			expect.objectContaining({ maxDepth: 1, relationTypes: ["prefers"] }),
		);
		expect(traversed.status).toBe(200);
		expect(traversed.body.graph).toMatchObject({
			memoryIds: ["memory-1", "memory-2"],
		});
		expect(traverseGraph).toHaveBeenCalledWith(
			["memory-1"],
			expect.objectContaining({ agentRole: "agent-writer" }),
			expect.objectContaining({
				maxDepth: 1,
				maxNodes: 10,
				relationTypes: ["prefers"],
			}),
		);
	});

	it("rejects invalid memory feedback types before mutating state", async () => {
		const applyFeedback = vi.fn();
		const baseUrl = await startServer({ applyFeedback });

		const response = await postJson(`${baseUrl}/api/memory/feedback`, {
			memoryId: "memory-1",
			feedbackType: "invalid",
		});

		expect(response.status).toBe(400);
		expect(response.body.error).toBe("Invalid 'feedbackType'");
		expect(applyFeedback).not.toHaveBeenCalled();
	});

	it("retrieves assembled memory context using goal and maxTokens", async () => {
		const read = vi.fn();
		const assemble = vi.fn(async () => ({
			memoryPack: {
				taskObjective: "investigate advanced memory",
				memories: [],
			},
			proactiveNotices: [],
			proactiveMemoryIds: [],
			degradedSections: [],
			mandatorySectionsPreserved: [],
			budgetExceeded: false,
		}));
		const baseUrl = await startServer(
			{ read },
			{ contextAssembler: { assemble } },
		);

		const response = await postJson(`${baseUrl}/api/memory/context/retrieve`, {
			goal: "investigate advanced memory",
			maxTokens: 1234,
			tenantId: "tenant-a",
			userId: "user-a",
			projectId: "project-a",
			agentId: "qa-agent",
			includeSources: true,
			includeGraph: false,
			userConfirmed: true,
			trackUsage: true,
		});

		expect(response.status).toBe(200);
		expect(response.body.goal).toBe("investigate advanced memory");
		expect(response.body.contextPack).toMatchObject({
			taskObjective: "investigate advanced memory",
		});
		expect(assemble).toHaveBeenCalledWith(
			expect.objectContaining({
				objective: "investigate advanced memory",
				budgetTokens: 1234,
				tenantId: "tenant-a",
				userId: "user-a",
				projectId: "project-a",
				agentRole: "qa-agent",
				includeSources: true,
				includeGraph: false,
				userConfirmed: true,
				trackUsage: true,
			}),
		);
		expect(read).not.toHaveBeenCalled();
	});

	it("falls back to memory orchestrator for context retrieval", async () => {
		const read = vi.fn(async () => ({
			taskObjective: "retrieve fallback",
			memories: [],
		}));
		const baseUrl = await startServer({ read });

		const response = await postJson(`${baseUrl}/api/memory/context/retrieve`, {
			goal: "retrieve fallback",
			maxTokens: 777,
		});

		expect(response.status).toBe(200);
		expect(response.body.contextPack).toMatchObject({
			taskObjective: "retrieve fallback",
		});
		expect(read).toHaveBeenCalledWith(
			"retrieve fallback",
			expect.objectContaining({
				tenantId: "local",
				userId: "owner",
				includeSources: true,
				includeGraph: true,
				userConfirmed: false,
				trackUsage: false,
			}),
			777,
		);
	});

	it("validates missing goal for context retrieval", async () => {
		const read = vi.fn();
		const assemble = vi.fn();
		const baseUrl = await startServer(
			{ read },
			{ contextAssembler: { assemble } },
		);

		const response = await postJson(`${baseUrl}/api/memory/context/retrieve`, {
			query: "old field",
			maxTokens: 100,
		});

		expect(response.status).toBe(400);
		expect(response.body.error).toBe("Missing 'goal'");
		expect(read).not.toHaveBeenCalled();
		expect(assemble).not.toHaveBeenCalled();
	});

	it("redacts restricted context memories at the transport boundary", async () => {
		const assemble = vi.fn(async () => ({
			memoryPack: {
				memories: [
					{
						item: {
							id: "restricted-1",
							type: "semantic",
							content: "SECRET_CONTENT_DO_NOT_LEAK",
							importance: 0.9,
							accessCount: 0,
							associations: [],
							metadata: {
								sensitivity: "restricted",
								privateToken: "SECRET_METADATA_DO_NOT_LEAK",
								permissions: {
									requiresUserConfirmationBeforeUse: true,
								},
							},
							source: {
								sourceId: "src-1",
								sourceType: "conversation",
								quotedEvidence: "SECRET_EVIDENCE_DO_NOT_LEAK",
							},
						},
						score: 0.9,
					},
				],
			},
			proactiveNotices: [],
			proactiveMemoryIds: [],
			degradedSections: [],
			mandatorySectionsPreserved: [],
			budgetExceeded: false,
		}));
		const baseUrl = await startServer({}, { contextAssembler: { assemble } });

		const response = await postJson(`${baseUrl}/api/memory/context/retrieve`, {
			goal: "retrieve restricted memory",
			maxTokens: 500,
			userConfirmed: false,
		});
		const serialized = JSON.stringify(response.body);

		expect(response.status).toBe(200);
		expect(serialized).not.toContain("SECRET_CONTENT_DO_NOT_LEAK");
		expect(serialized).not.toContain("SECRET_METADATA_DO_NOT_LEAK");
		expect(serialized).not.toContain("SECRET_EVIDENCE_DO_NOT_LEAK");
		expect(serialized).not.toContain("privateToken");
		expect(serialized).not.toContain("quotedEvidence");
		const contextPack = response.body.contextPack as JsonObject;
		const memories = contextPack.memories as JsonObject[];
		const memory = memories[0]?.item as JsonObject;
		expect(memory.id).toBe("restricted-1");
		expect(memory.content).toBe(
			"[Memory withheld: requires_user_confirmation_before_use]",
		);
		expect(memory.metadata).toMatchObject({
			sensitivity: "restricted",
			redacted: true,
			redactionReason: "requires_user_confirmation_before_use",
		});
	});

	it("runs advanced memory backfill from the API", async () => {
		const backfillAdvancedMemory = vi.fn(async () => ({
			scanned: 2,
			sourcesLinked: 1,
			permissionsCreated: 1,
			nodesLinked: 1,
			skipped: 0,
		}));
		const baseUrl = await startServer({ backfillAdvancedMemory });

		const response = await postJson(`${baseUrl}/api/memory/backfill`, {
			limit: 25,
		});

		expect(response.status).toBe(200);
		expect(response.body.ok).toBe(true);
		expect(response.body.report).toMatchObject({ scanned: 2 });
		expect(backfillAdvancedMemory).toHaveBeenCalledWith(25);
	});

	it("runs memory retention from the API", async () => {
		const runActiveForgetting = vi.fn(async () => ({
			evaluated: 3,
			compressed: 1,
			expired: 1,
			superseded: 0,
			degraded: 0,
			untouched: 1,
		}));
		const baseUrl = await startServer({ runActiveForgetting });

		const response = await postJson(`${baseUrl}/api/memory/retention/run`, {
			now: "2026-05-19T00:00:00.000Z",
			unusedDays: 30,
			lowImportanceThreshold: 0.2,
			contradictionGraceDays: 7,
		});

		expect(response.status).toBe(200);
		expect(response.body.report).toMatchObject({ evaluated: 3, expired: 1 });
		expect(runActiveForgetting).toHaveBeenCalledWith(
			expect.objectContaining({
				unusedDays: 30,
				lowImportanceThreshold: 0.2,
				contradictionGraceDays: 7,
			}),
		);
		const options = runActiveForgetting.mock.calls[0]?.[0] as { now?: Date };
		expect(options.now?.toISOString()).toBe("2026-05-19T00:00:00.000Z");
	});

	it("reports advanced operational memory metrics", async () => {
		const db = {
			get: vi.fn(async (sql: string) => {
				if (sql.includes("memory_permissions WHERE")) return { count: 2 };
				if (sql.includes("memory_edges WHERE type")) return { count: 3 };
				if (sql.includes("memory_relations WHERE edge_type"))
					return { count: 1 };
				return { count: 0 };
			}),
			all: vi.fn(async (sql: string) => {
				if (sql.includes("GROUP BY sensitivity")) {
					return [
						{ sensitivity: "high", count: 2 },
						{ sensitivity: "restricted", count: 1 },
					];
				}
				if (sql.includes("GROUP BY feedback_type")) {
					return [
						{ feedback_type: "explicit_correct", count: 2 },
						{ feedback_type: "implicit_negative", count: 1 },
					];
				}
				if (sql.includes("memory_action_logs")) {
					return [
						{
							action_type: "memory.read",
							output: JSON.stringify({ redactedCount: 2, durationMs: 40 }),
						},
						{
							action_type: "memory.read",
							output: JSON.stringify({ redactedCount: 0, durationMs: 20 }),
						},
						{
							action_type: "memory.access_denied",
							output: JSON.stringify({
								deniedCount: 3,
								sensitiveDeniedCount: 2,
								confirmationDeniedCount: 1,
							}),
						},
					];
				}
				return [];
			}),
		};
		const baseUrl = await startServer({}, { db });

		const response = await getJson(`${baseUrl}/api/memory/stats`);
		const advanced = response.body.advanced as JsonObject;

		expect(response.status).toBe(200);
		expect(advanced.memory_requires_confirmation).toBe(2);
		expect(advanced.memory_contradictions).toBe(4);
		expect(advanced.memory_sensitivity_high).toBe(2);
		expect(advanced.memory_sensitivity_restricted).toBe(1);
		expect(advanced.memory_feedback_total).toBe(3);
		expect(advanced.memory_feedback_explicit_correct).toBe(2);
		expect(advanced.memory_retrieval_count).toBe(2);
		expect(advanced.memory_redacted_total).toBe(2);
		expect(advanced.memory_retrieval_latency_avg_ms).toBe(30);
		expect(advanced.memory_retrieval_latency_max_ms).toBe(40);
		expect(advanced.memory_access_denied_total).toBe(3);
		expect(advanced.memory_sensitive_access_denied_total).toBe(2);
		expect(advanced.memory_confirmation_denied_total).toBe(1);
	});
});
