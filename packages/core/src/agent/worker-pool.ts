/**
 * WorkerPool — Pool de agentes aislados para ejecución paralela.
 *
 * Cada worker es un AgentRuntime ligero con:
 * - Su propio contexto aislado (evita context collapse)
 * - Acceso completo a herramientas registradas, MCPs y contexto compartido
 * - Timeout y presupuesto de herramientas independientes
 * - Streaming de progreso en tiempo real al EventStream
 */

import type { LLMRouter } from "../ai/router.js";
import type { LLMMessage, LLMRequest, LLMToolCall } from "../ai/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { AgentEvent, EventStream } from "./event-stream.js";
import type { AgentConfig } from "./types.js";

export interface SubTask {
	id: string;
	description: string;
	role: string;
	toolScope: string[];
	fileScope?: string[];
	priority: number;
	status: "pending" | "claimed" | "running" | "done" | "failed" | "cancelled";
	result?: string;
	assignedWorkerId?: string;
	dependsOn?: string[];
}

export interface WorkerConfig {
	maxToolIterations: number;
	timeoutMs: number;
	model?: string;
	temperature?: number;
	systemPromptOverride?: string;
	sharedContext?: LLMMessage[];
	runId?: string;
	channelId?: string;
	usesZaiVisionToolForImages?: boolean;
	signal?: AbortSignal;
}

interface WorkerState {
	id: string;
	task: SubTask;
	config: WorkerConfig;
	messages: LLMMessage[];
	toolIterations: number;
	startedAt: number;
	abortController: AbortController;
	status: "idle" | "running" | "done" | "failed" | "cancelled";
}

const DEFAULT_WORKER_CONFIG: WorkerConfig = {
	maxToolIterations: 12,
	timeoutMs: 120_000, // 2 minutos
	temperature: 0.3,
};

function summarizeVisibleWorkerText(content: string, maxChars = 420): string {
	const cleaned = content
		.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "Planificando el siguiente paso.";
	return cleaned.length > maxChars
		? `${cleaned.slice(0, maxChars).trimEnd()}...`
		: cleaned;
}

export class WorkerPool {
	private workers: Map<string, WorkerState> = new Map();
	private maxConcurrent: number;
	private workerIdCounter = 0;

	constructor(
		private llmRouter: LLMRouter,
		private toolRegistry: ToolRegistry,
		private toolExecutor: ToolExecutor,
		private eventStream: EventStream,
		private baseConfig: AgentConfig,
		maxConcurrent = 5,
	) {
		this.maxConcurrent = maxConcurrent;
	}

	/**
	 * Generar un ID único para un worker.
	 */
	private nextWorkerId(): string {
		return `worker_${++this.workerIdCounter}_${Date.now()}`;
	}

	/**
	 * Construir el system prompt especializado para un worker.
	 */
	private buildWorkerSystemPrompt(task: SubTask, config: WorkerConfig): string {
		if (config.systemPromptOverride) return config.systemPromptOverride;

		const availableTools = this.toolRegistry
			.list()
			.map((tool) => `- ${tool.name}: ${tool.description}`)
			.join("\n");
		const recommendedTools =
			task.toolScope.length > 0
				? `\nHerramientas sugeridas por el orquestador para esta subtarea: ${task.toolScope.join(", ")}. Estas son sugerencias, NO restricciones.`
				: "";

		const fileScope = task.fileScope?.length
			? `\nSolo puedes operar en estos archivos/directorios: ${task.fileScope.join(", ")}.`
			: "";

		return [
			`Eres un worker especializado con el rol de "${task.role}".`,
			`Tu tarea específica es: ${task.description}`,
			"",
			"Tienes acceso completo a todas las herramientas registradas del sistema, incluyendo herramientas locales, MCPs, media, navegador y ejecución de código.",
			"La memoria, el perfil del usuario, aprendizajes operativos y skills relevantes se inyectan como contexto compartido cuando están disponibles. Si existe una herramienta explícita para consultar memoria o skills, puedes usarla; si no existe, usa el contexto proporcionado.",
			`Herramientas disponibles:\n${availableTools || "- No hay herramientas registradas."}`,
			recommendedTools,
			fileScope,
			"",
			"Reglas:",
			"- Enfócate SOLO en tu tarea asignada.",
			"- Sé eficiente: usa el mínimo de herramientas necesarias.",
			"- Si generas imágenes, audio o video con execute_code, guarda el archivo en el directorio actual del script con una extensión normal (.png, .jpg, .mp4, etc.). execute_code lo guardará automáticamente en la librería de media y devolverá una URL /api/media/file/...; usa esa URL directamente en tu resultado.",
			"- No instales dependencias pesadas para imágenes simples; prefiere SVG, Python estándar, PIL si ya está disponible, o código ligero.",
			"- Reporta tu resultado de forma concisa cuando termines.",
			`- Tienes un presupuesto máximo de ${config.maxToolIterations} iteraciones de herramientas.`,
			"- Si encuentras un bloqueo que no puedes resolver, reporta el error inmediatamente.",
		].join("\n");
	}

	/**
	 * Devolver todas las herramientas disponibles.
	 * toolScope se conserva como señal de recomendación para el prompt, no como restricción.
	 */
	private getScopedTools(_toolScope: string[]): ToolDefinition[] {
		const allTools = this.toolRegistry.list();
		return allTools;
	}

	/**
	 * Ejecutar un worker individual con streaming de progreso.
	 */
	async executeWorker(
		task: SubTask,
		config: Partial<WorkerConfig> = {},
	): Promise<string> {
		const fullConfig = { ...DEFAULT_WORKER_CONFIG, ...config };
		const workerId = this.nextWorkerId();
		const abortController = new AbortController();
		if (fullConfig.signal?.aborted) abortController.abort();
		const abortFromParent = () => abortController.abort();
		fullConfig.signal?.addEventListener("abort", abortFromParent, {
			once: true,
		});

		const state: WorkerState = {
			id: workerId,
			task,
			config: fullConfig,
			messages: [],
			toolIterations: 0,
			startedAt: Date.now(),
			abortController,
			status: "running",
		};

		this.workers.set(workerId, state);
		task.assignedWorkerId = workerId;
		task.status = "running";

		// Emitir evento de inicio
		this.eventStream.append({
			runId: fullConfig.runId,
			workerId,
			taskId: task.id,
			type: "task_claimed",
			data: {
				message: `Worker ${workerId} iniciando tarea: ${task.description.slice(0, 200)}`,
			},
		});

		const systemPrompt = this.buildWorkerSystemPrompt(task, fullConfig);
		const scopedTools = this.getScopedTools(task.toolScope);

		state.messages = [
			{ role: "system", content: systemPrompt },
			...(fullConfig.sharedContext ?? []),
			{ role: "user", content: task.description },
		];

		try {
			const result = await this.runWorkerLoop(state, scopedTools, fullConfig);
			if (abortController.signal.aborted || result.startsWith("[Cancelado]")) {
				state.status = "cancelled";
				task.status = "cancelled";
				this.eventStream.append({
					runId: fullConfig.runId,
					workerId,
					taskId: task.id,
					type: "cancelled",
					data: {
						message: "Worker cancelado.",
						durationMs: Date.now() - state.startedAt,
						toolIterations: state.toolIterations,
					},
				});
				return result;
			}
			state.status = "done";
			task.status = "done";
			task.result = result;

			this.eventStream.append({
				runId: fullConfig.runId,
				workerId,
				taskId: task.id,
				type: "result",
				data: {
					message: result.slice(0, 2000),
					durationMs: Date.now() - state.startedAt,
					toolIterations: state.toolIterations,
				},
			});

			return result;
		} catch (err) {
			state.status = "failed";
			task.status = "failed";
			const errorMsg = err instanceof Error ? err.message : String(err);

			this.eventStream.append({
				runId: fullConfig.runId,
				workerId,
				taskId: task.id,
				type: "error",
				data: {
					error: errorMsg,
					durationMs: Date.now() - state.startedAt,
					toolIterations: state.toolIterations,
				},
			});

			return `Error en tarea "${task.description}": ${errorMsg}`;
		} finally {
			fullConfig.signal?.removeEventListener("abort", abortFromParent);
			this.workers.delete(workerId);
		}
	}

	/**
	 * Loop principal del worker: LLM → tool calls → LLM → ... → respuesta final.
	 */
	private async runWorkerLoop(
		state: WorkerState,
		scopedTools: ToolDefinition[],
		config: WorkerConfig,
	): Promise<string> {
		const llmTools = scopedTools.map((t) => ({
			type: "function" as const,
			function: {
				name: t.name,
				description: t.description,
				parameters: {
					type: "object" as const,
					properties: Object.fromEntries(
						Object.entries(t.parameters).map(([key, param]) => [
							key,
							{ type: param.type, description: param.description },
						]),
					),
					required: Object.entries(t.parameters)
						.filter(([, param]) => param.required)
						.map(([key]) => key),
				},
			},
		}));

		while (state.toolIterations < config.maxToolIterations) {
			// Verificar timeout
			if (Date.now() - state.startedAt > config.timeoutMs) {
				return `[Timeout] La tarea excedió el límite de ${config.timeoutMs / 1000}s.`;
			}

			// Verificar cancelación
			if (state.abortController.signal.aborted || config.signal?.aborted) {
				return "[Cancelado] La tarea fue cancelada por el orquestador.";
			}

			this.eventStream.append({
				runId: config.runId,
				workerId: state.id,
				taskId: state.task.id,
				type: "thinking",
				data: {
					message: `Agente ${state.id} analizando la subtarea y decidiendo acciones.`,
					progress: Math.min(
						90,
						Math.round((state.toolIterations / config.maxToolIterations) * 100),
					),
				},
			});

			const request: LLMRequest = {
				model: config.model || this.baseConfig.model || "default",
				messages: state.messages,
				tools: llmTools.length > 0 ? llmTools : undefined,
				maxTokens: this.baseConfig.maxTokens,
				temperature: config.temperature,
			};

			const response = await this.llmRouter.chat(request);

			// Si no hay tool calls, el modelo terminó
			if (!response.toolCalls || response.toolCalls.length === 0) {
				return response.content || "[Sin respuesta del modelo]";
			}

			if (response.content?.trim()) {
				this.eventStream.append({
					runId: config.runId,
					workerId: state.id,
					taskId: state.task.id,
					type: "thinking",
					data: {
						message: summarizeVisibleWorkerText(response.content),
						progress: Math.min(
							90,
							Math.round(
								(state.toolIterations / config.maxToolIterations) * 100,
							),
						),
					},
				});
			}

			// Procesar tool calls
			state.messages.push({
				role: "assistant",
				content: response.content || "",
				toolCalls: response.toolCalls,
			});

			for (const toolCall of response.toolCalls) {
				state.toolIterations++;

				this.eventStream.append({
					runId: config.runId,
					workerId: state.id,
					taskId: state.task.id,
					type: "tool_used",
					data: {
						toolName: toolCall.function.name,
						message: `Usando ${toolCall.function.name}`,
						progress: Math.min(
							95,
							Math.round(
								(state.toolIterations / config.maxToolIterations) * 100,
							),
						),
					},
				});

				let resultContent: string;
				try {
					const params = JSON.parse(toolCall.function.arguments || "{}");
					const result = await this.toolExecutor.execute(
						toolCall.function.name,
						params,
						{
							model: config.model || this.baseConfig.model,
							usesZaiVisionToolForImages: config.usesZaiVisionToolForImages,
							workerId: state.id,
							taskId: state.task.id,
							role: state.task.role,
							channelId: config.channelId,
							runId: config.runId,
							toolScope: state.task.toolScope,
							fileScope: state.task.fileScope,
							abortSignal: state.abortController.signal,
						},
					);
					resultContent = result.output || "[Sin resultado]";
				} catch (err) {
					resultContent = `Error ejecutando ${toolCall.function.name}: ${err instanceof Error ? err.message : String(err)}`;
				}

				state.messages.push({
					role: "tool",
					content: resultContent.slice(0, 12000), // Limitar resultado para no saturar contexto
					toolCallId: toolCall.id,
				});

				this.eventStream.append({
					runId: config.runId,
					workerId: state.id,
					taskId: state.task.id,
					type: "tool_result",
					data: {
						toolName: toolCall.function.name,
						toolResult: resultContent.slice(0, 500),
						progress: Math.min(
							95,
							Math.round(
								(state.toolIterations / config.maxToolIterations) * 100,
							),
						),
					},
				});
			}
		}

		// Budget agotado — pedir respuesta final
		state.messages.push({
			role: "system",
			content:
				"Has agotado tu presupuesto de herramientas. Responde ahora con lo que hayas conseguido.",
		});

		const finalResponse = await this.llmRouter.chat({
			model: config.model || this.baseConfig.model || "default",
			messages: state.messages,
			maxTokens: this.baseConfig.maxTokens,
			temperature: config.temperature,
		});

		return finalResponse.content || "[Budget agotado sin respuesta]";
	}

	/**
	 * Ejecutar múltiples tareas en paralelo con límite de concurrencia.
	 */
	async executeAll(
		tasks: SubTask[],
		config: Partial<WorkerConfig> = {},
	): Promise<Map<string, string>> {
		const results = new Map<string, string>();

		// Separar tareas con y sin dependencias
		const ready: SubTask[] = [];
		const pending: SubTask[] = [];

		for (const task of tasks) {
			if (!task.dependsOn || task.dependsOn.length === 0) {
				ready.push(task);
			} else {
				pending.push(task);
			}
		}

		// Ejecutar tareas sin dependencias en paralelo (con límite de concurrencia)
		const executeReadyBatch = async (batch: SubTask[]) => {
			const chunks: SubTask[][] = [];
			for (let i = 0; i < batch.length; i += this.maxConcurrent) {
				chunks.push(batch.slice(i, i + this.maxConcurrent));
			}

			for (const chunk of chunks) {
				const promises = chunk.map((task) =>
					this.executeWorker(task, config).then((result) => {
						results.set(task.id, result);
					}),
				);
				await Promise.allSettled(promises);
			}
		};

		await executeReadyBatch(ready);

		// Ejecutar tareas con dependencias en orden
		const completedTaskIds = new Set(results.keys());
		let maxPasses = pending.length + 1; // Evitar loops infinitos

		while (pending.length > 0 && maxPasses-- > 0) {
			const nowReady: SubTask[] = [];
			const stillPending: SubTask[] = [];

			for (const task of pending) {
				const dependsOn = task.dependsOn ?? [];
				const depsCompleted = dependsOn.every((dep) =>
					completedTaskIds.has(dep),
				);
				if (depsCompleted) {
					// Inyectar resultados de dependencias en la descripción
					const depResults = dependsOn
						.map(
							(dep) =>
								`[Resultado de tarea ${dep}]: ${results.get(dep)?.slice(0, 500) || "sin resultado"}`,
						)
						.join("\n");
					task.description = `${task.description}\n\nContexto de tareas previas:\n${depResults}`;
					nowReady.push(task);
				} else {
					stillPending.push(task);
				}
			}

			if (nowReady.length === 0) {
				// Dependencias irresolubles
				for (const task of stillPending) {
					task.status = "failed";
					const message = `[Bloqueado] Dependencias no resueltas: ${task.dependsOn?.join(", ")}`;
					results.set(task.id, message);
					this.eventStream.append({
						runId: config.runId,
						workerId: task.assignedWorkerId ?? "unassigned",
						taskId: task.id,
						type: "blocked",
						data: { message, error: message },
					});
				}
				break;
			}

			await executeReadyBatch(nowReady);
			for (const task of nowReady) {
				completedTaskIds.add(task.id);
			}
			pending.length = 0;
			pending.push(...stillPending);
		}

		return results;
	}

	/**
	 * Cancelar un worker específico.
	 */
	cancelWorker(workerId: string): boolean {
		const worker = this.workers.get(workerId);
		if (!worker) return false;
		worker.abortController.abort();
		worker.status = "cancelled";
		worker.task.status = "cancelled";
		this.eventStream.append({
			runId: worker.config.runId,
			workerId,
			taskId: worker.task.id,
			type: "cancelled",
			data: { message: "Worker cancelado por el orquestador." },
		});
		return true;
	}

	/**
	 * Cancelar todos los workers activos.
	 */
	cancelAll(): void {
		for (const [workerId] of this.workers) {
			this.cancelWorker(workerId);
		}
	}

	/**
	 * Número de workers activos.
	 */
	get activeCount(): number {
		return this.workers.size;
	}

	/**
	 * IDs de workers activos.
	 */
	get activeWorkerIds(): string[] {
		return Array.from(this.workers.keys());
	}
}
