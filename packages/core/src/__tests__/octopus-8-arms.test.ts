/**
 * Integration test: Octavio activates all 8 arms for a coordinated task.
 *
 * This test validates the full multi-agent coordination system:
 * - Each arm is an independent agent with its own specialty
 * - Arms communicate through the coordination bus
 * - Arms review each other's work (cross-review)
 * - Arms correct errors spotted by peers
 * - Crabby (QA) does final verification
 * - Results are synthesized from verified artifacts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMResponse } from "../ai/types.js";
import type { LLMRouter } from "../ai/router.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
	AgentCoordinationBus,
} from "../agent/agent-coordination-bus.js";
import {
	OCTOPUS_ARM_KEYS,
	OCTOPUS_ARM_PROFILES,
} from "../agent/arm-profiles.js";
import { CrossReviewEngine } from "../agent/cross-review-engine.js";
import { OctopusOrchestrator } from "../agent/orchestrator.js";
import type { AgentConfig } from "../agent/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockLLMRouter(
	responses: Map<string, LLMResponse>,
): LLMRouter {
	return {
		chat: vi.fn((request: { messages: Array<{ role: string; content: string }> }) => {
			const lastUserMessage =
				request.messages[request.messages.length - 1]?.content;
			if (typeof lastUserMessage === "string") {
				for (const [key, response] of responses) {
					if (lastUserMessage.includes(key)) {
						return Promise.resolve(response);
					}
				}
			}
			return Promise.resolve({
				content: "Resultado por defecto del agente.",
				toolCalls: [],
			} as LLMResponse);
		}),
		chatStream: vi.fn(),
	} as unknown as LLMRouter;
}

function createMockToolRegistry(): ToolRegistry {
	return {
		list: vi.fn().mockReturnValue([]),
		has: vi.fn().mockReturnValue(false),
		get: vi.fn().mockReturnValue(undefined),
		register: vi.fn(),
		execute: vi.fn(),
	} as unknown as ToolRegistry;
}

function createMockToolExecutor(): ToolExecutor {
	return {
		execute: vi.fn().mockResolvedValue({
			output: "Tool executed successfully",
			success: true,
		}),
	} as unknown as ToolExecutor;
}

const BASE_CONFIG: AgentConfig = {
	id: "octavio",
	name: "Octavio",
	description: "Root orchestrator",
	systemPrompt: "You are Octavio, the octopus orchestrator.",
};

/** Create a decomposition with all 8 arms assigned. */
function create8ArmDecomposition() {
	const subtasks = OCTOPUS_ARM_PROFILES.map((arm, index) => ({
		id: `task_${index + 1}`,
		description: `Subtarea para ${arm.name}: ${arm.description}`,
		role: arm.role,
		agentId: arm.agentId,
		agentName: arm.name,
		armKey: arm.key,
		avatar: arm.avatar,
		color: arm.color,
		toolScope: arm.defaultTools,
		priority: index + 1,
		acceptanceCriteria: [
			"La subtarea debe reportar evidencia concreta de avance.",
			"No se puede declarar completada sin resultados verificables.",
		],
		status: "pending" as const,
	}));

	return {
		originalGoal:
			"Analiza y mejora el proyecto completo: planifica, investiga, implementa, prueba, genera visuales, documenta, analiza rendimiento y recupera contexto.",
		subtasks,
		executionPlan: "parallel" as const,
		reasoning:
			"Tarea compleja que requiere la coordinacion de todos los 8 brazos de Octavio.",
	};
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Octavio 8 Arms — Full Coordination", () => {
	let mockLLMRouter: LLMRouter;
	let mockToolRegistry: ToolRegistry;
	let mockToolExecutor: ToolExecutor;

	beforeEach(() => {
		mockToolRegistry = createMockToolRegistry();
		mockToolExecutor = createMockToolExecutor();

		// Setup LLM responses for workers and synthesis
		const responses = new Map<string, LLMResponse>();
		responses.set("planifica", {
			content:
				"Plan creado: 3 fases con dependencias claras y checkpoints verificables.",
			toolCalls: [],
		} as LLMResponse);
		responses.set("memoria", {
			content:
				"Contexto recuperado: 15 memorias relevantes identificadas del proyecto.",
			toolCalls: [],
		} as LLMResponse);
		responses.set("codigo", {
			content:
				"Codigo implementado: modulo de coordinacion creado con 3 endpoints nuevos.",
			toolCalls: [],
		} as LLMResponse);
		responses.set("visual", {
			content:
				"Diagrama generado: /api/media/file/architecture-diagram.png",
			toolCalls: [],
		} as LLMResponse);
		responses.set("seguridad", {
			content:
				"QA completado: 2 vulnerabilidades encontradas y parcheadas.",
			toolCalls: [],
		} as LLMResponse);
		responses.set("document", {
			content:
				"Documentacion escrita: README actualizado + 3 guias API nuevas.",
			toolCalls: [],
		} as LLMResponse);
		responses.set("investiga", {
			content:
				"Investigacion completada: 5 mejores practicas identificadas de fuentes oficiales.",
			toolCalls: [],
		} as LLMResponse);
		responses.set("analiza", {
			content:
				"Analisis visual: diagramas existentes revisados, 3 mejoras sugeridas.",
			toolCalls: [],
		} as LLMResponse);
		responses.set("sintetiza", {
			content: "Sintesis final: todos los brazos completaron sus tareas.",
			toolCalls: [],
		} as LLMResponse);

		mockLLMRouter = createMockLLMRouter(responses);
	});

	// ── 1. All 8 ARM profiles exist and are unique ──

	it("should have exactly 8 unique arm profiles with distinct roles", () => {
		expect(OCTOPUS_ARM_PROFILES).toHaveLength(8);
		expect(OCTOPUS_ARM_KEYS).toHaveLength(8);

		const roles = OCTOPUS_ARM_PROFILES.map((arm) => arm.role);
		const uniqueRoles = new Set(roles);
		expect(uniqueRoles.size).toBe(8);

		const agentIds = OCTOPUS_ARM_PROFILES.map((arm) => arm.agentId);
		const uniqueIds = new Set(agentIds);
		expect(uniqueIds.size).toBe(8);
	});

	// ── 2. Decomposition assigns all 8 arms ──

	it("should decompose a complex task into subtasks for all 8 arms", async () => {
		const orchestrator = new OctopusOrchestrator(
			mockLLMRouter,
			mockToolRegistry,
			mockToolExecutor,
			BASE_CONFIG,
			{ maxWorkers: 8 },
		);

		// Mock decomposition to return all 8 arms
		mockLLMRouter.chat.mockResolvedValueOnce({
			content: JSON.stringify({
				complexity: 9,
				reasoning: "Tarea compleja que requiere los 8 brazos",
				executionPlan: "parallel",
				subtasks: OCTOPUS_ARM_PROFILES.map((arm, i) => ({
					id: `task_${i + 1}`,
					description: arm.description,
					role: `${arm.key}/${arm.role}`,
					toolScope: arm.defaultTools,
					priority: i + 1,
					dependsOn: [],
				})),
			}),
			toolCalls: [],
		} as LLMResponse);

		const decomposition = await orchestrator.decompose(
			"Analiza el proyecto completo con todos los brazos disponibles en paralelo",
		);

		expect(decomposition.subtasks).toHaveLength(8);
		expect(decomposition.executionPlan).toBe("parallel");

		// Verify each arm is assigned
		const assignedArms = decomposition.subtasks.map((s) => s.armKey);
		for (const key of OCTOPUS_ARM_KEYS) {
			expect(assignedArms).toContain(key);
		}
	});

	// ── 3. Coordination Bus — inter-agent messaging ──

	it("should allow agents to send direct messages to each other", () => {
		const bus = new AgentCoordinationBus();

		const receivedMessages: string[] = [];
		bus.subscribe("arm-ari", (msg) => {
			receivedMessages.push(msg.content);
		});

		bus.send({
			from: "arm-crabby",
			fromName: "Crabby",
			to: "arm-ari",
			type: "review_request",
			priority: "high",
			content: "Encontre un bug en tu codigo: null reference en linea 42.",
			relatedTaskId: "task_3",
		});

		expect(receivedMessages).toHaveLength(1);
		expect(receivedMessages[0]).toContain("null reference");
		expect(bus.messageCount).toBe(1);
	});

	it("should allow agents to broadcast status to all others", () => {
		const bus = new AgentCoordinationBus();

		const receivedByBibi: string[] = [];
		const receivedByCali: string[] = [];
		bus.subscribe("arm-bibi", (msg) => receivedByBibi.push(msg.content));
		bus.subscribe("arm-cali", (msg) => receivedByCali.push(msg.content));

		bus.send({
			from: "arm-octavio",
			fromName: "Octavio",
			to: "*",
			type: "status_update",
			priority: "normal",
			content: "Todos los brazos deben reportar progreso ahora.",
		});

		expect(receivedByBibi).toHaveLength(1);
		expect(receivedByCali).toHaveLength(1);
		// Octavio should NOT receive its own broadcast
		expect(bus.getMessagesForAgent("arm-octavio")).toHaveLength(0);
	});

	it("should detect conflicts between agents", () => {
		const bus = new AgentCoordinationBus();

		bus.send({
			from: "arm-ari",
			fromName: "Ari",
			to: "arm-cali",
			type: "conflict_alert",
			priority: "high",
			content:
				"Estas intentando generar una imagen que ya existe en /api/media/file/arch.png",
			relatedTaskId: "task_4",
		});

		const conflicts = bus.getConflictAlerts();
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].fromName).toBe("Ari");
	});

	// ── 4. Artifact publishing and peer review ──

	it("should publish worker results as artifacts for peer review", () => {
		const bus = new AgentCoordinationBus();

		bus.publishArtifact({
			taskId: "task_3",
			taskRole: "engineer",
			agentId: "arm-ari",
			agentName: "Ari",
			armKey: "ari",
			content:
				"Codigo implementado: function processData(input) { return input?.toString() ?? 'default'; }",
		});

		const artifact = bus.getArtifact("task_3");
		expect(artifact).toBeDefined();
		expect(artifact!.agentName).toBe("Ari");
		expect(artifact!.status).toBe("completed");
		expect(artifact!.reviewResults).toHaveLength(0);

		// Broadcast message should have been sent
		expect(bus.messageCount).toBe(1);
		const broadcast = bus.getMessagesForAgent("arm-ari");
		expect(broadcast).toHaveLength(0); // Ari doesn't get its own broadcast
	});

	it("should allow Crabby to review Ari's code and find issues", () => {
		const bus = new AgentCoordinationBus();

		bus.publishArtifact({
			taskId: "task_3",
			taskRole: "engineer",
			agentId: "arm-ari",
			agentName: "Ari",
			armKey: "ari",
			content:
				"Codigo con bug: const x = null; x.toString(); // crash potential",
		});

		const reviewResult = bus.addReview("task_3", {
			reviewerId: "arm-crabby",
			reviewerName: "Crabby",
			verdict: "needs_work",
			issues: [
				"Null reference: x can be null before calling toString()",
				"Falta manejo de errores",
			],
			suggestions: [
				"Usar optional chaining: x?.toString()",
				"Agregar try/catch o validacion de input",
			],
		});

		expect(reviewResult).toBe(true);

		const artifact = bus.getArtifact("task_3");
		expect(artifact!.status).toBe("needs_correction");
		expect(artifact!.reviewResults).toHaveLength(1);
		expect(artifact!.reviewResults[0].reviewerName).toBe("Crabby");

		// Ari should have been notified
		const ariMessages = bus.getMessagesForAgent("arm-ari");
		expect(ariMessages.length).toBeGreaterThanOrEqual(1);
		expect(ariMessages.some((m) => m.type === "correction")).toBe(true);
	});

	it("should allow Crabby to correct Ari's code", () => {
		const bus = new AgentCoordinationBus();

		bus.publishArtifact({
			taskId: "task_3",
			taskRole: "engineer",
			agentId: "arm-ari",
			agentName: "Ari",
			armKey: "ari",
			content: "const x = null; x.toString();",
		});

		bus.addReview("task_3", {
			reviewerId: "arm-crabby",
			reviewerName: "Crabby",
			verdict: "needs_work",
			issues: ["Null reference"],
			suggestions: ["Use optional chaining"],
		});

		bus.addCorrection("task_3", {
			correctorId: "arm-crabby",
			correctorName: "Crabby",
			originalContent: "const x = null; x.toString();",
			correctedContent:
				"const x = null; x?.toString() ?? 'default'; // Safe null handling",
			reason: "Null reference fix with optional chaining",
		});

		const artifact = bus.getArtifact("task_3");
		expect(artifact!.content).toContain("x?.toString()");
		expect(artifact!.status).toBe("under_review");
		expect(artifact!.corrections).toHaveLength(1);
		expect(artifact!.corrections[0].correctorName).toBe("Crabby");
	});

	// ── 5. Cross-review engine ──

	it("should assign complementary peer reviewers for each arm", () => {
		const bus = new AgentCoordinationBus();
		const engine = new CrossReviewEngine(mockLLMRouter, bus);

		// Publish artifacts from all 8 arms
		for (const arm of OCTOPUS_ARM_PROFILES) {
			bus.publishArtifact({
				taskId: `task_${arm.key}`,
				taskRole: arm.role,
				agentId: arm.agentId,
				agentName: arm.name,
				armKey: arm.key,
				content: `Resultado de ${arm.name}: trabajo completado.`,
			});
		}

		const assignments = engine.assignReviewers(bus.getAllArtifacts());

		// Each artifact should have a reviewer
		expect(assignments.length).toBeGreaterThanOrEqual(8);

		// No self-review
		for (const assignment of assignments) {
			const artifact = bus.getArtifact(assignment.taskId);
			expect(artifact!.armKey).not.toBe(assignment.reviewerArmKey);
		}

		// Verify specific review pairs
		const assignmentMap = new Map(
			assignments.map((a) => {
				const artifact = bus.getArtifact(a.taskId);
				return [artifact!.armKey, a.reviewerArmKey];
			}),
		);

		// Ari (engineer) should be reviewed by Crabby (QA)
		expect(assignmentMap.get("ari")).toBe("crabby");
		// Cali (creative) should be reviewed by Medi (vision)
		expect(assignmentMap.get("cali")).toBe("medi");
		// Bibi (planner) should be reviewed by Crabby (QA)
		expect(assignmentMap.get("bibi")).toBe("crabby");
	});

	it("should run cross-review and approve correct work", async () => {
		const bus = new AgentCoordinationBus();

		// Mock LLM to always approve
		mockLLMRouter.chat.mockResolvedValue({
			content: JSON.stringify({
				verdict: "approved",
				issues: [],
				suggestions: [],
			}),
			toolCalls: [],
		} as LLMResponse);

		const engine = new CrossReviewEngine(mockLLMRouter, bus, {
			enabled: true,
			requireFinalVerification: false, // Skip Crabby's final pass for speed
		});

		bus.publishArtifact({
			taskId: "task_1",
			taskRole: "planner",
			agentId: "arm-bibi",
			agentName: "Bibi",
			armKey: "bibi",
			content: "Plan completado con 3 fases y checkpoints.",
		});

		const artifacts = bus.getAllArtifacts();
		const result = await engine.runCrossReview(
			artifacts,
			"Planifica el proyecto",
		);

		expect(result.totalReviews).toBeGreaterThan(0);
		expect(result.approved).toBeGreaterThan(0);
		expect(result.unverifiedArtifacts).toHaveLength(0);
	});

	it("should run cross-review, find issues, and apply corrections", async () => {
		const bus = new AgentCoordinationBus();

		// First call: review finds issues. Second call: correction. Third: verification.
		let callCount = 0;
		mockLLMRouter.chat.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve({
					content: JSON.stringify({
						verdict: "needs_work",
						issues: ["Falta validacion de input"],
						suggestions: ["Agregar null check"],
					}),
					toolCalls: [],
				} as LLMResponse);
			}
			if (callCount === 2) {
				// Correction response
				return Promise.resolve({
					content:
						"Codigo corregido: function processData(input) { return input?.toString() ?? 'default'; }",
					toolCalls: [],
				} as LLMResponse);
			}
			// Final verification approves
			return Promise.resolve({
				content: JSON.stringify({
					verdict: "approved",
					issues: [],
					suggestions: [],
				}),
				toolCalls: [],
			} as LLMResponse);
		});

		const engine = new CrossReviewEngine(mockLLMRouter, bus, {
			enabled: true,
			correctionRounds: 1,
			requireFinalVerification: true,
		});

		bus.publishArtifact({
			taskId: "task_3",
			taskRole: "engineer",
			agentId: "arm-ari",
			agentName: "Ari",
			armKey: "ari",
			content:
				"Codigo sin validacion: function processData(input) { return input.toString(); }",
		});

		const result = await engine.runCrossReview(
			bus.getAllArtifacts(),
			"Implementa la funcion processData",
		);

		expect(result.needsCorrection).toBeGreaterThan(0);
		expect(result.correctionsApplied).toBeGreaterThan(0);

		// Artifact should have been corrected
		const artifact = bus.getArtifact("task_3");
		expect(artifact!.corrections.length).toBeGreaterThan(0);
		expect(artifact!.content).toContain("corregido");
	});

	// ── 6. Full orchestrator with review ──

	it("should execute all 8 arms in parallel with cross-review and synthesis", async () => {
		// Mock all worker responses (workers just return content, no tool calls)
		mockLLMRouter.chat.mockImplementation((request) => {
			const sysPrompt =
				typeof request.messages[0]?.content === "string"
					? request.messages[0].content
					: "";
			const userMsg = request.messages
				.filter((m) => m.role === "user")
				.map((m) => (typeof m.content === "string" ? m.content : ""))
				.join(" ");

			// Decomposition request
			if (sysPrompt.includes("orquestador de tareas")) {
				return Promise.resolve({
					content: JSON.stringify({
						complexity: 9,
						reasoning: "Tarea que requiere todos los brazos",
						executionPlan: "parallel",
						subtasks: OCTOPUS_ARM_PROFILES.map((arm, i) => ({
							id: `task_${i + 1}`,
							description: arm.description,
							role: `${arm.key}/${arm.role}`,
							toolScope: arm.defaultTools,
							priority: i + 1,
							dependsOn: [],
						})),
					}),
					toolCalls: [],
				} as LLMResponse);
			}

			// Worker execution
			if (userMsg.includes("Subtarea") || sysPrompt.includes("worker")) {
				return Promise.resolve({
					content: `Resultado completado para: ${userMsg.slice(0, 100)}`,
					toolCalls: [],
				} as LLMResponse);
			}

			// Review request
			if (sysPrompt.includes("revisor independiente")) {
				return Promise.resolve({
					content: JSON.stringify({
						verdict: "approved",
						issues: [],
						suggestions: [],
					}),
					toolCalls: [],
				} as LLMResponse);
			}

			// Synthesis request
			if (
				sysPrompt.includes("sintetiza") ||
				userMsg.includes("Resultados de los")
			) {
				return Promise.resolve({
					content:
						"Todos los 8 brazos completaron sus tareas exitosamente. Sintesis final: proyecto analizado y mejorado.",
					toolCalls: [],
				} as LLMResponse);
			}

			return Promise.resolve({
				content: "Resultado por defecto.",
				toolCalls: [],
			} as LLMResponse);
		});

		const orchestrator = new OctopusOrchestrator(
			mockLLMRouter,
			mockToolRegistry,
			mockToolExecutor,
			BASE_CONFIG,
			{ maxWorkers: 8 },
		);

		const decomposition = create8ArmDecomposition();
		const events: Array<{ type: string; data?: unknown }> = [];

		for await (const event of orchestrator.executeParallelWithReview(
			decomposition,
			{ runId: "test_8arms" },
		)) {
			events.push({ type: event.type, data: "data" in event ? event.data : undefined });
		}

		// Verify execution phases
		const eventTypes = events.map((e) => e.type);

		// Should have decomposition event
		expect(eventTypes).toContain("decomposition");

		// Should have worker events for all 8 arms
		const workerStarts = eventTypes.filter(
			(t) => t === "worker_started",
		).length;
		expect(workerStarts).toBe(8);

		// Should have worker completions
		const workerDones = eventTypes.filter(
			(t) => t === "worker_done",
		).length;
		expect(workerDones).toBe(8);

		// Should have review phase
		expect(eventTypes).toContain("review_started");

		// Should have review completions
		const reviewsCompleted = eventTypes.filter(
			(t) => t === "review_completed",
		).length;
		expect(reviewsCompleted).toBeGreaterThan(0);

		// Should have verification phase
		expect(eventTypes).toContain("verification_phase");

		// Should have telemetry
		expect(eventTypes).toContain("telemetry");

		// Should have final synthesis
		expect(eventTypes).toContain("synthesis");

		// Verify the coordination bus has artifacts
		const bus = orchestrator.getCoordinationBus();
		expect(bus.artifactCount).toBe(8);

		// Verify inter-agent communication happened
		expect(bus.messageCount).toBeGreaterThan(0);

		// Verify coordination summary
		const summary = bus.getCoordinationSummary();
		expect(summary).toContain("Coordination Summary");
	});

	// ── 7. Agents can ask questions and get answers ──

	it("should support question-answer flows between agents", () => {
		const bus = new AgentCoordinationBus();

		const ariMessages: string[] = [];
		const bibiMessages: string[] = [];

		// Subscribe both agents BEFORE sending messages
		bus.subscribe("arm-ari", (msg) => ariMessages.push(msg.content));
		bus.subscribe("arm-bibi", (msg) => bibiMessages.push(msg.content));

		// Ari asks Bibi a question
		bus.send({
			from: "arm-ari",
			fromName: "Ari",
			to: "arm-bibi",
			type: "question",
			priority: "normal",
			content:
				"Bibi, cual es la prioridad del modulo de autenticacion?",
			relatedTaskId: "task_3",
		});

		// Bibi received the question
		expect(bibiMessages).toHaveLength(1);
		expect(bibiMessages[0]).toContain("autenticacion");

		// Bibi answers
		bus.send({
			from: "arm-bibi",
			fromName: "Bibi",
			to: "arm-ari",
			type: "answer",
			priority: "normal",
			content:
				"La autenticacion es prioridad alta, fase 1 del plan.",
			relatedTaskId: "task_1",
		});

		expect(ariMessages).toHaveLength(1);
		expect(ariMessages[0]).toContain("prioridad alta");

		// Check conversation between Ari and Bibi
		const conversation = bus.getConversationBetween("arm-ari", "arm-bibi");
		expect(conversation).toHaveLength(2);
	});

	// ── 8. Shared state between agents ──

	it("should support shared state for coordination", () => {
		const bus = new AgentCoordinationBus();

		// Bibi sets the project plan
		bus.setState("current_phase", "implementation");
		bus.setState("blocking_issues", ["auth-module-incomplete"]);

		// Ari reads the shared state
		expect(bus.getState("current_phase")).toBe("implementation");
		expect(bus.getState("blocking_issues")).toEqual([
			"auth-module-incomplete",
		]);

		// Ari resolves the blocking issue
		bus.setState("blocking_issues", []);

		// Crabby verifies
		expect(bus.getState("blocking_issues")).toEqual([]);
	});

	// ── 9. Verification chain: 3 agents verify a single artifact ──

	it("should support multiple review rounds on a single artifact", () => {
		const bus = new AgentCoordinationBus();

		bus.publishArtifact({
			taskId: "task_critical",
			taskRole: "engineer",
			agentId: "arm-ari",
			agentName: "Ari",
			armKey: "ari",
			content:
				"Codigo critico: async function deploy(env) { await build(env); await release(env); }",
		});

		// First review: Crabby finds issues
		bus.addReview("task_critical", {
			reviewerId: "arm-crabby",
			reviewerName: "Crabby",
			verdict: "needs_work",
			issues: [
				"Falta rollback en caso de error",
				"No hay validacion del parametro env",
			],
			suggestions: [
				"Agregar try/catch con rollback",
				"Validar env contra lista permitida",
			],
		});

		let artifact = bus.getArtifact("task_critical");
		expect(artifact!.status).toBe("needs_correction");
		expect(artifact!.reviewResults).toHaveLength(1);

		// Apply correction
		bus.addCorrection("task_critical", {
			correctorId: "arm-crabby",
			correctorName: "Crabby",
			originalContent: artifact!.content,
			correctedContent:
				"async function deploy(env) { if (!['staging','prod'].includes(env)) throw new Error('Invalid env'); try { await build(env); await release(env); } catch(e) { await rollback(env); throw e; } }",
			reason: "Added env validation and rollback",
		});

		artifact = bus.getArtifact("task_critical");
		expect(artifact!.content).toContain("rollback");
		expect(artifact!.status).toBe("under_review");

		// Second review: approves after correction
		bus.addReview("task_critical", {
			reviewerId: "arm-crabby",
			reviewerName: "Crabby",
			verdict: "approved",
			issues: [],
			suggestions: [],
		});

		artifact = bus.getArtifact("task_critical");
		expect(artifact!.reviewResults).toHaveLength(2);
		expect(artifact!.reviewResults[1].verdict).toBe("approved");
	});

	// ── 10. Edge cases ──

	it("should handle artifact that does not exist gracefully", () => {
		const bus = new AgentCoordinationBus();

		expect(bus.getArtifact("nonexistent")).toBeUndefined();
		expect(bus.addReview("nonexistent", {
			reviewerId: "arm-crabby",
			reviewerName: "Crabby",
			verdict: "approved",
			issues: [],
			suggestions: [],
		})).toBe(false);
		expect(bus.addCorrection("nonexistent", {
			correctorId: "arm-crabby",
			correctorName: "Crabby",
			originalContent: "",
			correctedContent: "fixed",
			reason: "test",
		})).toBe(false);
	});

	it("should clear all state on reset", () => {
		const bus = new AgentCoordinationBus();

		bus.publishArtifact({
			taskId: "task_1",
			taskRole: "test",
			agentId: "arm-ari",
			agentName: "Ari",
			armKey: "ari",
			content: "Test content",
		});
		bus.send({
			from: "arm-ari",
			fromName: "Ari",
			to: "arm-bibi",
			type: "info",
			priority: "normal",
			content: "Test message",
		});
		bus.setState("key", "value");

		expect(bus.messageCount).toBe(2); // artifact broadcast + direct message
		expect(bus.artifactCount).toBe(1);

		bus.clear();
		expect(bus.messageCount).toBe(0);
		expect(bus.artifactCount).toBe(0);
		expect(bus.getState("key")).toBeUndefined();
	});

	it("should prune old messages but keep recent ones", () => {
		const bus = new AgentCoordinationBus();

		bus.send({
			from: "arm-ari",
			fromName: "Ari",
			to: "arm-bibi",
			type: "info",
			priority: "normal",
			content: "Old message",
		});

		expect(bus.messageCount).toBe(1);

		// Prune messages older than 0ms (should remove everything)
		bus.pruneMessages(0);
		expect(bus.messageCount).toBe(0);
	});
});
