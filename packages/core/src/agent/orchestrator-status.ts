/**
 * Shared STATUS-string encoding for orchestrator events.
 *
 * Used by BOTH the runtime's auto-gate path (processMessageStream) AND the
 * `orchestrate_parallel` tool handler, so the UI renders identically regardless
 * of which path produced the events. Extracted from runtime.ts to avoid drift.
 */

import type { OrchestratorEvent } from "./orchestrator.js";

export function encodeStatusField(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Translate an OrchestratorEvent into 0..N `\x00STATUS:...\x00` strings.
 * `synthesis` returns [] — callers capture the synthesis separately (the
 * auto-gate ends the turn with it; the orchestrate_parallel tool returns it as
 * the tool result). Review/verification events are not surfaced here.
 */
export function orchestratorEventToStatusStrings(
	event: OrchestratorEvent,
): string[] {
	switch (event.type) {
		case "decomposition":
			return [
				`\x00STATUS:orchestrating:multiagent::${encodeStatusField(
					JSON.stringify({
						count: event.data.subtasks.length,
						executionPlan: event.data.executionPlan,
						reasoning: event.data.reasoning,
						subtasks: event.data.subtasks.map((task) => ({
							id: task.id,
							role: task.role,
							description: task.description,
							toolScope: task.toolScope,
							agentId: task.agentId,
							agentName: task.agentName,
							armKey: task.armKey,
							agentAvatar: task.avatar,
							agentColor: task.color,
						})),
					}),
				)}\x00`,
			];
		case "worker_started":
			return [
				`\x00STATUS:worker_start:${event.workerId}::${encodeStatusField(
					JSON.stringify({
						workerId: event.workerId,
						taskId: event.taskId,
						role: event.role,
						description: event.description,
						agentId: event.agentId,
						agentName: event.agentName,
						armKey: event.armKey,
						agentAvatar: event.avatar,
						agentColor: event.color,
						activity: event.activity,
						liveAgentRuntime: event.liveAgentRuntime,
					}),
				)}\x00`,
			];
		case "worker_progress":
			return [
				`\x00STATUS:worker_progress:${event.workerId}::${encodeStatusField(
					JSON.stringify({
						workerId: event.workerId,
						taskId: event.taskId,
						message: event.message,
						progress: event.progress,
						toolName: event.toolName,
						agentId: event.agentId,
						agentName: event.agentName,
						armKey: event.armKey,
						agentAvatar: event.avatar,
						agentColor: event.color,
						activity: event.activity,
						liveAgentRuntime: event.liveAgentRuntime,
					}),
				)}\x00`,
			];
		case "worker_done":
			return [
				`\x00STATUS:worker_done:${event.workerId}::${encodeStatusField(
					JSON.stringify({
						workerId: event.workerId,
						taskId: event.taskId,
						result: event.result,
						progress: 100,
						agentId: event.agentId,
						agentName: event.agentName,
						armKey: event.armKey,
						agentAvatar: event.avatar,
						agentColor: event.color,
						activity: event.activity,
						liveAgentRuntime: event.liveAgentRuntime,
					}),
				)}\x00`,
			];
		case "worker_error":
			return [
				`\x00STATUS:worker_error:${event.workerId}::${encodeStatusField(
					JSON.stringify({
						workerId: event.workerId,
						taskId: event.taskId,
						error: event.error,
						agentId: event.agentId,
						agentName: event.agentName,
						armKey: event.armKey,
						agentAvatar: event.avatar,
						agentColor: event.color,
						activity: event.activity,
						liveAgentRuntime: event.liveAgentRuntime,
					}),
				)}\x00`,
			];
		case "replan":
			return [
				`\x00STATUS:orchestrating:replan::${encodeStatusField(
					JSON.stringify({
						pass: event.data.pass,
						failedTaskIds: event.data.failedTaskIds,
						replacementTaskIds: event.data.replacementTaskIds,
						reason: event.data.reason,
					}),
				)}\x00`,
			];
		case "telemetry":
			return [
				`\x00STATUS:orchestrating:telemetry::${encodeStatusField(
					JSON.stringify(event.data),
				)}\x00`,
			];
		case "synthesis":
		case "review_started":
		case "review_completed":
		case "correction_applied":
		case "verification_phase":
			return [];
		default:
			return [];
	}
}
