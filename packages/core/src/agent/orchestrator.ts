/**
 * OctopusOrchestrator — Cerebro del sistema multi-agente paralelo.
 *
 * Inspirado en Claude Code Agent Teams + OpenHands delegation:
 * - Recibe un objetivo del usuario
 * - Usa el LLM para descomponerlo en subtareas independientes
 * - Asigna cada subtarea a un worker paralelo vía WorkerPool
 * - Monitorea progreso vía EventStream
 * - Sintetiza resultados finales en una respuesta coherente
 */

import type { LLMRouter } from "../ai/router.js";
import type { LLMRequest } from "../ai/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import { AgentCoordinationBus } from "./agent-coordination-bus.js";
import { EventStream } from "./event-stream.js";
import { getOctopusArmProfile } from "./arm-profiles.js";
import { routeTaskToArm } from "./arm-router.js";
import {
	CrossReviewEngine,
	type CrossReviewConfig,
	type CrossReviewResult,
} from "./cross-review-engine.js";
import { createProgressSignature } from "./retry-policy.js";
import type { AgentConfig } from "./types.js";
import type {
	WorkflowManager,
	WorkflowTaskRecord,
} from "./workflow-manager.js";
import { type SubTask, type WorkerConfig, WorkerPool } from "./worker-pool.js";
import type { LiveAgentRuntime } from "./worker-pool.js";

export interface TaskDecomposition {
	originalGoal: string;
	subtasks: SubTask[];
	executionPlan: "parallel" | "sequential" | "mixed";
	reasoning: string;
}

export interface WorkerAgentMetadata {
	agentId?: string;
	agentName?: string;
	armKey?: string;
	avatar?: string;
	color?: string;
	activity?: string;
	liveAgentRuntime?: boolean;
}

export interface OrchestratorConfig {
	maxWorkers: number;
	workerConfig: Partial<WorkerConfig>;
	getAgentRuntime?: (agentId: string) => LiveAgentRuntime | undefined;
	/** Umbral mínimo de complejidad para activar multi-agent (1-10) */
	complexityThreshold: number;
	/** Modelo específico para la descomposición (puede ser diferente al de los workers) */
	decompositionModel?: string;
	/** Timeout local para descomponer antes de caer a single-agent. */
	decompositionTimeoutMs: number;
	/** Timeout local para síntesis antes de usar fallback determinista. */
	synthesisTimeoutMs: number;
	/** Presupuesto máximo de tokens para síntesis final multiagente. */
	synthesisMaxTokens: number;
	/** Config for cross-review between agents */
	crossReview?: Partial<CrossReviewConfig>;
}

export type OrchestratorEvent =
	| { type: "decomposition"; data: TaskDecomposition }
	| ({
			type: "worker_started";
			workerId: string;
			taskId: string;
			role?: string;
			description: string;
	  } & WorkerAgentMetadata)
	| ({
			type: "worker_progress";
			workerId: string;
			taskId: string;
			message: string;
			progress: number;
			toolName?: string;
	  } & WorkerAgentMetadata)
	| ({ type: "worker_done"; workerId: string; taskId: string; result: string } & WorkerAgentMetadata)
	| ({ type: "worker_error"; workerId: string; taskId: string; error: string } & WorkerAgentMetadata)
	| { type: "review_started"; data: { artifactCount: number; reviewersAssigned: number } }
	| { type: "review_completed"; data: { taskId: string; reviewerName: string; verdict: string; issues: string[] } }
	| { type: "correction_applied"; data: { taskId: string; correctorName: string; reason: string } }
	| { type: "verification_phase"; data: CrossReviewResult }
	| { type: "telemetry"; data: OrchestratorTelemetry }
	| { type: "synthesis"; result: string };

export interface OrchestratorTelemetry {
	runId: string;
	workflowRunId?: string;
	totalMs: number;
	executionMs: number;
	synthesisMs: number;
	workerCount: number;
	succeeded: number;
	failed: number;
	cancelled: number;
}

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
	maxWorkers: 5,
	workerConfig: {},
	complexityThreshold: 5,
	decompositionTimeoutMs: 30_000,
	synthesisTimeoutMs: 10_000,
	synthesisMaxTokens: 1200,
};

const SYNTHESIS_RESULT_CHARS_PER_TASK = 1500;

function createRunId(): string {
	return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(
				() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		}),
	]);
}

type WorkflowEventRecord = {
	task_id: string | null;
	event_type: string;
	message: string | null;
	created_at: string;
	metadata: string | null;
};

function parseJsonRecord(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseJsonStringArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function metadataStringArray(
	metadata: Record<string, unknown>,
	key: string,
): string[] {
	const value = metadata[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function stringMetadata(
	metadata: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function taskAgentMetadata(task?: SubTask): WorkerAgentMetadata {
	return {
		agentId: task?.agentId,
		agentName: task?.agentName,
		armKey: task?.armKey,
		avatar: task?.avatar,
		color: task?.color,
	};
}

function eventAgentMetadata(
	task: SubTask | undefined,
	eventMetadata?: Record<string, unknown>,
): WorkerAgentMetadata {
	const liveAgentRuntime = eventMetadata?.liveAgentRuntime;
	return {
		...taskAgentMetadata(task),
		agentId: stringMetadata(eventMetadata ?? {}, "agentId") ?? task?.agentId,
		agentName: stringMetadata(eventMetadata ?? {}, "agentName") ?? task?.agentName,
		armKey: stringMetadata(eventMetadata ?? {}, "armKey") ?? task?.armKey,
		avatar: stringMetadata(eventMetadata ?? {}, "avatar") ?? task?.avatar,
		color: stringMetadata(eventMetadata ?? {}, "color") ?? task?.color,
		activity: stringMetadata(eventMetadata ?? {}, "activity"),
		liveAgentRuntime:
			typeof liveAgentRuntime === "boolean" ? liveAgentRuntime : undefined,
	};
}

function getWorkflowSourceTaskId(task: WorkflowTaskRecord): string {
	const metadata = parseJsonRecord(task.metadata);
	return typeof metadata.sourceTaskId === "string"
		? metadata.sourceTaskId
		: task.id;
}

const DECOMPOSITION_PROMPT = `Eres un orquestador de tareas. Tu trabajo es analizar el objetivo del usuario y descomponerlo en subtareas independientes que puedan ejecutarse en paralelo por agentes especializados.

Responde SOLO con un bloque JSON válido (sin markdown, sin \`\`\`) con este esquema exacto:

{
  "complexity": <número 1-10>,
  "reasoning": "<explicación breve de por qué descompones así>",
  "executionPlan": "parallel" | "sequential" | "mixed",
  "subtasks": [
    {
      "id": "task_1",
      "description": "<descripción clara y completa de la subtarea>",
      "role": "<rol del worker: researcher | coder | browser-navigator | analyst | writer>",
      "toolScope": ["<herramientas que necesita este worker>"],
      "priority": <1=alta, 5=baja>,
      "dependsOn": ["<IDs de tareas de las que depende, o vacío>"]
    }
  ]
}

Reglas:
1. Si la tarea es simple (complexity <= THRESHOLD), devuelve un JSON con subtasks vacío y complexity baja.
2. Maximiza la paralelización: solo usa dependencias cuando sean estrictamente necesarias.
3. Cada subtarea debe ser auto-contenida: incluir todo el contexto que el worker necesita.
4. Los roles disponibles son brazos Octopus o roles funcionales: bibi/planner, anita/memory-knowledge, ari/engineer, cali/creative-media, crabby/qa-security, estelita/synthesis-writer, langi/researcher, medi/vision-data.
5. Los toolScopes posibles incluyen: shell, read_file, write_file, browser_navigate, browser_click, browser_read_page, browser_screenshot, browser_observe, browser_snapshot, browser_eval, execute_code, web_search, save_media.
6. toolScope es una recomendación de herramientas prioritarias para cada worker, NO una restricción. Todos los workers tendrán acceso completo a las herramientas registradas, MCPs, memoria, skills y contexto compartido disponibles en el sistema.
7. Para subtareas de generación programática de imágenes/audio/video, incluye SIEMPRE execute_code en toolScope. execute_code auto-guarda archivos media generados si el worker los escribe en el directorio actual del script; save_media solo es necesario para payloads pequeños que ya vienen en base64 desde una API externa. Nunca conviertas archivos o URLs de media de Octopus a base64.
8. Un máximo de MAX_WORKERS subtareas paralelas.`;

export class OctopusOrchestrator {
	private eventStream: EventStream;
	private workerPool: WorkerPool;
	private config: OrchestratorConfig;
	private coordinationBus: AgentCoordinationBus;
	private crossReviewEngine: CrossReviewEngine;

	constructor(
		private llmRouter: LLMRouter,
		private toolRegistry: ToolRegistry,
		private toolExecutor: ToolExecutor,
		private baseConfig: AgentConfig,
		config: Partial<OrchestratorConfig> = {},
		private workflowManager?: WorkflowManager,
	) {
		this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
		this.eventStream = new EventStream();
		this.workerPool = new WorkerPool(
			llmRouter,
			toolRegistry,
			toolExecutor,
			this.eventStream,
			baseConfig,
			this.config.maxWorkers,
			{ getAgentRuntime: this.config.getAgentRuntime },
		);
		this.coordinationBus = new AgentCoordinationBus();
		this.crossReviewEngine = new CrossReviewEngine(
			llmRouter,
			this.coordinationBus,
			this.config.crossReview,
		);
	}

	/**
	 * Evaluar si una tarea necesita descomposición multi-agente.
	 */
	async shouldDecompose(message: string): Promise<boolean> {
		// Octopus trabaja solo por defecto. El multiagente solo se activa cuando
		// hay señales fuertes de 2+ tareas independientes que pueden correr a la vez.
		const explicitWorkerCount =
			/\b(?:usa|use|con|exactamente|al menos|mínimo|minimo)?\s*(?:[2-9]|\d{2,})\s+(?:workers?|agentes?|brazos?)\b/i.test(
				message,
			);
		const labeledWorkers = this.extractExplicitWorkerSubtasks(message).length;
		const explicitParallel =
			/\b(paralel[oa]s?|parallel|simult[aá]ne[oa]s?|a la vez|en paralelo|multiagente|multi-agent|subagentes|workers?|varios agentes|m[uú]ltiples agentes)\b/i.test(
				message,
			);
		const explicitDistribution =
			/\b(divide|dividir|delegar|delega|asigna|encarga|distribuye|reparte)\b/i.test(
				message,
			) &&
			/\b(tareas?|subtareas?|agentes?|workers?|partes|lotes?)\b/i.test(message);
		const batchWork =
			/\b(vari[oa]s?|m[uú]ltiples|diferentes|distint[oa]s|independientes|por separado)\b/i.test(
				message,
			) &&
			/\b(im[aá]genes?|videos?|escenas?|archivos?|b[uú]squedas?|investigaciones?|variantes?|opciones?|tareas?)\b/i.test(
				message,
			);
		const countedBatch =
			/\b(?:[2-9]|\d{2,})\b[^.\n]{0,80}\b(im[aá]genes?|videos?|escenas?|archivos?|b[uú]squedas?|variantes?|opciones?|tareas?)\b/i.test(
				message,
			);
		const numberedItems = message.match(/^\s*\d+[.)]\s+.+$/gm)?.length ?? 0;

		return (
			explicitWorkerCount ||
			labeledWorkers >= 2 ||
			explicitParallel ||
			explicitDistribution ||
			batchWork ||
			countedBatch ||
			numberedItems >= 3
		);
	}

	/**
	 * Descomponer un objetivo del usuario en subtareas paralelas.
	 */
	async decompose(goal: string): Promise<TaskDecomposition> {
		const explicitWorkerSubtasks = this.extractExplicitWorkerSubtasks(goal);
		if (explicitWorkerSubtasks.length > 1) {
			return this.explicitWorkerDecomposition(goal, explicitWorkerSubtasks);
		}

		const prompt = DECOMPOSITION_PROMPT.replace(
			"THRESHOLD",
			String(this.config.complexityThreshold),
		).replace("MAX_WORKERS", String(this.config.maxWorkers));

		const request: LLMRequest = {
			model:
				this.config.decompositionModel || this.baseConfig.model || "default",
			messages: [
				{ role: "system", content: prompt },
				{ role: "user", content: goal },
			],
			maxTokens: 2000,
			temperature: 0.2,
		};

		let content = "";
		try {
			const response = await withTimeout(
				this.llmRouter.chat(request),
				this.config.decompositionTimeoutMs,
			);
			content = response.content || "";
		} catch {
			return this.singleTaskFallback(
				goal,
				"La descomposición LLM no terminó a tiempo",
			);
		}

		try {
			// Extraer JSON de la respuesta
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				return this.singleTaskFallback(
					goal,
					"No se pudo parsear la descomposición",
				);
			}

			const parsed = JSON.parse(jsonMatch[0]) as {
				complexity: number;
				reasoning: string;
				executionPlan: "parallel" | "sequential" | "mixed";
				subtasks: Array<{
					id: string;
					description: string;
					role: string;
					toolScope: string[];
					priority: number;
					dependsOn?: string[];
				}>;
			};

			// Si la complejidad es baja, ejecutar como single agent
			if (
				parsed.complexity <= this.config.complexityThreshold ||
				parsed.subtasks.length <= 1
			) {
				return this.singleTaskFallback(goal, parsed.reasoning);
			}

			// Limitar a maxWorkers
			const subtasks: SubTask[] = parsed.subtasks
				.slice(0, this.config.maxWorkers)
				.map((st) => {
					const arm = routeTaskToArm({
						role: st.role,
						description: st.description,
						toolScope: st.toolScope,
					});
					return {
						...st,
						role: arm.role,
						agentId: arm.agentId,
						agentName: arm.name,
						armKey: arm.key,
						avatar: arm.avatar,
						color: arm.color,
						acceptanceCriteria: [
							"La subtarea debe reportar evidencia concreta de avance o bloqueo.",
							"No se puede declarar completada sin artefactos, resultados o verificacion explicita.",
						],
						status: "pending" as const,
						dependsOn: st.dependsOn?.length ? st.dependsOn : undefined,
					};
				});

			return {
				originalGoal: goal,
				subtasks,
				executionPlan: parsed.executionPlan,
				reasoning: parsed.reasoning,
			};
		} catch {
			return this.singleTaskFallback(
				goal,
				"Error parseando respuesta de descomposición",
			);
		}
	}

	/**
	 * Fallback: ejecutar como una sola tarea (sin multi-agent).
	 */
	private singleTaskFallback(
		goal: string,
		reasoning: string,
	): TaskDecomposition {
		return {
			originalGoal: goal,
			subtasks: [],
			executionPlan: "sequential",
			reasoning,
		};
	}

	private extractExplicitWorkerSubtasks(goal: string): Array<{
		id: string;
		description: string;
		role: string;
	}> {
		const matches = Array.from(
			goal.matchAll(
				/\b(worker|agente|brazo)\s*(\d+)\s*[:.)-]\s*([\s\S]*?)(?=\b(?:worker|agente|brazo)\s*\d+\s*[:.)-]|$)/gi,
			),
		);
		return matches
			.map((match, index) => {
				const rawDescription = (match[3] ?? "")
					.replace(/\b(luego|despu[eé]s|al final)\s+sintetiza[\s\S]*$/i, "")
					.trim()
					.replace(/[.;,]+$/, "")
					.trim();
				const label = (match[1] ?? "worker").toLowerCase();
				const number = match[2] ?? String(index + 1);
				return {
					id: `task_${number}`,
					role: label,
					description: rawDescription,
				};
			})
			.filter((task) => task.description.length > 0)
			.slice(0, this.config.maxWorkers);
	}

	private explicitWorkerDecomposition(
		goal: string,
		explicitTasks: Array<{ id: string; description: string; role: string }>,
	): TaskDecomposition {
		const subtasks: SubTask[] = explicitTasks.map((task, index) => {
			const arm = routeTaskToArm({
				role: task.role,
				description: task.description,
				toolScope: [],
			});
			return {
				id: task.id || `task_${index + 1}`,
				description: task.description,
				role: arm.role,
				toolScope: [],
				priority: index + 1,
				agentId: arm.agentId,
				agentName: arm.name,
				armKey: arm.key,
				avatar: arm.avatar,
				color: arm.color,
				acceptanceCriteria: [
					"La subtarea debe reportar evidencia concreta de avance o bloqueo.",
					"No se puede declarar completada sin resultados o verificacion explicita.",
				],
				status: "pending" as const,
			};
		});
		return {
			originalGoal: goal,
			subtasks,
			executionPlan: "parallel",
			reasoning:
				"El usuario especificó workers/agentes numerados, por lo que se crea una descomposición determinista sin esperar al modelo.",
		};
	}

	private getStoredTaskResults(
		events: WorkflowEventRecord[],
		tasks: WorkflowTaskRecord[],
	): Map<string, string> {
		const taskIdToSourceId = new Map(
			tasks.map((task) => [task.id, getWorkflowSourceTaskId(task)]),
		);
		const results = new Map<string, string>();
		for (const event of events) {
			if (event.event_type !== "result" || !event.task_id || !event.message) {
				continue;
			}
			const sourceTaskId = taskIdToSourceId.get(event.task_id);
			if (sourceTaskId) results.set(sourceTaskId, event.message);
		}
		return results;
	}

	private toSubTask(
		task: WorkflowTaskRecord,
		doneSourceIds: Set<string>,
		storedResults: Map<string, string>,
	): SubTask {
		const metadata = parseJsonRecord(task.metadata);
		const sourceTaskId = getWorkflowSourceTaskId(task);
		const allDependsOn = parseJsonStringArray(task.depends_on);
		const completedDependsOn = allDependsOn.filter((dep) =>
			doneSourceIds.has(dep),
		);
		const remainingDependsOn = allDependsOn.filter(
			(dep) => !doneSourceIds.has(dep),
		);
		const dependencyContext = completedDependsOn
			.map(
				(dep) =>
					`[Resultado previo de tarea ${dep}]: ${storedResults.get(dep)?.slice(0, 500) || "sin resultado almacenado"}`,
			)
			.join("\n");
		const description = [
			task.description || task.title,
			dependencyContext
				? `Contexto de tareas ya completadas:\n${dependencyContext}`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
		const armProfile = task.arm_key
			? getOctopusArmProfile(task.arm_key)
			: undefined;

		return {
			id: sourceTaskId,
			description,
			role:
				typeof metadata.role === "string"
					? metadata.role
					: task.arm_key || "worker",
			agentId: task.assigned_agent_id ?? undefined,
			agentName: stringMetadata(metadata, "agentName") ?? armProfile?.name ?? (task.title.includes(":")
				? task.title.split(":")[0]
				: undefined),
			armKey: task.arm_key ?? undefined,
			avatar: stringMetadata(metadata, "avatar") ?? armProfile?.avatar,
			color: stringMetadata(metadata, "color") ?? armProfile?.color,
			acceptanceCriteria: parseJsonStringArray(task.acceptance_criteria),
			toolScope: metadataStringArray(metadata, "toolScope"),
			priority: task.priority,
			status: task.status === "done" ? "done" : "pending",
			dependsOn: remainingDependsOn.length ? remainingDependsOn : undefined,
		};
	}

	private getFinalStatusFromSubtasks(subtasks: SubTask[]): {
		status: "done" | "failed" | "partial";
		succeeded: number;
		failed: number;
		cancelled: number;
	} {
		const succeeded = subtasks.filter((task) => task.status === "done").length;
		const failed = subtasks.filter((task) => task.status === "failed").length;
		const cancelled = subtasks.filter(
			(task) => task.status === "cancelled",
		).length;
		const status =
			failed > 0 || cancelled > 0
				? succeeded > 0
					? "partial"
					: "failed"
				: "done";
		return { status, succeeded, failed, cancelled };
	}

	async *resumeWorkflowRun(
		workflowRunId: string,
		workerConfig: Partial<WorkerConfig> = {},
	): AsyncIterable<OrchestratorEvent> {
		if (!this.workflowManager) {
			throw new Error("WorkflowManager is required to resume workflow runs.");
		}

		const claimedRun =
			await this.workflowManager.claimRunForExecution(workflowRunId);
		if (!claimedRun) return;

		const snapshot = await this.workflowManager.getRunSnapshot(workflowRunId);
		const storedEvents = snapshot.events as WorkflowEventRecord[];
		const storedResults = this.getStoredTaskResults(
			storedEvents,
			snapshot.tasks,
		);
		const doneSourceIds = new Set(
			snapshot.tasks
				.filter((task) => task.status === "done")
				.map((task) => getWorkflowSourceTaskId(task)),
		);
		const workflowTaskBySubtask = new Map(
			snapshot.tasks.map((task) => [getWorkflowSourceTaskId(task), task.id]),
		);
		const allSubtasks = snapshot.tasks.map((task) =>
			this.toSubTask(task, doneSourceIds, storedResults),
		);
		const pendingSubtasks = allSubtasks.filter(
			(task) => task.status !== "done" && task.status !== "cancelled",
		);
		const runMetadata = parseJsonRecord(claimedRun.metadata);
		const runId = `resume_${workflowRunId}_${Date.now()}`;
		const decomposition: TaskDecomposition = {
			originalGoal: claimedRun.goal,
			subtasks: pendingSubtasks,
			executionPlan:
				runMetadata.executionPlan === "parallel" ||
				runMetadata.executionPlan === "sequential" ||
				runMetadata.executionPlan === "mixed"
					? runMetadata.executionPlan
					: "mixed",
			reasoning:
				typeof runMetadata.reasoning === "string"
					? `Reanudacion durable: ${runMetadata.reasoning}`
					: "Reanudacion durable de tareas persistidas.",
		};

		yield { type: "decomposition", data: decomposition };

		if (pendingSubtasks.length === 0) {
			const final = this.getFinalStatusFromSubtasks(allSubtasks);
			const synthesis = await this.synthesize(
				{ ...decomposition, subtasks: allSubtasks },
				storedResults,
			);
			await this.workflowManager.updateRunStatus(workflowRunId, final.status, {
				currentPhase: "synthesis",
				metadata: { resumed: true, runId, ...final },
			});
			await this.workflowManager.recordEvent({
				runId: workflowRunId,
				agentId: this.baseConfig.id,
				eventType: "synthesis",
				message: synthesis.slice(0, 4000),
				metadata: final,
			});
			yield {
				type: "telemetry",
				data: {
					runId,
					workflowRunId,
					totalMs: 0,
					executionMs: 0,
					synthesisMs: 0,
					workerCount: 0,
					succeeded: final.succeeded,
					failed: final.failed,
					cancelled: final.cancelled,
				},
			};
			yield { type: "synthesis", result: synthesis };
			return;
		}

		const eventQueue: OrchestratorEvent[] = [];
		let resolveWaiting: (() => void) | null = null;
		const taskById = new Map(pendingSubtasks.map((task) => [task.id, task]));
		const unsubscribe = this.eventStream.subscribe((event) => {
			if (event.runId !== runId) return;
			let orchEvent: OrchestratorEvent | null = null;
			const workflowTaskId = workflowTaskBySubtask.get(event.taskId);
			const sourceTask = taskById.get(event.taskId);
			const agentMetadata = eventAgentMetadata(
				sourceTask,
				event.data.metadata,
			);

			void this.workflowManager
				?.recordEvent({
					runId: workflowRunId,
					taskId: workflowTaskId,
					agentId: sourceTask?.agentId,
					eventType: event.type,
					message:
						event.data.message ?? event.data.error ?? event.data.toolResult,
					toolName: event.data.toolName,
					metadata: {
						orchestratorRunId: runId,
						sourceTaskId: event.taskId,
						workerId: event.workerId,
						progress: event.data.progress,
						resumed: true,
						...agentMetadata,
					},
				})
				.catch(() => undefined);

			switch (event.type) {
				case "task_claimed":
					if (workflowTaskId) {
						void this.workflowManager
							?.updateTaskStatus(workflowTaskId, "running", {
								stepKey: "claimed",
							})
							.catch(() => undefined);
					}
					orchEvent = {
						type: "worker_started",
						workerId: event.workerId,
						taskId: event.taskId,
						role: sourceTask?.role,
						description: sourceTask?.description || event.data.message || "",
						...agentMetadata,
					};
					break;
				case "tool_used":
				case "progress":
				case "thinking":
				case "tool_result":
					orchEvent = {
						type: "worker_progress",
						workerId: event.workerId,
						taskId: event.taskId,
						message:
							event.data.message ||
							(event.type === "tool_result" && event.data.toolName
								? `Resultado de ${event.data.toolName}: ${event.data.toolResult || "recibido"}`
								: event.data.toolName || ""),
						progress: event.data.progress || 0,
						toolName: event.data.toolName,
						...agentMetadata,
					};
					break;
				case "result":
					if (workflowTaskId) {
						void this.workflowManager
							?.updateTaskStatus(workflowTaskId, "done", {
								stepKey: "result",
								progressSignature: createProgressSignature({
									status: "done",
									stepKey: "result",
									verifiedOutputs: [event.data.message ?? ""].filter(Boolean),
								}),
							})
							.catch(() => undefined);
					}
					orchEvent = {
						type: "worker_done",
						workerId: event.workerId,
						taskId: event.taskId,
						result: event.data.message || "",
						...agentMetadata,
					};
					break;
				case "error":
					if (workflowTaskId) {
						void this.workflowManager
							?.recordFailureAndDecideRetry({
								taskId: workflowTaskId,
								stepKey: event.data.toolName ?? "worker_error",
								progressSignature: createProgressSignature({
									status: "failed",
									stepKey: event.data.toolName ?? "worker_error",
								}),
								error: event.data.error || "Error desconocido",
								metadata: {
									orchestratorRunId: runId,
									sourceTaskId: event.taskId,
									workerId: event.workerId,
									resumed: true,
									...agentMetadata,
								},
							})
							.catch(() => undefined);
					}
					orchEvent = {
						type: "worker_error",
						workerId: event.workerId,
						taskId: event.taskId,
						error: event.data.error || "Error desconocido",
						...agentMetadata,
					};
					break;
			}

			if (orchEvent) {
				eventQueue.push(orchEvent);
				if (resolveWaiting) {
					resolveWaiting();
					resolveWaiting = null;
				}
			}
		});

		const startedAt = Date.now();
		const executionStartedAt = Date.now();
		const executionPromise = this.workerPool.executeAll(pendingSubtasks, {
			...this.config.workerConfig,
			...workerConfig,
			runId,
		});

		try {
			while (true) {
				if (workerConfig.signal?.aborted) {
					this.cancel();
					break;
				}
				while (eventQueue.length > 0) {
					const queuedEvent = eventQueue.shift();
					if (queuedEvent) yield queuedEvent;
				}
				if (
					this.eventStream.areAllTasksComplete(
						pendingSubtasks.map((t) => t.id),
						runId,
					)
				) {
					break;
				}
				await Promise.race([
					new Promise<void>((resolve) => {
						resolveWaiting = resolve;
					}),
					new Promise<void>((resolve) => setTimeout(resolve, 1000)),
				]);
			}

			const resumedResults = await executionPromise;
			const executionMs = Date.now() - executionStartedAt;
			const results = new Map([...storedResults, ...resumedResults]);
			const synthesisStartedAt = Date.now();
			const synthesis = await this.synthesize(
				{ ...decomposition, subtasks: allSubtasks },
				results,
			);
			const synthesisMs = Date.now() - synthesisStartedAt;
			const final = this.getFinalStatusFromSubtasks(allSubtasks);

			await this.workflowManager.updateRunStatus(workflowRunId, final.status, {
				currentPhase: "synthesis",
				metadata: {
					orchestratorRunId: runId,
					resumed: true,
					executionMs,
					synthesisMs,
					succeeded: final.succeeded,
					failed: final.failed,
					cancelled: final.cancelled,
				},
			});
			await this.workflowManager.recordEvent({
				runId: workflowRunId,
				agentId: this.baseConfig.id,
				eventType: "synthesis",
				message: synthesis.slice(0, 4000),
				metadata: final,
			});
			yield {
				type: "telemetry",
				data: {
					runId,
					workflowRunId,
					totalMs: Date.now() - startedAt,
					executionMs,
					synthesisMs,
					workerCount: pendingSubtasks.length,
					succeeded: final.succeeded,
					failed: final.failed,
					cancelled: final.cancelled,
				},
			};
			yield { type: "synthesis", result: synthesis };
		} finally {
			unsubscribe();
			this.eventStream.prune();
		}
	}

	/**
	 * Ejecutar todas las subtareas con workers paralelos.
	 * Retorna un async iterable de eventos para streaming al frontend.
	 */
	async *executeParallel(
		decomposition: TaskDecomposition,
		workerConfig: Partial<WorkerConfig> = {},
	): AsyncIterable<OrchestratorEvent> {
		const runId = workerConfig.runId ?? createRunId();
		const startedAt = Date.now();
		const workflowRun = this.workflowManager
			? await this.workflowManager.createRun({
					conversationId: workerConfig.channelId,
					rootAgentId: this.baseConfig.id,
					goal: decomposition.originalGoal,
					metadata: {
						runId,
						executionPlan: decomposition.executionPlan,
						reasoning: decomposition.reasoning,
					},
				})
			: null;
		if (workflowRun) {
			await this.workflowManager?.updateRunStatus(workflowRun.id, "running", {
				currentPhase: "decomposition",
			});
		}
		const workflowTaskBySubtask = new Map<string, string>();
		if (workflowRun && this.workflowManager) {
			for (const task of decomposition.subtasks) {
				const workflowTask = await this.workflowManager.createTask({
					runId: workflowRun.id,
					assignedAgentId: task.agentId,
					armKey: task.armKey,
					title: `${task.agentName ?? task.role}: ${task.description.slice(0, 80)}`,
					description: task.description,
					priority: task.priority,
					dependsOn: task.dependsOn,
					acceptanceCriteria: task.acceptanceCriteria,
					metadata: {
						sourceTaskId: task.id,
						role: task.role,
						agentId: task.agentId,
						agentName: task.agentName,
						armKey: task.armKey,
						avatar: task.avatar,
						color: task.color,
						toolScope: task.toolScope,
					},
				});
				workflowTaskBySubtask.set(task.id, workflowTask.id);
			}
			await this.workflowManager.recordEvent({
				runId: workflowRun.id,
				agentId: this.baseConfig.id,
				eventType: "decomposition",
				message: decomposition.reasoning,
				metadata: {
					orchestratorRunId: runId,
						subtasks: decomposition.subtasks.map((task) => ({
							id: task.id,
							workflowTaskId: workflowTaskBySubtask.get(task.id),
							armKey: task.armKey,
							agentId: task.agentId,
							agentName: task.agentName,
							avatar: task.avatar,
							color: task.color,
						})),
				},
			});
		}
		// Emitir la descomposición
		yield { type: "decomposition", data: decomposition };

		if (decomposition.subtasks.length === 0) {
			return; // Single agent mode — el caller debe manejar esto
		}

		// Suscribirse al event stream para re-emitir eventos
		const eventQueue: OrchestratorEvent[] = [];
		let resolveWaiting: (() => void) | null = null;
		const taskById = new Map(
			decomposition.subtasks.map((task) => [task.id, task]),
		);

		const unsubscribe = this.eventStream.subscribe((event) => {
			if (event.runId !== runId) return;
			let orchEvent: OrchestratorEvent | null = null;
			const workflowTaskId = workflowTaskBySubtask.get(event.taskId);
			const sourceTask = taskById.get(event.taskId);
			const agentMetadata = eventAgentMetadata(
				sourceTask,
				event.data.metadata,
			);
			if (workflowRun && this.workflowManager) {
				void this.workflowManager
					.recordEvent({
						runId: workflowRun.id,
						taskId: workflowTaskId,
						agentId: sourceTask?.agentId,
						eventType: event.type,
						message:
							event.data.message ?? event.data.error ?? event.data.toolResult,
						toolName: event.data.toolName,
						metadata: {
							orchestratorRunId: runId,
							sourceTaskId: event.taskId,
							workerId: event.workerId,
							progress: event.data.progress,
							...agentMetadata,
						},
					})
					.catch(() => undefined);
			}

			switch (event.type) {
				case "task_claimed":
					{
						const task = taskById.get(event.taskId);
						if (workflowTaskId && this.workflowManager) {
							void this.workflowManager
								.updateTaskStatus(workflowTaskId, "running", {
									stepKey: "claimed",
								})
								.catch(() => undefined);
						}
						orchEvent = {
							type: "worker_started",
							workerId: event.workerId,
							taskId: event.taskId,
							role: task?.role,
							description: task?.description || event.data.message || "",
							...agentMetadata,
						};
					}
					break;
				case "tool_used":
				case "progress":
				case "thinking":
				case "tool_result":
					orchEvent = {
						type: "worker_progress",
						workerId: event.workerId,
						taskId: event.taskId,
						message:
							event.data.message ||
							(event.type === "tool_result" && event.data.toolName
								? `Resultado de ${event.data.toolName}: ${event.data.toolResult || "recibido"}`
								: event.data.toolName || ""),
						progress: event.data.progress || 0,
						toolName: event.data.toolName,
						...agentMetadata,
					};
					break;
				case "result":
					if (workflowTaskId && this.workflowManager) {
						const artifacts = event.data.artifacts ?? [];
						const progressSignature = createProgressSignature({
							status: "done",
							stepKey: "result",
							artifacts,
							verifiedOutputs: [event.data.message ?? ""].filter(Boolean),
						});
						void this.workflowManager
							.updateTaskStatus(workflowTaskId, "done", {
								stepKey: "result",
								progressSignature,
							})
							.catch(() => undefined);
						for (const artifact of artifacts) {
							void this.workflowManager
								.recordArtifact({
									runId: workflowRun?.id ?? "",
									taskId: workflowTaskId,
									agentId: sourceTask?.agentId,
									artifactType: "media",
									url: artifact,
									existsVerified: true,
								})
								.catch(() => undefined);
						}
					}
					orchEvent = {
						type: "worker_done",
						workerId: event.workerId,
						taskId: event.taskId,
						result: event.data.message || "",
						...agentMetadata,
					};
					break;
				case "error":
					if (workflowTaskId && this.workflowManager) {
						void this.workflowManager
							.recordFailureAndDecideRetry({
								taskId: workflowTaskId,
								stepKey: event.data.toolName ?? "worker_error",
								progressSignature: createProgressSignature({
									status: "failed",
									stepKey: event.data.toolName ?? "worker_error",
								}),
								error: event.data.error || "Error desconocido",
								metadata: {
									orchestratorRunId: runId,
									sourceTaskId: event.taskId,
									workerId: event.workerId,
									...agentMetadata,
								},
							})
							.catch(() => undefined);
					}
					orchEvent = {
						type: "worker_error",
						workerId: event.workerId,
						taskId: event.taskId,
						error: event.data.error || "Error desconocido",
						...agentMetadata,
					};
					break;
			}

			if (orchEvent) {
				eventQueue.push(orchEvent);
				if (resolveWaiting) {
					resolveWaiting();
					resolveWaiting = null;
				}
			}
		});

		// Lanzar ejecución paralela (no-blocking)
		const executionPromise = this.workerPool.executeAll(
			decomposition.subtasks,
			{ ...this.config.workerConfig, ...workerConfig, runId },
		);
		const executionStartedAt = Date.now();

		// Emitir eventos mientras se ejecutan los workers
		try {
			while (true) {
				if (workerConfig.signal?.aborted) {
					this.cancel();
					break;
				}
				// Drenar la cola de eventos
				while (eventQueue.length > 0) {
					const queuedEvent = eventQueue.shift();
					if (queuedEvent) yield queuedEvent;
				}

				// Verificar si terminó
				const taskIds = decomposition.subtasks.map((t) => t.id);
				if (this.eventStream.areAllTasksComplete(taskIds, runId)) {
					break;
				}

				// Esperar al siguiente evento con timeout
				await Promise.race([
					new Promise<void>((resolve) => {
						resolveWaiting = resolve;
					}),
					new Promise<void>((resolve) => setTimeout(resolve, 1000)),
				]);
			}

			// Esperar a que termine la ejecución
			const results = await executionPromise;
			const executionMs = Date.now() - executionStartedAt;

			// Sintetizar resultados
			const synthesisStartedAt = Date.now();
			const synthesis = await this.synthesize(decomposition, results);
			const synthesisMs = Date.now() - synthesisStartedAt;
			const finalEvents = this.eventStream.query({ runId });
			const terminalByTask = new Map<string, string>();
			for (const event of finalEvents) {
				if (
					event.type === "result" ||
					event.type === "error" ||
					event.type === "cancelled" ||
					event.type === "blocked"
				) {
					terminalByTask.set(event.taskId, event.type);
				}
			}
			const succeeded = [...terminalByTask.values()].filter(
				(type) => type === "result",
			).length;
			const failed = [...terminalByTask.values()].filter(
				(type) => type === "error" || type === "blocked",
			).length;
			const cancelled = [...terminalByTask.values()].filter(
				(type) => type === "cancelled",
			).length;
			if (workflowRun && this.workflowManager) {
				const finalStatus =
					failed > 0 || cancelled > 0
						? succeeded > 0
							? "partial"
							: "failed"
						: "done";
				await this.workflowManager.updateRunStatus(
					workflowRun.id,
					finalStatus,
					{
						currentPhase: "synthesis",
						metadata: {
							orchestratorRunId: runId,
							executionMs,
							synthesisMs,
							succeeded,
							failed,
							cancelled,
						},
					},
				);
				await this.workflowManager.recordEvent({
					runId: workflowRun.id,
					agentId: this.baseConfig.id,
					eventType: "synthesis",
					message: synthesis.slice(0, 4000),
					metadata: { succeeded, failed, cancelled },
				});
			}
			yield {
				type: "telemetry",
				data: {
					runId,
					workflowRunId: workflowRun?.id,
					totalMs: Date.now() - startedAt,
					executionMs,
					synthesisMs,
					workerCount: decomposition.subtasks.length,
					succeeded,
					failed,
					cancelled,
				},
			};
			yield { type: "synthesis", result: synthesis };
		} finally {
			unsubscribe();
			this.eventStream.prune();
		}
	}

	/**
	 * Sintetizar los resultados de todos los workers en una respuesta coherente.
	 */
	async synthesize(
		decomposition: TaskDecomposition,
		results: Map<string, string>,
	): Promise<string> {
		if (results.size === 0) {
			return "No se obtuvieron resultados de los workers.";
		}

		if (results.size === 1) {
			return results.values().next().value || "";
		}

		// Keep synthesis bounded so chat can always close even if workers are verbose.
		const resultsSummary = decomposition.subtasks
			.map((task) => {
				const result = results.get(task.id) || "[sin resultado]";
				return [
					`## Resultado de "${task.role}" (${task.id})`,
					`Estado: ${task.status}`,
					`Tarea: ${task.description}`,
					"",
					result.slice(0, SYNTHESIS_RESULT_CHARS_PER_TASK),
				].join("\n");
			})
			.join("\n\n---\n\n");
		const taskStatusSummary = decomposition.subtasks
			.map((task) => `- ${task.id} (${task.role}): ${task.status}`)
			.join("\n");

		const request: LLMRequest = {
			model: this.baseConfig.model || "default",
			messages: [
				{
					role: "system",
					content: [
						"Eres un asistente que sintetiza resultados de múltiples agentes especializados.",
						"Combina los resultados en una respuesta unificada, coherente y bien organizada, pero preserva fielmente el estado real de cada subtarea.",
						"No inventes causas, artefactos, archivos, URLs, pruebas, timeouts ni resultados que no aparezcan explícitamente en los resultados recibidos.",
						"Si alguna subtarea está failed, cancelled, blocked, pending, claimed o running, el resultado global NO es completed; repórtalo como parcial/fallido/bloqueado según corresponda.",
						"No digas que un archivo, imagen, video, documento o entrega fue generado si no hay una ruta, URL o evidencia explícita en los resultados.",
						"Si hay un timeout o error, cita el mensaje exacto y qué subtarea lo produjo. No lo conviertas en una explicación especulativa.",
						"No repitas información redundante entre los resultados.",
						"Si hay conflictos entre resultados, señálalos explícitamente.",
						"Mantén todo el contenido valioso: URLs, código, datos extraídos, etc.",
					].join("\n"),
				},
				{
					role: "user",
					content: `Objetivo original del usuario: ${decomposition.originalGoal}\n\nEstados de subtareas:\n${taskStatusSummary}\n\nResultados de los ${results.size} agentes:\n\n${resultsSummary}`,
				},
			],
			maxTokens: Math.min(
				this.baseConfig.maxTokens ?? this.config.synthesisMaxTokens,
				this.config.synthesisMaxTokens,
			),
			temperature: 0.3,
		};

		try {
			const response = await withTimeout(
				this.llmRouter.chat(request),
				this.config.synthesisTimeoutMs,
			);
			return response.content || resultsSummary;
		} catch (err) {
			// Fallback: concatenar resultados
			const reason = err instanceof Error ? err.message : "synthesis failed";
			return `# Resultados combinados\n\nLa sintesis automatica no termino correctamente: ${reason}. Estos son los resultados verificados de los workers.\n\n${resultsSummary}`;
		}
	}

	/**
	 * Cancelar toda la ejecución en curso.
	 */
	cancel(): void {
		this.workerPool.cancelAll();
	}

	/**
	 * Obtener el event stream (para el frontend).
	 */
	getEventStream(): EventStream {
		return this.eventStream;
	}

	/**
	 * Número de workers activos.
	 */
	get activeWorkers(): number {
		return this.workerPool.activeCount;
	}

	/**
	 * Obtener el coordination bus (para acceso directo).
	 */
	getCoordinationBus(): AgentCoordinationBus {
		return this.coordinationBus;
	}

	/**
	 * Obtener el cross-review engine (para acceso directo).
	 */
	getCrossReviewEngine(): CrossReviewEngine {
		return this.crossReviewEngine;
	}

	/**
	 * Ejecutar subtareas en paralelo con cross-review entre agentes.
	 *
	 * Flujo completo de coordinacion independiente:
	 * 1. Ejecucion paralela (workers)
	 * 2. Publicacion de artefactos en el coordination bus
	 * 3. Asignacion de revisores pares
	 * 4. Cross-review (cada agente revisa el trabajo de otro)
	 * 5. Correccion automatica de problemas encontrados
	 * 6. Verificacion final por QA (Crabby)
	 * 7. Sintesis con resultados verificados
	 */
	async *executeParallelWithReview(
		decomposition: TaskDecomposition,
		workerConfig: Partial<WorkerConfig> = {},
	): AsyncIterable<OrchestratorEvent> {
		const runId = workerConfig.runId ?? createRunId();
		this.coordinationBus.clear();

		// Phase 1: Run parallel execution (yields all worker events)
		const workerResults = new Map<string, string>();
		for await (const event of this.executeParallel(
			decomposition,
			workerConfig,
		)) {
			if (event.type === "worker_done") {
				workerResults.set(event.taskId, event.result);
			}
			yield event;
		}

		// Phase 2: Publish artifacts to coordination bus
		for (const task of decomposition.subtasks) {
			const result = workerResults.get(task.id);
			if (result && task.status === "done") {
				this.coordinationBus.publishArtifact({
					taskId: task.id,
					taskRole: task.role,
					agentId: task.agentId ?? "unknown",
					agentName: task.agentName ?? task.role,
					armKey: task.armKey ?? "bibi",
					content: result,
				});
			}
		}

		const artifacts = this.coordinationBus.getAllArtifacts();
		if (artifacts.length === 0) return;

		// Phase 3: Assign peer reviewers
		const assignments =
			this.crossReviewEngine.assignReviewers(artifacts);
		yield {
			type: "review_started",
			data: {
				artifactCount: artifacts.length,
				reviewersAssigned: assignments.length,
			},
		};

		// Phase 4-6: Run cross-review cycle
		const reviewResult =
			await this.crossReviewEngine.runCrossReview(
				artifacts,
				decomposition.originalGoal,
				workerConfig.signal,
			);

		// Yield review events
		for (const artifact of this.coordinationBus.getAllArtifacts()) {
			for (const review of artifact.reviewResults) {
				yield {
					type: "review_completed",
					data: {
						taskId: artifact.taskId,
						reviewerName: review.reviewerName,
						verdict: review.verdict,
						issues: review.issues,
					},
				};
			}
			for (const correction of artifact.corrections) {
				yield {
					type: "correction_applied",
					data: {
						taskId: artifact.taskId,
						correctorName: correction.correctorName,
						reason: correction.reason,
					},
				};
			}
		}

		yield { type: "verification_phase", data: reviewResult };

		// Phase 7: Synthesize with verified/corrected results
		const verifiedResults = new Map<string, string>();
		for (const artifact of this.coordinationBus.getAllArtifacts()) {
			verifiedResults.set(artifact.taskId, artifact.content);
		}
		for (const [taskId, result] of workerResults) {
			if (!verifiedResults.has(taskId)) {
				verifiedResults.set(taskId, result);
			}
		}

		const synthesis = await this.synthesize(
			decomposition,
			verifiedResults,
		);
		yield {
			type: "telemetry",
			data: {
				runId,
				totalMs: 0,
				executionMs: 0,
				synthesisMs: 0,
				workerCount: decomposition.subtasks.length,
				succeeded: reviewResult.approved,
				failed: reviewResult.rejected,
				cancelled: 0,
			},
		};
		yield { type: "synthesis", result: synthesis };
	}
}
