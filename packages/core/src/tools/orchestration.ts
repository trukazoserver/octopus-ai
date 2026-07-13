/**
 * orchestrate_parallel — agent-callable tool that exposes the full multi-agent
 * pipeline (KanbanPlanner → executeParallel → C1 recovery → synthesize) as ONE
 * call. Designed for COMPOUND requests written as prose that the main agent
 * struggles to delegate opportunistically (gpt-5.5 serializes them).
 *
 * The main agent's only job is the single binary decision "is this 2+
 * independent deliverables?" → call this tool. Decomposition, parallel
 * dispatch, arm routing, and C1 failure recovery are then deterministic.
 *
 * Mirrors `team.ts` (createTeamTools): a factory that receives its orchestrator
 * deps via closure. Progress flows back to the UI via context.onProgress
 * (forwarded by the runtime for longRunning tools), emitting the SAME STATUS
 * strings as the auto-gate path (see orchestrator-status.ts).
 */

import type { KanbanPlanner } from "../agent/kanban-planner.js";
import { orchestratorEventToStatusStrings } from "../agent/orchestrator-status.js";
import type {
	OctopusOrchestrator,
	OrchestratorTelemetry,
} from "../agent/orchestrator.js";
import type { WorkerConfig } from "../agent/worker-pool.js";
import type { LLMMessage } from "../ai/types.js";
import type { ToolDefinition } from "./registry.js";

export interface OrchestrationToolDeps {
	getOrchestrator: (channelId?: string, agentId?: string) => OctopusOrchestrator | undefined;
	kanbanPlanner?: KanbanPlanner;
	rootAgentId: string;
}

export function createOrchestrationTools(
	deps: OrchestrationToolDeps,
): ToolDefinition[] {
	return [
		{
			name: "orchestrate_parallel",
			longRunning: true,
			description: [
				"Decomposes a COMPOUND request into independent subtasks, dispatches them to specialist workers in PARALLEL, recovers any failure via re-planning (C1), and returns ONE synthesized answer.",
				"",
				'USE THIS when the user\'s message is prose containing 2+ DISTINCT, INDEPENDENT deliverables chained by action verbs over different targets — e.g. "investiga los podcasts más populares, define el oyente ideal, y redacta tres ideas de episodios", "analyze A, design B, and draft C", "traduce esto, resume aquello y propón lo otro", "compara X, Y y Z".',
				"",
				'DO NOT USE for: a single coherent deliverable, a quick single answer, a translation, a calculation, strictly sequential work (step N+1 needs step N), or anything you can do directly in one step. DO NOT USE if the user already structured the request as numbered/labeled workers ("worker 1: ... worker 2: ...") — in that case call delegate_task once per worker in the same turn.',
				"",
				'You only decide: "is this 2+ independent deliverables in prose?". If yes, call this tool ONCE with the full request as `goal`; it handles decomposition, arm routing, parallel execution, and failure recovery deterministically.',
			].join("\n"),
			parameters: {
				goal: {
					type: "string",
					description:
						"The full compound user request, verbatim or lightly paraphrased. The tool handles decomposition — do not pre-split it yourself.",
					required: true,
				},
				context_hint: {
					type: "string",
					description:
						"Optional: context the main agent has that the workers won't (files already loaded, decisions already made, user preferences). Prepended to each worker's task.",
				},
				max_workers: {
					type: "number",
					description:
						"Optional cap on parallel workers. Default: the orchestrator's maximum.",
				},
			},
			handler: async (args, context) => {
				const goal = String(args.goal ?? "");
				const contextHint =
					typeof args.context_hint === "string" ? args.context_hint : "";
				const maxWorkers =
					typeof args.max_workers === "number" && args.max_workers > 0
						? args.max_workers
						: undefined;
				const channelId = context.agent?.channelId;
				const signal = context.agent?.abortSignal;
				const orchestrator = deps.getOrchestrator(
					channelId,
					context.agent?.agentId,
				);

				if (!goal.trim()) {
					return {
						success: false,
						output: "",
						error: "orchestrate_parallel requiere un `goal` no vacío.",
					};
				}
				if (!orchestrator) {
					return { success: false, output: "", error: "No hay un orquestador disponible para esta conversación." };
				}
				if (signal?.aborted) {
					return {
						success: false,
						output: "",
						error: "Orquestación cancelada antes de empezar.",
					};
				}

				// 1. Decompose (prefer Kanban planner; fall back to legacy LLM decompose).
				const decomposition = deps.kanbanPlanner
					? await orchestrator.decomposeViaKanban(goal, {
							conversationId: channelId,
							rootAgentId: deps.rootAgentId,
						})
					: await orchestrator.decompose(goal);

				// 2. Reject non-compound (mirror runtime's "Delegación omitida").
				if (decomposition.subtasks.length <= 1) {
					return {
						success: false,
						output: "",
						error: [
							"Orquestación omitida: la solicitud no se descompuso en 2+ subtareas independientes.",
							`Razón del planner: ${decomposition.reasoning}`,
							"Resuelve esta tarea directamente como Octopus. orchestrate_parallel solo aplica a solicitudes compound con 2+ entregables independientes.",
						].join("\n"),
					};
				}

				// 3. Cap workers if requested.
				const effectiveSubtasks =
					maxWorkers && maxWorkers < decomposition.subtasks.length
						? decomposition.subtasks.slice(0, maxWorkers)
						: decomposition.subtasks;

				const sharedContext: LLMMessage[] | undefined = contextHint
					? [{ role: "system", content: contextHint }]
					: undefined;
				const workerConfig: Partial<WorkerConfig> = {
					channelId,
					signal,
					sharedContext,
				};

				// 4. Consume executeParallel, forwarding every event to the UI via
				//    onProgress (identical STATUS strings to the auto-gate path) and
				//    capturing the synthesis as the tool result.
				let synthesisResult = "";
				let telemetry: OrchestratorTelemetry | undefined;
				try {
					for await (const event of orchestrator.executeParallel(
						{ ...decomposition, subtasks: effectiveSubtasks },
						workerConfig,
					)) {
						if (signal?.aborted) break;
						for (const status of orchestratorEventToStatusStrings(event)) {
							context.onProgress?.(status);
						}
						if (event.type === "synthesis") synthesisResult = event.result;
						else if (event.type === "telemetry") telemetry = event.data;
					}
				} catch (err) {
					return {
						success: false,
						output: synthesisResult,
						error: `Orquestación falló: ${
							err instanceof Error ? err.message : String(err)
						}`,
						metadata: telemetry ? { telemetry } : undefined,
					};
				}

				if (signal?.aborted) {
					return {
						success: false,
						output: synthesisResult,
						error: "Orquestación cancelada.",
						metadata: telemetry ? { telemetry } : undefined,
					};
				}
				if (!synthesisResult) {
					return {
						success: false,
						output: "",
						error:
							"La orquestación no produjo una síntesis. Revisa los eventos de progreso y reintenta con delegate_task manual si es necesario.",
					};
				}
				return {
					success: true,
					output: synthesisResult,
					metadata: telemetry ? { telemetry } : undefined,
				};
			},
		},
	];
}
