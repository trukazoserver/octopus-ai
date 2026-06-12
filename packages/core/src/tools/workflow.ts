import type { ArtifactVerifier } from "../agent/artifact-verifier.js";
import type { KanbanDispatcher } from "../agent/kanban-dispatcher.js";
import type { KanbanPlanner } from "../agent/kanban-planner.js";
import type { RequirementResolver } from "../agent/requirement-resolver.js";
import type {
	WorkflowManager,
	WorkflowStatus,
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

async function validateClaim(
	workflowManager: WorkflowManager,
	taskId: string,
	claimToken: string,
): Promise<{ runId: string; agentId?: string | null }> {
	const task = await workflowManager.getTask(taskId);
	if (!task) throw new Error(`Workflow task not found: ${taskId}`);
	if (task.claim_token !== claimToken) {
		throw new Error("Invalid or expired claim token for workflow task.");
	}
	return { runId: task.run_id, agentId: task.claimed_by_agent_id };
}

export function createWorkflowTools(
	workflowManager: WorkflowManager,
	requirementResolver?: RequirementResolver,
	kanbanPlanner?: KanbanPlanner,
	artifactVerifier?: ArtifactVerifier,
	kanbanDispatcher?: KanbanDispatcher,
): ToolDefinition[] {
	return [
		{
			name: "kanban_create_plan_from_goal",
			description:
				"Create a Kanban Swarm workflow from a natural-language goal. Use this when Octavio decides a task needs parallel specialist cards with dependencies.",
			uiIcon: "workflow",
			parameters: {
				goal: {
					type: "string",
					description:
						"Natural-language objective to turn into a Kanban Swarm DAG",
					required: true,
				},
				conversation_id: {
					type: "string",
					description: "Optional conversation/channel id",
				},
				root_agent_id: {
					type: "string",
					description: "Optional root agent id, usually Octavio",
				},
			},
			handler: async (params) => {
				if (!kanbanPlanner) {
					return {
						success: false,
						output: "",
						error: "Kanban planner is not available.",
					};
				}
				const goal = stringParam(params, "goal") as string;
				const result = await kanbanPlanner.planFromGoal({
					goal,
					conversationId: stringParam(params, "conversation_id", false),
					rootAgentId: stringParam(params, "root_agent_id", false),
				});
				await requirementResolver?.evaluatePendingRequirements({
					runId: result.run.id,
				});
				return ok(
					`Kanban Swarm workflow created: ${result.run.id} (${result.tasks.length} cards).`,
					result as unknown as Record<string, unknown>,
				);
			},
		},
		{
			name: "workflow_heartbeat",
			description: "Renew the lease heartbeat for the current workflow task.",
			uiIcon: "activity",
			parameters: {
				task_id: {
					type: "string",
					description: "Workflow task/card id",
					required: true,
				},
				claim_token: {
					type: "string",
					description: "Lease claim token",
					required: true,
				},
			},
			handler: async (params) => {
				const taskId = stringParam(params, "task_id") as string;
				const claimToken = stringParam(params, "claim_token") as string;
				const success = await workflowManager.heartbeatTaskLease({
					taskId,
					leaseToken: claimToken,
				});
				return success
					? ok("Workflow task heartbeat renewed.")
					: { success: false, output: "", error: "Heartbeat rejected." };
			},
		},
		{
			name: "workflow_report_progress",
			description:
				"Record visible progress for the current workflow task without completing it.",
			uiIcon: "activity",
			parameters: {
				task_id: {
					type: "string",
					description: "Workflow task/card id",
					required: true,
				},
				claim_token: {
					type: "string",
					description: "Lease claim token",
					required: true,
				},
				message: {
					type: "string",
					description: "Progress message",
					required: true,
				},
			},
			handler: async (params) => {
				const taskId = stringParam(params, "task_id") as string;
				const claimToken = stringParam(params, "claim_token") as string;
				const message = stringParam(params, "message") as string;
				const { runId, agentId } = await validateClaim(
					workflowManager,
					taskId,
					claimToken,
				);
				await workflowManager.recordEvent({
					runId,
					taskId,
					agentId: agentId ?? undefined,
					eventType: "task_progress",
					message,
				});
				await workflowManager.heartbeatTaskLease({
					taskId,
					leaseToken: claimToken,
				});
				return ok("Workflow progress recorded.");
			},
		},
		{
			name: "workflow_comment_task",
			description:
				"Add a persistent comment, handoff, review note, or instruction to a workflow card.",
			uiIcon: "message",
			parameters: {
				task_id: {
					type: "string",
					description: "Workflow task/card id",
					required: true,
				},
				body: {
					type: "string",
					description: "Comment body",
					required: true,
				},
				comment_type: {
					type: "string",
					description: "comment, handoff, review_note, instruction, rejection",
				},
			},
			handler: async (params, context) => {
				const taskId = stringParam(params, "task_id") as string;
				const body = stringParam(params, "body") as string;
				const task = await workflowManager.getTask(taskId);
				if (!task)
					return { success: false, output: "", error: "Task not found." };
				const comment = await workflowManager.recordTaskComment({
					runId: task.run_id,
					taskId,
					authorAgentId: context.agent?.agentId,
					commentType: stringParam(params, "comment_type", false) ?? "comment",
					body,
					metadata: { source: "workflow_tool" },
				});
				return ok("Workflow task comment recorded.", { comment });
			},
		},
		{
			name: "workflow_record_artifact",
			description:
				"Record an artifact produced by the current workflow task. Include artifact_key when it unlocks dependent tasks.",
			uiIcon: "file",
			parameters: {
				task_id: {
					type: "string",
					description: "Workflow task/card id",
					required: true,
				},
				claim_token: {
					type: "string",
					description: "Lease claim token",
					required: true,
				},
				artifact_type: {
					type: "string",
					description: "Artifact type, e.g. image, video, document",
					required: true,
				},
				artifact_key: {
					type: "string",
					description: "Stable key used by dependent requirements",
				},
				url: { type: "string", description: "Artifact URL" },
				path: { type: "string", description: "Local artifact path" },
				description: {
					type: "string",
					description: "Short artifact description",
				},
				mime_type: { type: "string", description: "MIME type" },
				size_bytes: { type: "number", description: "Artifact size in bytes" },
			},
			handler: async (params) => {
				const taskId = stringParam(params, "task_id") as string;
				const claimToken = stringParam(params, "claim_token") as string;
				const artifactType = stringParam(params, "artifact_type") as string;
				const { runId, agentId } = await validateClaim(
					workflowManager,
					taskId,
					claimToken,
				);
				const artifact = await workflowManager.recordArtifact({
					runId,
					taskId,
					agentId: agentId ?? undefined,
					artifactType,
					artifactKey: stringParam(params, "artifact_key", false),
					url: stringParam(params, "url", false),
					path: stringParam(params, "path", false),
					description: stringParam(params, "description", false),
					mimeType: stringParam(params, "mime_type", false),
					sizeBytes: numberParam(params, "size_bytes"),
					existsVerified: false,
				});
				if (artifactVerifier)
					await artifactVerifier.verifyArtifact(artifact.id);
				await workflowManager.recordEvent({
					runId,
					taskId,
					agentId: agentId ?? undefined,
					eventType: "artifact_recorded",
					message: `Artifact recorded: ${artifact.artifact_key ?? artifact.artifact_type}.`,
					metadata: {
						artifactId: artifact.id,
						artifactKey: artifact.artifact_key,
					},
				});
				await requirementResolver?.evaluatePendingRequirements({ runId });
				return ok("Workflow artifact recorded.", { artifact });
			},
		},
		{
			name: "workflow_complete_task",
			description:
				"Complete the current workflow task after required artifacts and acceptance criteria are satisfied.",
			uiIcon: "check",
			parameters: {
				task_id: {
					type: "string",
					description: "Workflow task/card id",
					required: true,
				},
				claim_token: {
					type: "string",
					description: "Lease claim token",
					required: true,
				},
				summary: {
					type: "string",
					description: "Completion summary",
					required: true,
				},
			},
			handler: async (params) => {
				const taskId = stringParam(params, "task_id") as string;
				const claimToken = stringParam(params, "claim_token") as string;
				const summary = stringParam(params, "summary") as string;
				const { runId, agentId } = await validateClaim(
					workflowManager,
					taskId,
					claimToken,
				);
				if (artifactVerifier)
					await artifactVerifier.verifyTaskArtifacts(taskId);
				const missing =
					await workflowManager.getMissingProducedArtifacts(taskId);
				if (missing.length > 0) {
					return {
						success: false,
						output: "",
						error: `Cannot complete task; missing verified produced artifacts: ${missing.join(", ")}`,
						metadata: { missingProducedArtifacts: missing },
					};
				}
				await workflowManager.updateTaskStatus(taskId, "done", {
					metadata: { completionSummary: summary },
				});
				await workflowManager.recordEvent({
					runId,
					taskId,
					agentId: agentId ?? undefined,
					eventType: "task_completed",
					message: summary,
				});
				await requirementResolver?.evaluatePendingRequirements({ runId });
				await requirementResolver?.promoteChildrenOfCompletedTask(taskId);
				await kanbanDispatcher?.tick();
				await workflowManager.completeRunIfAllTasksTerminal(runId);
				return ok("Workflow task completed.");
			},
		},
		{
			name: "workflow_block_task",
			description:
				"Block the current workflow task with an actionable reason for Octavio or a human reviewer.",
			uiIcon: "warning",
			parameters: {
				task_id: {
					type: "string",
					description: "Workflow task/card id",
					required: true,
				},
				claim_token: {
					type: "string",
					description: "Lease claim token",
					required: true,
				},
				reason: {
					type: "string",
					description: "Actionable blocker reason",
					required: true,
				},
				severity: {
					type: "string",
					description: "low, normal, high, critical",
				},
			},
			handler: async (params) => {
				const taskId = stringParam(params, "task_id") as string;
				const claimToken = stringParam(params, "claim_token") as string;
				const reason = stringParam(params, "reason") as string;
				const { runId, agentId } = await validateClaim(
					workflowManager,
					taskId,
					claimToken,
				);
				await workflowManager.recordBlocker({
					runId,
					taskId,
					blockerType: "worker_blocked",
					severity: stringParam(params, "severity", false) ?? "normal",
					reason,
					ownerAgentId: agentId ?? undefined,
				});
				await workflowManager.updateTaskStatus(taskId, "blocked");
				return ok("Workflow task blocked.");
			},
		},
		{
			name: "workflow_request_review",
			description:
				"Move the current workflow task into review with a reason and evidence summary.",
			uiIcon: "eye",
			parameters: {
				task_id: {
					type: "string",
					description: "Workflow task/card id",
					required: true,
				},
				claim_token: {
					type: "string",
					description: "Lease claim token",
					required: true,
				},
				reason: {
					type: "string",
					description: "Review reason",
					required: true,
				},
			},
			handler: async (params) => {
				const taskId = stringParam(params, "task_id") as string;
				const claimToken = stringParam(params, "claim_token") as string;
				const reason = stringParam(params, "reason") as string;
				const { runId, agentId } = await validateClaim(
					workflowManager,
					taskId,
					claimToken,
				);
				await workflowManager.updateTaskStatus(taskId, "review", {
					metadata: { reviewReason: reason },
				});
				await workflowManager.recordEvent({
					runId,
					taskId,
					agentId: agentId ?? undefined,
					eventType: "review_requested",
					message: reason,
				});
				return ok("Workflow task moved to review.");
			},
		},
		{
			name: "workflow_get_task_context",
			description:
				"Read requirements, artifacts, and task details for a workflow card before executing it.",
			uiIcon: "info",
			parameters: {
				task_id: {
					type: "string",
					description: "Workflow task/card id",
					required: true,
				},
			},
			handler: async (params) => {
				const taskId = stringParam(params, "task_id") as string;
				const context = await workflowManager.getTaskContext(taskId);
				if (!context)
					return { success: false, output: "", error: "Task not found." };
				return ok(JSON.stringify(context, null, 2), { context });
			},
		},
	];
}

export type WorkflowToolStatus = WorkflowStatus;
