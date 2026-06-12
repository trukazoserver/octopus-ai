import type { RequirementResolver } from "../agent/requirement-resolver.js";
import type {
	WorkflowManager,
	WorkflowTaskRecord,
} from "../agent/workflow-manager.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

function stringParam(
	params: Record<string, unknown>,
	key: string,
	required = true,
): string | undefined {
	const value = params[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	if (required) throw new Error(`Missing required parameter: ${key}`);
	return undefined;
}

function numberParam(
	params: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function ok(output: string, metadata?: Record<string, unknown>): ToolResult {
	return { success: true, output, metadata };
}

function stringArrayParam(
	params: Record<string, unknown>,
	key: string,
): string[] {
	const value = params[key];
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && item.trim().length > 0,
			)
		: [];
}

interface ArtifactSpec {
	artifactKey: string;
	artifactType: string;
	description?: string;
}

function artifactArrayParam(
	params: Record<string, unknown>,
	key: string,
): ArtifactSpec[] {
	const value = params[key];
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is Record<string, unknown> => item && typeof item === "object")
		.map((item) => ({
			artifactKey: typeof item.artifactKey === "string" ? item.artifactKey : "",
			artifactType: typeof item.artifactType === "string" ? item.artifactType : "",
			description: typeof item.description === "string" ? item.description : undefined,
		}))
		.filter((item) => item.artifactKey && item.artifactType);
}

interface RequirementSpec {
	key?: string;
	type: "artifact" | "task_status" | "manual" | "time";
	taskKey?: string;
	status?: string;
	artifactKey?: string;
	artifactType?: string;
	optional?: boolean;
	minCount?: number;
	notBefore?: string;
}

function requirementArrayParam(
	params: Record<string, unknown>,
	key: string,
): RequirementSpec[] {
	const value = params[key];
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is Record<string, unknown> => item && typeof item === "object")
		.map((item) => {
			const type = typeof item.type === "string" ? item.type : "artifact";
			if (!["artifact", "task_status", "manual", "time"].includes(type)) return null;
			return {
				key: typeof item.key === "string" ? item.key : undefined,
				type: type as RequirementSpec["type"],
				taskKey: typeof item.taskKey === "string" ? item.taskKey : undefined,
				status: typeof item.status === "string" ? item.status : undefined,
				artifactKey:
					typeof item.artifactKey === "string" ? item.artifactKey : undefined,
				artifactType:
					typeof item.artifactType === "string" ? item.artifactType : undefined,
				optional: item.optional === true,
				minCount: typeof item.minCount === "number" ? item.minCount : undefined,
				notBefore:
					typeof item.notBefore === "string" ? item.notBefore : undefined,
			};
		})
		.filter(Boolean) as RequirementSpec[];
}

export function createKanbanCardTools(
	workflowManager: WorkflowManager,
	requirementResolver?: RequirementResolver,
): ToolDefinition[] {
	return [
		{
			name: "kanban_create",
			description:
				"Create a single Kanban card within an existing workflow run. Use this to add individual cards to a Kanban Swarm workflow with specific arm assignment, acceptance criteria, and artifact dependencies.",
			uiIcon: "plus",
			parameters: {
				run_id: {
					type: "string",
					description: "Workflow run id to add the card to",
					required: true,
				},
				title: {
					type: "string",
					description: "Short title for the Kanban card",
					required: true,
				},
				description: {
					type: "string",
					description: "Detailed instructions for the card",
				},
				arm_key: {
					type: "string",
					description:
						"Arm to assign: bibi, anita, ari, cali, crabby, estelita, langi, medi",
				},
				priority: {
					type: "number",
					description: "Priority (1=high, 5=low). Default 5.",
				},
				acceptance_criteria: {
					type: "array",
					description: "List of verifiable acceptance criteria strings",
				},
				produces: {
					type: "array",
					description:
						"Artifacts this card will produce: [{artifactKey, artifactType, description?}]",
				},
				requires: {
					type: "array",
					description:
						"Requirements this card depends on: [{type, artifactKey, artifactType, taskKey?, optional?}]",
				},
				model: {
					type: "string",
					description: "Model override for this card (e.g. cheap model for boilerplate, expensive for hard tasks)",
				},
			},
			handler: async (params) => {
				const runId = stringParam(params, "run_id") as string;
				const title = stringParam(params, "title") as string;

				const run = await workflowManager.getRun(runId);
				if (!run) {
					return {
						success: false,
						output: "",
						error: `Workflow run not found: ${runId}`,
					};
				}

				const requirements = requirementArrayParam(params, "requires");
				const produces = artifactArrayParam(params, "produces");

				const task = await workflowManager.createTask({
					runId,
					title,
					description: stringParam(params, "description", false),
					armKey: stringParam(params, "arm_key", false),
					priority: numberParam(params, "priority") ?? 5,
					acceptanceCriteria: stringArrayParam(params, "acceptance_criteria"),
					produces: produces as unknown as Array<Record<string, unknown>>,
					status:
						requirements.length > 0 ? "waiting_dependency" : "ready",
					metadata: { source: "kanban_card_tool" },
					model: stringParam(params, "model", false),
				});

				for (const requirement of requirements) {
					await workflowManager.createRequirement({
						runId,
						taskId: task.id,
						requirementKey:
							requirement.key ??
							`${task.id}:${requirement.type}:${requirement.artifactKey ?? requirement.taskKey ?? "manual"}`,
						requirementType: requirement.type,
						requiredTaskId: requirement.taskKey,
						requiredStatus: requirement.status,
						artifactKey: requirement.artifactKey,
						artifactType: requirement.artifactType,
						optional: requirement.optional,
						minCount: requirement.minCount,
						metadata: {
							source: "kanban_card_tool",
							notBefore: requirement.notBefore,
						},
					});
				}

				await requirementResolver?.evaluatePendingRequirements({ runId });

				await workflowManager.recordEvent({
					runId,
					taskId: task.id,
					eventType: "kanban_card_created",
					message: `Card created: ${title}`,
					metadata: { taskId: task.id, armKey: task.arm_key },
				});

				return ok(`Kanban card created: ${task.id} — ${title}`, {
					taskId: task.id,
					status: task.status,
				});
			},
		},
		{
			name: "kanban_complete",
			description:
				"Complete a Kanban card by marking it as done. Evaluates pending requirements after completion to unlock dependent cards, and checks if the entire workflow run is complete.",
			uiIcon: "check",
			parameters: {
				task_id: {
					type: "string",
					description: "Kanban card/task id to complete",
					required: true,
				},
				summary: {
					type: "string",
					description: "Completion summary describing what was accomplished",
					required: true,
				},
			},
			handler: async (params) => {
				const taskId = stringParam(params, "task_id") as string;
				const summary = stringParam(params, "summary") as string;

				const task = await workflowManager.getTask(taskId);
				if (!task) {
					return {
						success: false,
						output: "",
						error: `Task not found: ${taskId}`,
					};
				}

				await workflowManager.updateTaskStatus(taskId, "done", {
					metadata: { completionSummary: summary },
				});

				await workflowManager.recordEvent({
					runId: task.run_id,
					taskId,
					eventType: "task_completed",
					message: summary,
				});

				await requirementResolver?.evaluatePendingRequirements({
					runId: task.run_id,
				});

				const runCompleted =
					await workflowManager.completeRunIfAllTasksTerminal(task.run_id);

				return ok(
					`Kanban card completed: ${task.title}${runCompleted ? ". All cards done — workflow run completed." : ""}`,
					{ taskId, runCompleted },
				);
			},
		},
		{
			name: "kanban_link",
			description:
				"Create a dependency link between two Kanban cards. The target card will wait until the source card produces the required artifact or reaches the required status.",
			uiIcon: "link",
			parameters: {
				run_id: {
					type: "string",
					description: "Workflow run id",
					required: true,
				},
				from_task_id: {
					type: "string",
					description: "Source card that produces the artifact or status",
					required: true,
				},
				to_task_id: {
					type: "string",
					description: "Target card that depends on the source",
					required: true,
				},
				artifact_key: {
					type: "string",
					description: "Artifact key that the source must produce",
				},
				artifact_type: {
					type: "string",
					description: "Artifact type (e.g. image, video, report)",
				},
			},
			handler: async (params) => {
				const runId = stringParam(params, "run_id") as string;
				const fromTaskId = stringParam(params, "from_task_id") as string;
				const toTaskId = stringParam(params, "to_task_id") as string;
				const artifactKey = stringParam(params, "artifact_key", false);
				const artifactType = stringParam(params, "artifact_type", false);

				const [fromTask, toTask] = await Promise.all([
					workflowManager.getTask(fromTaskId),
					workflowManager.getTask(toTaskId),
				]);
				if (!fromTask) {
					return {
						success: false,
						output: "",
						error: `Source task not found: ${fromTaskId}`,
					};
				}
				if (!toTask) {
					return {
						success: false,
						output: "",
						error: `Target task not found: ${toTaskId}`,
					};
				}

				const requirementType = artifactKey ? "artifact" : "task_status";
				await workflowManager.createRequirement({
					runId,
					taskId: toTaskId,
					requirementKey: `link:${fromTaskId}->${toTaskId}:${artifactKey ?? "status"}`,
					requirementType,
					requiredTaskId: fromTaskId,
					requiredStatus: artifactKey ? undefined : "done",
					artifactKey,
					artifactType,
					metadata: { source: "kanban_link_tool" },
				});

				if (
					toTask.status === "ready" ||
					toTask.status === "waiting_dependency"
				) {
					await workflowManager.updateTaskStatus(toTaskId, "waiting_dependency", {
						metadata: { source: "kanban_link_tool" },
					});
				}

				await requirementResolver?.evaluatePendingRequirements({ runId });

				await workflowManager.recordEvent({
					runId,
					taskId: toTaskId,
					eventType: "kanban_card_linked",
					message: `Card linked: ${fromTask.title} → ${toTask.title}`,
					metadata: { fromTaskId, toTaskId, artifactKey, requirementType },
				});

				return ok(
					`Kanban link created: ${fromTask.title} → ${toTask.title}`,
					{ fromTaskId, toTaskId, requirementType },
				);
			},
		},
		{
			name: "kanban_show",
			description:
				"Show the current state of a Kanban board as columns grouped by status. Returns all cards, their arm assignments, priorities, and progress metrics.",
			uiIcon: "columns",
			parameters: {
				run_id: {
					type: "string",
					description: "Workflow run id to inspect",
					required: true,
				},
			},
			handler: async (params) => {
				const runId = stringParam(params, "run_id") as string;
				const snapshot = await workflowManager.getRunSnapshot(runId);

				if (!snapshot.run) {
					return {
						success: false,
						output: "",
						error: `Workflow run not found: ${runId}`,
					};
				}

				const columns: Record<string, Array<Record<string, unknown>>> = {};
				for (const task of snapshot.tasks) {
					const status = task.status;
					if (!columns[status]) columns[status] = [];
					columns[status].push({
						id: task.id,
						title: task.title,
						armKey: task.arm_key,
						priority: task.priority,
						assignedAgentId: task.assigned_agent_id,
						createdAt: task.created_at,
						updatedAt: task.updated_at,
					});
				}

				const board = {
					runId: snapshot.run.id,
					goal: snapshot.run.goal,
					status: snapshot.run.status,
					columns,
					metrics: snapshot.metrics,
				};

				return ok(JSON.stringify(board, null, 2), { board });
			},
		},
	];
}
