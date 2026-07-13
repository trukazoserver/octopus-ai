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
import type { DeliveryContext } from "../delivery/context.js";
import { asBackgroundDeliveryContext } from "../delivery/context.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { AgentEvent, EventStream } from "./event-stream.js";
import {
	DEFAULT_TOOL_LOOP_GUARDRAILS_CONFIG,
	ToolLoopGuardrails,
} from "./tool-loop-guardrails.js";
import type { AgentConfig } from "./types.js";

const STATUS_RE =
	/^\x00STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?\x00$/;

/**
 * Delay (ms) between consecutive worker starts inside a concurrency chunk.
 * Staggers parallel workers so they don't all hit the provider API at the
 * same instant and trip rate limits (HTTP 429). Tunable via env.
 */
const WORKER_STAGGER_MS =
	Number.parseInt(process.env.OCTOPUS_WORKER_STAGGER_MS ?? "300", 10) || 300;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LiveAgentRuntime {
	processMessageStream?(
		message: string,
		channelId?: string,
		options?: {
			signal?: AbortSignal;
			disableOrchestrator?: boolean;
			disableDelegation?: boolean;
			delegationContext?: {
				workerId: string;
				taskId: string;
				role?: string;
				runId?: string;
				toolScope?: string[];
				fileScope?: string[];
			};
		},
	): AsyncIterable<string>;
	processMessage?(
		message: string,
		channelId?: string,
		options?: {
			signal?: AbortSignal;
			disableOrchestrator?: boolean;
			disableDelegation?: boolean;
			delegationContext?: {
				workerId: string;
				taskId: string;
				role?: string;
				runId?: string;
				toolScope?: string[];
				fileScope?: string[];
			};
		},
	): Promise<string>;
}

export interface WorkerPoolOptions {
	getAgentRuntime?: (agentId: string, conversationId?: string) => LiveAgentRuntime | undefined;
	releaseWorkerResources?: (workerId: string) => Promise<void>;
}

export interface SubTask {
	id: string;
	description: string;
	role: string;
	agentId?: string;
	agentName?: string;
	armKey?: string;
	avatar?: string;
	color?: string;
	model?: string;
	acceptanceCriteria?: string[];
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
	deliveryContext?: DeliveryContext;
	usesZaiVisionToolForImages?: boolean;
	signal?: AbortSignal;
	/**
	 * Aggregate iteration cap shared across ALL workers in one executeAll run
	 * (sum of every worker's toolIterations). When reached, in-flight workers
	 * stop and no further arms are dispatched. HermesAgent-aligned run budget.
	 * Not a cost cap — iterations only.
	 */
	maxIterationsPerRun?: number;
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

function isTerminalFailureResult(result: string): boolean {
	return /^\s*(?:\[Timeout\]|\[Cancelado\]|Error\b|Error en tarea\b)/i.test(
		result,
	);
}

export class WorkerPool {
	private workers: Map<string, WorkerState> = new Map();
	private maxConcurrent: number;
	private workerIdCounter = 0;
	/**
	 * Shared aggregate-iteration budget for the current executeAll run. Each
	 * tool-loop worker increments `used`; on reaching `max`, in-flight workers
	 * stop and dispatch halts. Mirrors HermesAgent's per-run iteration budget.
	 */
	private activeRunBudget: {
		used: number;
		max: number;
		exhausted: boolean;
	} = { used: 0, max: Number.POSITIVE_INFINITY, exhausted: false };

	constructor(
		private llmRouter: LLMRouter,
		private toolRegistry: ToolRegistry,
		private toolExecutor: ToolExecutor,
		private eventStream: EventStream,
		private baseConfig: AgentConfig,
		maxConcurrent = 5,
		private options: WorkerPoolOptions = {},
	) {
		this.maxConcurrent = maxConcurrent;
	}

	/** Aggregate toolIterations consumed by the last executeAll run. */
	getLastRunIterations(): number {
		return this.activeRunBudget.used;
	}

	/** True when the last executeAll run drained its aggregate iteration budget. */
	isRunBudgetExhausted(): boolean {
		return this.activeRunBudget.exhausted;
	}

	/**
	 * Generar un ID único para un worker.
	 */
	private nextWorkerId(): string {
		return `worker_${++this.workerIdCounter}_${Date.now()}`;
	}

	private taskMetadata(
		task: SubTask,
		activity: string,
		extra: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			activity,
			agentId: task.agentId,
			agentName: task.agentName,
			armKey: task.armKey,
			avatar: task.avatar,
			color: task.color,
			...extra,
		};
	}

	private decodeStatusField(value: string | undefined): string | null {
		if (!value) return null;
		try {
			return Buffer.from(value, "base64").toString("utf8");
		} catch {
			return null;
		}
	}

	private buildLiveAgentPrompt(task: SubTask): string {
		return [
			"Subtarea asignada por Octavio, orquestador raiz.",
			`Brazo/agente vivo: ${task.agentName ?? task.agentId ?? task.role}.`,
			`Rol asignado: ${task.role}.`,
			task.armKey ? `Arm key: ${task.armKey}.` : "",
			`Objetivo especifico: ${task.description}`,
			task.acceptanceCriteria?.length
				? `Criterios de aceptacion:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
				: "",
			task.toolScope.length > 0
				? `Herramientas sugeridas por Octavio: ${task.toolScope.join(", ")}. Son sugerencias, no restricciones.`
				: "",
			"No delegues esta subtarea a otros agentes. Si necesitas apoyo, reporta el bloqueo y tu avance verificable a Octavio.",
			"Responde como agente vivo completo: analiza, usa memoria/habilidades/herramientas si hacen falta, verifica y entrega resultado concreto.",
		]
			.filter(Boolean)
			.join("\n\n");
	}

	private async runLiveAgentRuntime(
		state: WorkerState,
		config: WorkerConfig,
		runtime: LiveAgentRuntime,
	): Promise<string> {
		const task = state.task;
		const prompt = this.buildLiveAgentPrompt(task);
		const runtimeOptions = {
			signal: state.abortController.signal,
			disableOrchestrator: true,
			disableDelegation: true,
			delegationContext: {
				workerId: state.id,
				taskId: task.id,
				role: task.role,
				runId: config.runId,
				toolScope: task.toolScope,
				fileScope: task.fileScope,
			},
			deliveryContext: asBackgroundDeliveryContext(config.deliveryContext),
		};
		this.eventStream.append({
			runId: config.runId,
			workerId: state.id,
			taskId: task.id,
			type: "thinking",
			data: {
				message: `${task.agentName ?? state.id} analizando como agente vivo.`,
				progress: 5,
				metadata: this.taskMetadata(task, "live_agent_runtime", {
					liveAgentRuntime: true,
				}),
			},
		});

		if (runtime.processMessageStream) {
			let result = "";
			for await (const chunk of runtime.processMessageStream(
				prompt,
				config.channelId,
				runtimeOptions,
			)) {
				if (state.abortController.signal.aborted || config.signal?.aborted) {
					return "[Cancelado] La tarea fue cancelada por el orquestador.";
				}
				const statusMatch = chunk.match(STATUS_RE);
				if (statusMatch) {
					const status = statusMatch[1] ?? "status";
					const toolName = statusMatch[2] || undefined;
					const detail = this.decodeStatusField(statusMatch[4]);
					const message =
						detail || toolName || `${task.agentName ?? state.id} activo.`;
					if (status === "tool" || status === "code") {
						this.eventStream.append({
							runId: config.runId,
							workerId: state.id,
							taskId: task.id,
							type: "tool_used",
							data: {
								toolName,
								message,
								progress: 50,
								metadata: this.taskMetadata(task, status, {
									liveAgentRuntime: true,
								}),
							},
						});
					} else if (status === "tool_done") {
						this.eventStream.append({
							runId: config.runId,
							workerId: state.id,
							taskId: task.id,
							type: "tool_result",
							data: {
								toolName,
								toolResult: message.slice(0, 500),
								progress: 75,
								metadata: this.taskMetadata(task, "tool_result", {
									liveAgentRuntime: true,
								}),
							},
						});
					} else if (status === "thinking" || status === "responding") {
						this.eventStream.append({
							runId: config.runId,
							workerId: state.id,
							taskId: task.id,
							type: "thinking",
							data: {
								message,
								progress: status === "responding" ? 90 : 25,
								metadata: this.taskMetadata(task, status, {
									liveAgentRuntime: true,
								}),
							},
						});
					}
					continue;
				}
				result += chunk;
			}
			return result.trim() || "[Sin respuesta del agente vivo]";
		}

		if (runtime.processMessage) {
			return runtime.processMessage(prompt, config.channelId, runtimeOptions);
		}
		return "[Sin runtime ejecutable para el agente vivo]";
	}

	/**
	 * Construir el system prompt especializado para un worker.
	 */
	private buildWorkerSystemPrompt(task: SubTask, config: WorkerConfig): string {
		if (config.systemPromptOverride) return config.systemPromptOverride;

		const availableTools = this.getScopedTools(task.toolScope)
			.map((tool) => `- ${tool.name}: ${tool.description}`)
			.join("\n");
		const recommendedTools =
			task.toolScope.length > 0
				? `\nHerramientas sugeridas por el orquestador para esta subtarea: ${task.toolScope.join(", ")}. Estas son sugerencias, NO restricciones.`
				: "";

		const fileScope = task.fileScope?.length
			? `\nSolo puedes operar en estos archivos/directorios: ${task.fileScope.join(", ")}.`
			: "";
		const usesBrowser =
			task.role === "researcher" ||
			task.role === "browser-navigator" ||
			task.toolScope.some((tool) => tool.startsWith("browser_"));

		return [
			`Eres ${task.agentName ?? "un worker especializado"} con el rol de "${task.role}".`,
			task.armKey ? `Identidad de brazo Octopus: ${task.armKey}.` : "",
			`Tu tarea específica es: ${task.description}`,
			task.acceptanceCriteria?.length
				? `Criterios de aceptacion verificables:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
				: "",
			"",
			"Tienes acceso completo a todas las herramientas registradas del sistema, incluyendo herramientas locales, MCPs, media, navegador y ejecución de código.",
			"La memoria, el perfil del usuario, aprendizajes operativos y skills relevantes se inyectan como contexto compartido cuando están disponibles. Si existe una herramienta explícita para consultar memoria o skills, puedes usarla; si no existe, usa el contexto proporcionado.",
			`Herramientas disponibles:\n${availableTools || "- No hay herramientas registradas."}`,
			recommendedTools,
			fileScope,
			"",
			"Reglas:",
			"- Enfócate SOLO en tu tarea asignada.",
			"- No delegues esta subtarea a otros agentes/workers. Si necesitas ayuda adicional, reporta el bloqueo o el resultado parcial al orquestador.",
			"- Sé eficiente: usa el mínimo de herramientas necesarias.",
			"- Si generas imágenes, audio o video con execute_code, guarda el archivo en el directorio actual del script con una extensión normal (.png, .jpg, .mp4, etc.). execute_code lo guardará automáticamente en la librería de media y devolverá una URL /api/media/file/...; usa esa URL directamente en tu resultado.",
			"- No instales dependencias pesadas para imágenes simples; prefiere SVG, Python estándar, PIL si ya está disponible, o código ligero.",
			"- Reporta tu resultado de forma concisa cuando termines.",
			`- Tienes un presupuesto máximo de ${config.maxToolIterations} iteraciones de herramientas.`,
			"- Si encuentras un bloqueo que no puedes resolver, reporta el error inmediatamente.",
			usesBrowser
				? "- Tu navegador nativo está aislado para este worker. Navega, espera la preparación de render, usa siempre el snapshot más reciente, verifica cada cambio observable y toma capturas fullPage solo después de que lazy-load, fuentes e imágenes estén estables. No reutilices UIDs ni estado de navegador de otros workers."
				: "",
		].join("\n");
	}

	/**
	 * Devolver todas las herramientas disponibles.
	 * toolScope se conserva como señal de recomendación para el prompt, no como restricción.
	 */
	private getScopedTools(_toolScope: string[]): ToolDefinition[] {
		const allTools = this.toolRegistry.list();
		return allTools.filter(
			(tool) =>
				tool.name !== "delegate_task" &&
				!(
					tool.metadata?.statefulBrowser === true &&
					tool.metadata?.workerIsolated !== true
				),
		);
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
				metadata: this.taskMetadata(task, "claimed"),
			},
		});

		const liveRuntime = task.agentId
			? this.options.getAgentRuntime?.(task.agentId, fullConfig.channelId)
			: undefined;
		const systemPrompt = liveRuntime
			? ""
			: this.buildWorkerSystemPrompt(task, fullConfig);
		const scopedTools = liveRuntime ? [] : this.getScopedTools(task.toolScope);

		state.messages = liveRuntime
			? []
			: [
					{ role: "system", content: systemPrompt },
					...(fullConfig.sharedContext ?? []),
					{ role: "user", content: task.description },
				];

		try {
			const result = liveRuntime
				? await this.runLiveAgentRuntime(state, fullConfig, liveRuntime)
				: await this.runWorkerLoop(state, scopedTools, fullConfig);
			if (abortController.signal.aborted || result.startsWith("[Cancelado]")) {
				state.status = "cancelled";
				task.status = "cancelled";
				task.result = result;
				this.eventStream.append({
					runId: fullConfig.runId,
					workerId,
					taskId: task.id,
					type: "cancelled",
					data: {
						message: "Worker cancelado.",
						durationMs: Date.now() - state.startedAt,
						toolIterations: state.toolIterations,
						metadata: this.taskMetadata(task, "cancelled"),
					},
				});
				return result;
			}
			if (isTerminalFailureResult(result)) {
				state.status = "failed";
				task.status = "failed";
				task.result = result;

				this.eventStream.append({
					runId: fullConfig.runId,
					workerId,
					taskId: task.id,
					type: "error",
					data: {
						error: result,
						message: result,
						durationMs: Date.now() - state.startedAt,
						toolIterations: state.toolIterations,
						metadata: this.taskMetadata(task, "error"),
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
					metadata: this.taskMetadata(task, "result"),
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
					metadata: this.taskMetadata(task, "error"),
				},
			});

			return `Error en tarea "${task.description}": ${errorMsg}`;
		} finally {
			fullConfig.signal?.removeEventListener("abort", abortFromParent);
			await this.options.releaseWorkerResources?.(workerId).catch(() => {});
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

		// Tool-loop guardrails: workers are unattended, so hard-stop (circuit
		// break) when a tool loops unproductively instead of burning the budget.
		const guardrails = new ToolLoopGuardrails({
			...DEFAULT_TOOL_LOOP_GUARDRAILS_CONFIG,
			hardStopEnabled: true,
			workerHardStopEnabled: true,
		});
		let guardBlocked = false;

		while (state.toolIterations < config.maxToolIterations) {
			// Run-level aggregate iteration budget (HermesAgent-style run cap).
			if (this.activeRunBudget.exhausted) {
				return `[Budget] Presupuesto de iteraciones del run agotado (${this.activeRunBudget.max}).`;
			}
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
					metadata: this.taskMetadata(state.task, "thinking"),
				},
			});

			const request: LLMRequest = {
				model:
					state.task.model ||
					config.model ||
					this.baseConfig.model ||
					"default",
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
						metadata: this.taskMetadata(state.task, "thinking"),
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
				this.activeRunBudget.used++;
				if (
					!this.activeRunBudget.exhausted &&
					this.activeRunBudget.used >= this.activeRunBudget.max
				) {
					this.activeRunBudget.exhausted = true;
				}

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
						metadata: this.taskMetadata(state.task, "tool_used"),
					},
				});

				let resultContent: string;
				const paramsSignature = toolCall.function.arguments || "";
				const guardSkip = guardrails.beforeCall(
					toolCall.function.name,
					paramsSignature,
				);
				let toolSucceeded = false;
				if (guardSkip.skip) {
					resultContent = guardSkip.reason;
				} else {
					try {
						const params = JSON.parse(toolCall.function.arguments || "{}");
						const result = await this.toolExecutor.execute(
							toolCall.function.name,
							params,
							{
								agentId: state.task.agentId ?? this.baseConfig.id,
								model:
									state.task.model || config.model || this.baseConfig.model,
								usesZaiVisionToolForImages: config.usesZaiVisionToolForImages,
								workerId: state.id,
								taskId: state.task.id,
								role: state.task.role,
								channelId: config.channelId,
								runId: config.runId,
								toolScope: state.task.toolScope,
								fileScope: state.task.fileScope,
								deliveryContext: asBackgroundDeliveryContext(
									config.deliveryContext,
								),
								abortSignal: state.abortController.signal,
							},
						);
						toolSucceeded = !!result.success;
						resultContent = result.output || "[Sin resultado]";
					} catch (err) {
						resultContent = `Error ejecutando ${toolCall.function.name}: ${err instanceof Error ? err.message : String(err)}`;
					}
				}

				// Tool-loop guardrails: warn / hard-stop on unproductive loops.
				if (!guardSkip.skip) {
					const verdict = guardrails.recordOutcome(
						{
							toolName: toolCall.function.name,
							paramsSignature,
							success: toolSucceeded,
							resultSignature: resultContent
								.replace(/\s+/g, " ")
								.trim()
								.slice(0, 200),
							// Workers have no EvidenceLedger: treat a successful call as
							// progress (idempotent_no_progress can't fire here; exact/
							// same-tool failure detection is the worker-relevant part).
							progressed: toolSucceeded,
						},
						{ worker: true },
					);
					if (verdict.action === "block") {
						resultContent = `${resultContent}\n\n${verdict.reason}`;
						guardBlocked = true;
					} else if (verdict.action === "warn") {
						resultContent = `${resultContent}\n\n${verdict.reason}`;
					}
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
						metadata: this.taskMetadata(state.task, "tool_result"),
					},
				});
			}
			// Guardrail circuit-breaker tripped this turn → stop the worker loop
			// and let the final-response path summarize what was achieved.
			if (guardBlocked) {
				break;
			}
		}

		// Budget agotado — pedir respuesta final (HermesAgent-style wrap-up: state
		// what was accomplished + recommend what remains, with run-budget context).
		const runBudgetContext = Number.isFinite(this.activeRunBudget.max)
			? ` Iteraciones usadas en el run: ${this.activeRunBudget.used}/${this.activeRunBudget.max}${this.activeRunBudget.exhausted ? " (agotado)" : ""}.`
			: "";
		state.messages.push({
			role: "system",
			content: `Has agotado tu presupuesto de herramientas (${state.toolIterations} iteraciones en esta subtarea).${runBudgetContext} Responde ahora resumiendo lo que lograste, indicando el estado de cada parte de la tarea (completada/parcial/fallida), y recomendando concretamente qué falta hacer para terminar. No inventes resultados no verificados.`,
		});

		const finalResponse = await this.llmRouter.chat({
			model:
				state.task.model || config.model || this.baseConfig.model || "default",
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
		// Reset the shared run-iteration budget for this run.
		this.activeRunBudget = {
			used: 0,
			max:
				typeof config.maxIterationsPerRun === "number" &&
				Number.isFinite(config.maxIterationsPerRun) &&
				config.maxIterationsPerRun > 0
					? config.maxIterationsPerRun
					: Number.POSITIVE_INFINITY,
			exhausted: false,
		};

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
				if (this.activeRunBudget.exhausted) break;
				// Stagger worker starts within the chunk so they don't all hit
				// the provider API at the same instant (avoids 429 bursts).
				const promises = chunk.map((task, index) =>
					sleep(index * WORKER_STAGGER_MS).then(() =>
						this.executeWorker(task, config).then((result) => {
							results.set(task.id, result);
						}),
					),
				);
				await Promise.allSettled(promises);
			}
		};

		await executeReadyBatch(ready);

		// Ejecutar tareas con dependencias en orden
		const completedTaskIds = new Set(
			ready.filter((task) => task.status === "done").map((task) => task.id),
		);
		let maxPasses = pending.length + 1; // Evitar loops infinitos

		while (pending.length > 0 && maxPasses-- > 0) {
			if (this.activeRunBudget.exhausted) {
				// Run iteration budget drained: mark remaining pending tasks so the
				// orchestrator/C1 sees them as not-done and can short-circuit.
				for (const task of pending) {
					task.status = "failed";
					const message = `[Budget] Presupuesto de iteraciones del run agotado (${this.activeRunBudget.max}).`;
					results.set(task.id, results.get(task.id) ?? message);
				}
				break;
			}
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
						data: {
							message,
							error: message,
							metadata: this.taskMetadata(task, "blocked"),
						},
					});
				}
				break;
			}

			await executeReadyBatch(nowReady);
			for (const task of nowReady) {
				if (task.status === "done") {
					completedTaskIds.add(task.id);
				}
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
