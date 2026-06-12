import type { ArtifactVerifier } from "./artifact-verifier.js";
import type {
	WorkflowManager,
	WorkflowTaskRecord,
	WorkflowTaskRequirementRecord,
} from "./workflow-manager.js";

export interface RequirementResolverResult {
	evaluated: number;
	satisfied: number;
	unlockedTasks: number;
}

export class RequirementResolver {
	constructor(
		private workflowManager: WorkflowManager,
		private artifactVerifier?: ArtifactVerifier,
	) {}

	async evaluatePendingRequirements(
		options: {
			runId?: string;
			limit?: number;
		} = {},
	): Promise<RequirementResolverResult> {
		const requirements = await this.workflowManager.listRequirements({
			status: "pending",
			runId: options.runId,
			limit: options.limit ?? 500,
		});
		let satisfied = 0;
		for (const requirement of requirements) {
			if (await this.evaluateRequirement(requirement)) satisfied++;
		}
		const unlockedTasks = await this.unlockSatisfiedTasks(options.runId);
		return { evaluated: requirements.length, satisfied, unlockedTasks };
	}

	async evaluateRequirement(
		requirement: WorkflowTaskRequirementRecord,
	): Promise<boolean> {
		switch (requirement.requirement_type) {
			case "artifact":
				return this.evaluateArtifactRequirement(requirement);
			case "task_status":
				return this.evaluateTaskStatusRequirement(requirement);
			case "manual":
				return false;
			case "time":
				return this.evaluateTimeRequirement(requirement);
			default:
				return false;
		}
	}

	async unlockSatisfiedTasks(runId?: string): Promise<number> {
		const waitingTasks = await this.workflowManager.listTasksByStatus(
			["waiting_dependency"],
			{ runId, limit: 500 },
		);
		let unlocked = 0;
		for (const task of waitingTasks) {
			if (await this.areTaskRequirementsSatisfied(task.id)) {
				await this.workflowManager.updateTaskStatus(task.id, "ready");
				await this.workflowManager.recordEvent({
					runId: task.run_id,
					taskId: task.id,
					eventType: "task_unlocked",
					message: "All required dependencies are satisfied.",
				});
				unlocked++;
			}
		}
		return unlocked;
	}

	async promoteChildrenOfCompletedTask(taskId: string): Promise<number> {
		const dependentRequirements =
			await this.workflowManager.listRequirements({
				requiredTaskId: taskId,
				limit: 500,
			});
		const candidateTaskIds = new Set(
			dependentRequirements.map((r) => r.task_id),
		);
		let promoted = 0;
		for (const candidateTaskId of candidateTaskIds) {
			const task = await this.workflowManager.getTask(candidateTaskId);
			if (!task || task.status !== "waiting_dependency") continue;
			if (await this.areTaskRequirementsSatisfied(candidateTaskId)) {
				await this.workflowManager.updateTaskStatus(candidateTaskId, "ready");
				await this.workflowManager.recordEvent({
					runId: task.run_id,
					taskId: candidateTaskId,
					eventType: "task_promoted",
					message: `Parent task ${taskId} completed; all requirements satisfied — promoted to ready.`,
				});
				promoted++;
			}
		}
		return promoted;
	}

	async areTaskRequirementsSatisfied(taskId: string): Promise<boolean> {
		const requirements =
			await this.workflowManager.listTaskRequirements(taskId);
		const required = requirements.filter((item) => item.optional !== 1);
		return (
			required.length === 0 ||
			required.every((item) => item.status === "satisfied")
		);
	}

	private async evaluateArtifactRequirement(
		requirement: WorkflowTaskRequirementRecord,
	): Promise<boolean> {
		if (this.artifactVerifier) {
			await this.artifactVerifier.verifyArtifactsByKey({
				runId: requirement.run_id,
				artifactKey: requirement.artifact_key,
				artifactType: requirement.artifact_type,
			});
		}
		const minCount = Math.max(1, requirement.min_count ?? 1);
		const artifacts = await this.workflowManager.listVerifiedArtifacts({
			runId: requirement.run_id,
			artifactKey: requirement.artifact_key,
			artifactType: requirement.artifact_type,
			limit: minCount,
		});
		if (artifacts.length < minCount) return false;
		const artifact = artifacts[0];
		if (!artifact) return false;
		await this.workflowManager.markRequirementSatisfied(requirement.id, {
			artifactId: artifact.id,
		});
		await this.workflowManager.recordEvent({
			runId: requirement.run_id,
			taskId: requirement.task_id,
			eventType: "requirement_satisfied",
			message: `Artifact requirement satisfied: ${requirement.artifact_key ?? requirement.artifact_type ?? requirement.requirement_key}.`,
			metadata: {
				requirementId: requirement.id,
				artifactId: artifact.id,
				artifactCount: artifacts.length,
				minCount,
			},
		});
		return true;
	}

	private async evaluateTaskStatusRequirement(
		requirement: WorkflowTaskRequirementRecord,
	): Promise<boolean> {
		if (!requirement.required_task_id) return false;
		const task = await this.workflowManager.getTask(
			requirement.required_task_id,
		);
		const requiredStatus = requirement.required_status ?? "done";
		if (!task || task.status !== requiredStatus) return false;
		await this.workflowManager.markRequirementSatisfied(requirement.id, {
			taskId: task.id,
		});
		await this.workflowManager.recordEvent({
			runId: requirement.run_id,
			taskId: requirement.task_id,
			eventType: "requirement_satisfied",
			message: `Task requirement satisfied: ${task.title} is ${requiredStatus}.`,
			metadata: { requirementId: requirement.id, requiredTaskId: task.id },
		});
		return true;
	}

	private async evaluateTimeRequirement(
		requirement: WorkflowTaskRequirementRecord,
	): Promise<boolean> {
		if (!requirement.metadata) return false;
		try {
			const metadata = JSON.parse(requirement.metadata) as {
				notBefore?: string;
			};
			if (!metadata.notBefore) return false;
			if (Date.parse(metadata.notBefore) > Date.now()) return false;
			await this.workflowManager.markRequirementSatisfied(requirement.id, {});
			return true;
		} catch {
			return false;
		}
	}
}

export function deriveInitialTaskStatus(input: {
	requires?: unknown[];
	status?: WorkflowTaskRecord["status"];
}): WorkflowTaskRecord["status"] {
	if (input.status) return input.status;
	return input.requires && input.requires.length > 0
		? "waiting_dependency"
		: "ready";
}
