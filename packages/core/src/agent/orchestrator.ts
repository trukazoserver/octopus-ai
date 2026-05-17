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
import { EventStream } from "./event-stream.js";
import type { AgentConfig } from "./types.js";
import { type SubTask, type WorkerConfig, WorkerPool } from "./worker-pool.js";

export interface TaskDecomposition {
	originalGoal: string;
	subtasks: SubTask[];
	executionPlan: "parallel" | "sequential" | "mixed";
	reasoning: string;
}

export interface OrchestratorConfig {
	maxWorkers: number;
	workerConfig: Partial<WorkerConfig>;
	/** Umbral mínimo de complejidad para activar multi-agent (1-10) */
	complexityThreshold: number;
	/** Modelo específico para la descomposición (puede ser diferente al de los workers) */
	decompositionModel?: string;
}

export type OrchestratorEvent =
	| { type: "decomposition"; data: TaskDecomposition }
	| {
			type: "worker_started";
			workerId: string;
			taskId: string;
			role?: string;
			description: string;
	  }
	| {
			type: "worker_progress";
			workerId: string;
			taskId: string;
			message: string;
			progress: number;
			toolName?: string;
	  }
	| { type: "worker_done"; workerId: string; taskId: string; result: string }
	| { type: "worker_error"; workerId: string; taskId: string; error: string }
	| { type: "telemetry"; data: OrchestratorTelemetry }
	| { type: "synthesis"; result: string };

export interface OrchestratorTelemetry {
	runId: string;
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
};

function createRunId(): string {
	return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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
4. Los roles disponibles son: researcher, coder, browser-navigator, analyst, writer.
5. Los toolScopes posibles incluyen: shell, read_file, write_file, browser_navigate, browser_click, browser_read_page, browser_screenshot, browser_observe, browser_snapshot, browser_eval, execute_code, web_search, save_media, image-url-to-base64.
6. toolScope es una recomendación de herramientas prioritarias para cada worker, NO una restricción. Todos los workers tendrán acceso completo a las herramientas registradas, MCPs, memoria, skills y contexto compartido disponibles en el sistema.
7. Para subtareas de generación programática de imágenes/audio/video, incluye SIEMPRE execute_code en toolScope. execute_code auto-guarda archivos media generados si el worker los escribe en el directorio actual del script; save_media solo es necesario si el worker ya tiene base64 o una fuente externa.
8. Un máximo de MAX_WORKERS subtareas paralelas.`;

export class OctopusOrchestrator {
	private eventStream: EventStream;
	private workerPool: WorkerPool;
	private config: OrchestratorConfig;

	constructor(
		private llmRouter: LLMRouter,
		private toolRegistry: ToolRegistry,
		private toolExecutor: ToolExecutor,
		private baseConfig: AgentConfig,
		config: Partial<OrchestratorConfig> = {},
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
		);
	}

	/**
	 * Evaluar si una tarea necesita descomposición multi-agente.
	 */
	async shouldDecompose(message: string): Promise<boolean> {
		// Octopus trabaja solo por defecto. El multiagente solo se activa cuando
		// hay señales fuertes de 2+ tareas independientes que pueden correr a la vez.
		const explicitParallel =
			/\b(paralel[oa]s?|parallel|simult[aá]ne[oa]s?|a la vez|en paralelo|multiagente|subagentes|varios agentes|m[uú]ltiples agentes)\b/i.test(
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

		const response = await this.llmRouter.chat(request);
		const content = response.content || "";

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
				.map((st) => ({
					...st,
					status: "pending" as const,
					dependsOn: st.dependsOn?.length ? st.dependsOn : undefined,
				}));

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

			switch (event.type) {
				case "task_claimed":
					{
						const task = taskById.get(event.taskId);
						orchEvent = {
							type: "worker_started",
							workerId: event.workerId,
							taskId: event.taskId,
							role: task?.role,
							description: task?.description || event.data.message || "",
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
					};
					break;
				case "result":
					orchEvent = {
						type: "worker_done",
						workerId: event.workerId,
						taskId: event.taskId,
						result: event.data.message || "",
					};
					break;
				case "error":
					orchEvent = {
						type: "worker_error",
						workerId: event.workerId,
						taskId: event.taskId,
						error: event.data.error || "Error desconocido",
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
			yield {
				type: "telemetry",
				data: {
					runId,
					totalMs: Date.now() - startedAt,
					executionMs,
					synthesisMs,
					workerCount: decomposition.subtasks.length,
					succeeded: [...terminalByTask.values()].filter(
						(type) => type === "result",
					).length,
					failed: [...terminalByTask.values()].filter(
						(type) => type === "error" || type === "blocked",
					).length,
					cancelled: [...terminalByTask.values()].filter(
						(type) => type === "cancelled",
					).length,
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

		// Construir contexto con todos los resultados
		const resultsSummary = decomposition.subtasks
			.map((task) => {
				const result = results.get(task.id) || "[sin resultado]";
				return `## Resultado de "${task.role}" (${task.id})\nTarea: ${task.description}\n\n${result.slice(0, 3000)}`;
			})
			.join("\n\n---\n\n");

		const request: LLMRequest = {
			model: this.baseConfig.model || "default",
			messages: [
				{
					role: "system",
					content: [
						"Eres un asistente que sintetiza resultados de múltiples agentes especializados.",
						"Combina los resultados en una respuesta unificada, coherente y bien organizada.",
						"No repitas información redundante entre los resultados.",
						"Si hay conflictos entre resultados, señálalos explícitamente.",
						"Mantén todo el contenido valioso: URLs, código, datos extraídos, etc.",
					].join("\n"),
				},
				{
					role: "user",
					content: `Objetivo original del usuario: ${decomposition.originalGoal}\n\nResultados de los ${results.size} agentes:\n\n${resultsSummary}`,
				},
			],
			maxTokens: this.baseConfig.maxTokens,
			temperature: 0.3,
		};

		try {
			const response = await this.llmRouter.chat(request);
			return response.content || resultsSummary;
		} catch {
			// Fallback: concatenar resultados
			return `# Resultados combinados\n\n${resultsSummary}`;
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
}
