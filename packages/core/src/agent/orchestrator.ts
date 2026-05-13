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
import type { AgentConfig } from "./types.js";
import { EventStream } from "./event-stream.js";
import { WorkerPool, type SubTask, type WorkerConfig } from "./worker-pool.js";

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
	| { type: "worker_started"; workerId: string; taskId: string; description: string }
	| { type: "worker_progress"; workerId: string; taskId: string; message: string; progress: number }
	| { type: "worker_done"; workerId: string; taskId: string; result: string }
	| { type: "worker_error"; workerId: string; taskId: string; error: string }
	| { type: "synthesis"; result: string };

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
	maxWorkers: 5,
	workerConfig: {},
	complexityThreshold: 5,
};

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
6. Un máximo de MAX_WORKERS subtareas paralelas.`;

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
		// Heurísticas rápidas antes de llamar al LLM
		const indicators = [
			/\by\b.*\by\b.*\by\b/i,                    // "haz X y Y y Z"
			/\b(además|también|aparte|simultáneamente)\b/i,
			/\b(multiple|varios|diferentes|distintos)\b/i,
			/\b(parallel|paralelo|simultáneo)\b/i,
			/\b(investiga|busca).*\b(escribe|genera|crea)\b/i,
			/\b(and|then|also|while)\b.*\b(and|then|also|while)\b/i,
		];

		const heuristicScore = indicators.filter((re) => re.test(message)).length;
		if (heuristicScore >= 2) return true;
		if (message.length < 100) return false; // Mensajes cortos → single agent

		return false; // Por defecto, single agent
	}

	/**
	 * Descomponer un objetivo del usuario en subtareas paralelas.
	 */
	async decompose(goal: string): Promise<TaskDecomposition> {
		const prompt = DECOMPOSITION_PROMPT
			.replace("THRESHOLD", String(this.config.complexityThreshold))
			.replace("MAX_WORKERS", String(this.config.maxWorkers));

		const request: LLMRequest = {
			model: this.config.decompositionModel || this.baseConfig.model || "default",
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
				return this.singleTaskFallback(goal, "No se pudo parsear la descomposición");
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
			if (parsed.complexity <= this.config.complexityThreshold || parsed.subtasks.length <= 1) {
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
			return this.singleTaskFallback(goal, "Error parseando respuesta de descomposición");
		}
	}

	/**
	 * Fallback: ejecutar como una sola tarea (sin multi-agent).
	 */
	private singleTaskFallback(goal: string, reasoning: string): TaskDecomposition {
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
	async *executeParallel(decomposition: TaskDecomposition): AsyncIterable<OrchestratorEvent> {
		// Emitir la descomposición
		yield { type: "decomposition", data: decomposition };

		if (decomposition.subtasks.length === 0) {
			return; // Single agent mode — el caller debe manejar esto
		}

		// Suscribirse al event stream para re-emitir eventos
		const eventQueue: OrchestratorEvent[] = [];
		let resolveWaiting: (() => void) | null = null;

		const unsubscribe = this.eventStream.subscribe((event) => {
			let orchEvent: OrchestratorEvent | null = null;

			switch (event.type) {
				case "task_claimed":
					orchEvent = {
						type: "worker_started",
						workerId: event.workerId,
						taskId: event.taskId,
						description: event.data.message || "",
					};
					break;
				case "tool_used":
				case "progress":
					orchEvent = {
						type: "worker_progress",
						workerId: event.workerId,
						taskId: event.taskId,
						message: event.data.message || event.data.toolName || "",
						progress: event.data.progress || 0,
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
			this.config.workerConfig,
		);

		// Emitir eventos mientras se ejecutan los workers
		try {
			while (true) {
				// Drenar la cola de eventos
				while (eventQueue.length > 0) {
					yield eventQueue.shift()!;
				}

				// Verificar si terminó
				const taskIds = decomposition.subtasks.map((t) => t.id);
				if (this.eventStream.areAllTasksComplete(taskIds)) {
					break;
				}

				// Esperar al siguiente evento con timeout
				await Promise.race([
					new Promise<void>((resolve) => { resolveWaiting = resolve; }),
					new Promise<void>((resolve) => setTimeout(resolve, 1000)),
				]);
			}

			// Esperar a que termine la ejecución
			const results = await executionPromise;

			// Sintetizar resultados
			const synthesis = await this.synthesize(decomposition, results);
			yield { type: "synthesis", result: synthesis };
		} finally {
			unsubscribe();
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
