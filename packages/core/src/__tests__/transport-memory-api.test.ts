import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaults } from "../config/defaults.js";
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
