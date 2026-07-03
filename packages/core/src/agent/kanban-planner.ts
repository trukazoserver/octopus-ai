import type { LLMRouter } from "../ai/router.js";
import type { LLMMessage } from "../ai/types.js";
import { OCTOPUS_ARM_KEYS, type OctopusArmKey } from "./arm-profiles.js";
import type {
	WorkflowManager,
	WorkflowRunRecord,
	WorkflowTaskRecord,
} from "./workflow-manager.js";

export interface KanbanArtifactSpec {
	artifactKey: string;
	artifactType: string;
	description?: string;
}

export interface KanbanRequirementSpec {
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

export interface KanbanPlanTaskSpec {
	key: string;
	title: string;
	description?: string;
	armKey?: OctopusArmKey;
	assignedAgentId?: string;
	priority?: number;
	acceptanceCriteria?: string[];
	requires?: KanbanRequirementSpec[];
	produces?: KanbanArtifactSpec[];
	requiresHumanReview?: boolean;
	model?: string;
}

export interface KanbanPlanSpec {
	goal: string;
	reasoning?: string;
	tasks: KanbanPlanTaskSpec[];
}

export interface PersistedKanbanPlan {
	run: WorkflowRunRecord;
	tasks: WorkflowTaskRecord[];
	plan: KanbanPlanSpec;
}

export interface KanbanPlannerOptions {
	model: string;
	maxTokens?: number;
}

const PLANNER_SYSTEM_PROMPT = `Eres Bibi, planner Kanban Swarm de Octopus. Convierte objetivos grandes en un DAG de cards ejecutables por brazos especializados.

Responde SOLO JSON valido, sin markdown, con este esquema:
{
  "goal": "objetivo claro",
  "reasoning": "breve razonamiento operativo",
  "tasks": [
    {
      "key": "id_estable_snake_case",
      "title": "titulo corto",
      "description": "instrucciones autocontenidas",
      "armKey": "bibi|anita|ari|cali|crabby|estelita|langi|medi",
      "priority": 1,
      "acceptanceCriteria": ["criterio verificable"],
      "requires": [
        { "type": "artifact", "artifactKey": "research_report_1", "artifactType": "research" }
      ],
      "produces": [
        { "artifactKey": "report_1", "artifactType": "report", "description": "entregable final 1" }
      ],
      "requiresHumanReview": false,
      "model": "optional model id override, e.g. claude-3-5-haiku or gpt-4o"
    }
  ]
}

Reglas obligatorias:
1. Usa dependencias granulares por artifact, no barreras globales, salvo que el usuario las pida.
2. El patron aplica a cualquier dominio: investigacion -> informe, especificacion -> implementacion, dataset -> analisis, imagen -> video, test plan -> QA, etc. Cada consumidor requiere solo su artifact especifico.
3. Toda card que desbloquee otra debe declarar produces con artifactKey estable.
4. Toda card con requires debe apuntar a artifacts o task keys existentes en el plan.
5. Cada card debe tener acceptanceCriteria concretos.
6. Maximiza paralelismo seguro.
7. No inventes herramientas externas; describe el trabajo y deja que el worker use sus tools.
8. Usa artifactType semanticos del dominio (research, report, spec, implementation, dataset, analysis, image, video, document, qa_result, etc.).`;

function slug(value: string): string {
	return (
		value
			.normalize("NFD")
			.replace(/\p{Mark}/gu, "")
			.toLowerCase()
			.match(/[a-z0-9]+/g)
			?.join("_") ?? "item"
	);
}

function parseJsonObject(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		const match = trimmed.match(/\{[\s\S]*\}/);
		if (!match) throw new Error("Planner response did not contain JSON.");
		return JSON.parse(match[0]) as Record<string, unknown>;
	}
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && item.trim().length > 0,
			)
		: [];
}

function normalizeArtifact(value: unknown): KanbanArtifactSpec | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const artifactKey = record.artifactKey ?? record.artifact_key;
	const artifactType = record.artifactType ?? record.artifact_type;
	if (typeof artifactKey !== "string" || typeof artifactType !== "string")
		return null;
	return {
		artifactKey,
		artifactType,
		description:
			typeof record.description === "string" ? record.description : undefined,
	};
}

function normalizeRequirement(value: unknown): KanbanRequirementSpec | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : "artifact";
	if (!["artifact", "task_status", "manual", "time"].includes(type))
		return null;
	return {
		key: typeof record.key === "string" ? record.key : undefined,
		type: type as KanbanRequirementSpec["type"],
		taskKey: typeof record.taskKey === "string" ? record.taskKey : undefined,
		status: typeof record.status === "string" ? record.status : undefined,
		artifactKey:
			typeof record.artifactKey === "string" ? record.artifactKey : undefined,
		artifactType:
			typeof record.artifactType === "string" ? record.artifactType : undefined,
		optional: record.optional === true,
		minCount: typeof record.minCount === "number" ? record.minCount : undefined,
		notBefore:
			typeof record.notBefore === "string" ? record.notBefore : undefined,
	};
}

export class KanbanPlanner {
	constructor(
		private workflowManager: WorkflowManager,
		private router?: LLMRouter,
		private options: KanbanPlannerOptions = { model: "" },
	) {}

	async planFromGoal(input: {
		goal: string;
		conversationId?: string;
		rootAgentId?: string;
		model?: string;
		workerArmKeys?: string[];
	}): Promise<PersistedKanbanPlan> {
		const rawPlan = this.router
			? await this.generatePlanWithModel(input.goal, input.model)
			: this.createHeuristicPlan(input.goal);
		const plan = this.applyOverrides(rawPlan, {
			defaultTaskModel: input.model,
			workerArmKeys: input.workerArmKeys,
		});
		return this.persistPlan({
			...input,
			plan,
		});
	}

	/**
	 * Propose tasks for a goal WITHOUT persisting a new run.
	 *
	 * Used by C1 (auto re-plan): the orchestrator needs alternative subtasks for
	 * a failed task and must add them to an EXISTING run via `createTask`, not
	 * spawn a brand-new run. Reuses the same model/heuristic + normalization +
	 * overrides as `planFromGoal`, just skips `persistPlan`.
	 */
	async proposeTasks(input: {
		goal: string;
		model?: string;
		workerArmKeys?: string[];
	}): Promise<KanbanPlanTaskSpec[]> {
		const rawPlan = this.router
			? await this.generatePlanWithModel(input.goal, input.model)
			: this.createHeuristicPlan(input.goal);
		const plan = this.applyOverrides(rawPlan, {
			defaultTaskModel: input.model,
			workerArmKeys: input.workerArmKeys,
		});
		return plan.tasks;
	}

	async persistPlan(input: {
		goal: string;
		conversationId?: string;
		rootAgentId?: string;
		plan: KanbanPlanSpec;
	}): Promise<PersistedKanbanPlan> {
		const plan = this.normalizePlan({
			...input.plan,
			goal: input.plan.goal || input.goal,
		});
		this.validatePlan(plan);
		const run = await this.workflowManager.createRun({
			conversationId: input.conversationId,
			rootAgentId: input.rootAgentId,
			goal: plan.goal,
			metadata: {
				source: "kanban_planner",
				workflowKind: "kanban_swarm",
				reasoning: plan.reasoning,
			},
		});
		const taskIdsByKey = new Map<string, string>();
		const tasks: WorkflowTaskRecord[] = [];
		for (const item of plan.tasks) {
			const task = await this.workflowManager.createTask({
				runId: run.id,
				title: item.title,
				description: item.description,
				armKey: item.armKey,
				assignedAgentId: item.assignedAgentId,
				priority: item.priority ?? 5,
				status:
					item.requires && item.requires.length > 0
						? "waiting_dependency"
						: "ready",
				acceptanceCriteria: item.acceptanceCriteria,
				produces: item.produces as unknown as Array<Record<string, unknown>>,
				requiresHumanReview: item.requiresHumanReview,
				model: item.model,
				metadata: { source: "kanban_planner", key: item.key },
			});
			taskIdsByKey.set(item.key, task.id);
			tasks.push(task);
		}
		for (const item of plan.tasks) {
			const taskId = taskIdsByKey.get(item.key);
			if (!taskId) continue;
			for (const requirement of item.requires ?? []) {
				await this.workflowManager.createRequirement({
					runId: run.id,
					taskId,
					requirementKey:
						requirement.key ??
						`${item.key}:${requirement.type}:${requirement.artifactKey ?? requirement.taskKey ?? "manual"}`,
					requirementType: requirement.type,
					requiredTaskId: requirement.taskKey
						? taskIdsByKey.get(requirement.taskKey)
						: undefined,
					requiredStatus: requirement.status,
					artifactKey: requirement.artifactKey,
					artifactType: requirement.artifactType,
					optional: requirement.optional,
					minCount: requirement.minCount,
					metadata: {
						source: "kanban_planner",
						notBefore: requirement.notBefore,
					},
				});
			}
		}
		await this.workflowManager.recordEvent({
			runId: run.id,
			eventType: "kanban_plan_created",
			message: `Kanban Swarm plan created with ${tasks.length} cards.`,
			metadata: { plan },
		});
		return { run, tasks, plan };
	}

	validatePlan(plan: KanbanPlanSpec): void {
		if (!plan.goal.trim()) throw new Error("Kanban plan goal is required.");
		if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
			throw new Error("Kanban plan requires at least one task.");
		}
		const keys = new Set<string>();
		const producedArtifacts = new Set<string>();
		for (const task of plan.tasks) {
			if (keys.has(task.key))
				throw new Error(`Duplicate task key: ${task.key}`);
			keys.add(task.key);
			if (task.armKey && !OCTOPUS_ARM_KEYS.includes(task.armKey)) {
				throw new Error(
					`Invalid armKey '${task.armKey}' for task '${task.key}'.`,
				);
			}
			if (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0) {
				throw new Error(`Task '${task.key}' requires acceptanceCriteria.`);
			}
			for (const artifact of task.produces ?? []) {
				if (producedArtifacts.has(artifact.artifactKey)) {
					throw new Error(
						`Duplicate produced artifact key: ${artifact.artifactKey}`,
					);
				}
				producedArtifacts.add(artifact.artifactKey);
			}
		}
		for (const task of plan.tasks) {
			for (const requirement of task.requires ?? []) {
				if (
					requirement.type === "task_status" &&
					requirement.taskKey &&
					!keys.has(requirement.taskKey)
				) {
					throw new Error(
						`Task '${task.key}' requires unknown task '${requirement.taskKey}'.`,
					);
				}
				if (requirement.type === "artifact") {
					if (!requirement.artifactKey || !requirement.artifactType) {
						throw new Error(
							`Task '${task.key}' has incomplete artifact requirement.`,
						);
					}
					if (!producedArtifacts.has(requirement.artifactKey)) {
						throw new Error(
							`Task '${task.key}' requires artifact '${requirement.artifactKey}' that no task produces.`,
						);
					}
				}
			}
		}
		this.assertNoCycles(plan);
	}

	private async generatePlanWithModel(
		goal: string,
		modelOverride?: string,
	): Promise<KanbanPlanSpec> {
		const messages: LLMMessage[] = [
			{ role: "system", content: PLANNER_SYSTEM_PROMPT },
			{ role: "user", content: goal },
		];
		const response = await this.router?.chat({
			model: modelOverride ?? this.options.model,
			messages,
			maxTokens: this.options.maxTokens ?? 3000,
			temperature: 0.2,
		});
		if (!response) return this.createHeuristicPlan(goal);
		return this.normalizePlan(parseJsonObject(response.content));
	}

	private applyOverrides(
		plan: KanbanPlanSpec,
		options: { defaultTaskModel?: string; workerArmKeys?: string[] },
	): KanbanPlanSpec {
		const workerArmKeys = (options.workerArmKeys ?? []).filter((key) =>
			OCTOPUS_ARM_KEYS.includes(key as OctopusArmKey),
		) as OctopusArmKey[];
		if (!options.defaultTaskModel && workerArmKeys.length === 0) return plan;
		return {
			...plan,
			tasks: plan.tasks.map((task, index) => ({
				...task,
				armKey:
					workerArmKeys.length > 0
						? workerArmKeys[index % workerArmKeys.length]
						: task.armKey,
				model: task.model ?? options.defaultTaskModel,
			})),
		};
	}

	private normalizePlan(raw: Record<string, unknown>): KanbanPlanSpec {
		const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];
		return {
			goal: typeof raw.goal === "string" ? raw.goal : "Kanban Swarm workflow",
			reasoning: typeof raw.reasoning === "string" ? raw.reasoning : undefined,
			tasks: tasksRaw.map((taskRaw, index) => {
				const record =
					taskRaw && typeof taskRaw === "object"
						? (taskRaw as Record<string, unknown>)
						: {};
				const armKey =
					typeof record.armKey === "string" &&
					OCTOPUS_ARM_KEYS.includes(record.armKey as OctopusArmKey)
						? (record.armKey as OctopusArmKey)
						: undefined;
				return {
					key:
						typeof record.key === "string" ? record.key : `task_${index + 1}`,
					title:
						typeof record.title === "string"
							? record.title
							: `Task ${index + 1}`,
					description:
						typeof record.description === "string"
							? record.description
							: undefined,
					armKey,
					assignedAgentId:
						typeof record.assignedAgentId === "string"
							? record.assignedAgentId
							: undefined,
					priority: typeof record.priority === "number" ? record.priority : 5,
					acceptanceCriteria: stringArray(record.acceptanceCriteria),
					requires: Array.isArray(record.requires)
						? record.requires
								.map(normalizeRequirement)
								.filter((item): item is KanbanRequirementSpec => Boolean(item))
						: [],
					produces: Array.isArray(record.produces)
						? record.produces
								.map(normalizeArtifact)
								.filter((item): item is KanbanArtifactSpec => Boolean(item))
						: [],
					requiresHumanReview: record.requiresHumanReview === true,
					model: typeof record.model === "string" ? record.model : undefined,
				};
			}),
		};
	}

	private createHeuristicPlan(goal: string): KanbanPlanSpec {
		const videoCountMatch = goal.match(/(\d+)\s+videos?/i);
		const mentionsImage = /im[aá]genes?|images?/i.test(goal);
		if (videoCountMatch && mentionsImage) {
			return this.createImageToVideoHeuristicPlan(goal, videoCountMatch);
		}
		return this.createGenericHeuristicPlan(goal);
	}

	private createImageToVideoHeuristicPlan(
		goal: string,
		countMatch: RegExpMatchArray,
	): KanbanPlanSpec {
		const count = Math.max(1, Math.min(Number.parseInt(countMatch[1], 10), 20));
		const tasks: KanbanPlanTaskSpec[] = [];
		for (let i = 1; i <= count; i++) {
			tasks.push({
				key: `image_${i}`,
				title: `Crear imagen para video ${i}`,
				description: `Genera la imagen base especifica para el video ${i}. Objetivo general: ${goal}`,
				armKey: "cali",
				priority: 1,
				acceptanceCriteria: [`Existe una imagen valida para el video ${i}`],
				produces: [{ artifactKey: `image_video_${i}`, artifactType: "image" }],
			});
			tasks.push({
				key: `video_${i}`,
				title: `Crear video ${i}`,
				description: `Crea el video ${i} usando exactamente la imagen image_video_${i}. Objetivo general: ${goal}`,
				armKey: "cali",
				priority: 2,
				acceptanceCriteria: [
					`Existe un video valido generado desde image_video_${i}`,
				],
				requires: [
					{
						type: "artifact",
						artifactKey: `image_video_${i}`,
						artifactType: "image",
					},
				],
				produces: [{ artifactKey: `video_${i}`, artifactType: "video" }],
			});
		}
		return {
			goal,
			reasoning: "Heuristic granular pipeline for image-to-video media work.",
			tasks,
		};
	}

	private createGenericHeuristicPlan(goal: string): KanbanPlanSpec {
		const countMatch = goal.match(/(\d+)\s+([\p{L}a-zA-Z0-9_-]+)/iu);
		const count = countMatch
			? Math.max(1, Math.min(Number.parseInt(countMatch[1], 10), 20))
			: 1;
		const deliverableType = slug(countMatch?.[2] ?? "deliverable");
		const dependencyMatch = goal.match(
			/(?:cada\s+(?:uno|una)\s+con\s+su|each\s+(?:one\s+)?with\s+(?:its|their))\s+([\p{L}a-zA-Z0-9_-]+)/iu,
		);
		const dependencyType = dependencyMatch ? slug(dependencyMatch[1]) : null;
		const tasks: KanbanPlanTaskSpec[] = [];
		for (let i = 1; i <= count; i++) {
			if (dependencyType) {
				tasks.push({
					key: `${dependencyType}_${i}`,
					title: `Preparar ${dependencyType} ${i}`,
					description: `Produce el artifact especifico ${dependencyType}_${deliverableType}_${i} requerido por el entregable ${i}. Objetivo general: ${goal}`,
					armKey: "bibi",
					priority: 1,
					acceptanceCriteria: [
						`Existe ${dependencyType}_${deliverableType}_${i} verificable y especifico del entregable ${i}`,
					],
					produces: [
						{
							artifactKey: `${dependencyType}_${deliverableType}_${i}`,
							artifactType: dependencyType,
						},
					],
				});
			}
			tasks.push({
				key: `${deliverableType}_${i}`,
				title: `Crear ${deliverableType} ${i}`,
				description: dependencyType
					? `Crea el entregable ${i} usando exactamente el artifact ${dependencyType}_${deliverableType}_${i}. Objetivo general: ${goal}`
					: `Crea el entregable ${i}. Objetivo general: ${goal}`,
				armKey: "ari",
				priority: dependencyType ? 2 : 1,
				acceptanceCriteria: [
					`Existe ${deliverableType}_${i} verificable y alineado al objetivo`,
				],
				requires: dependencyType
					? [
							{
								type: "artifact",
								artifactKey: `${dependencyType}_${deliverableType}_${i}`,
								artifactType: dependencyType,
							},
						]
					: [],
				produces: [
					{
						artifactKey: `${deliverableType}_${i}`,
						artifactType: deliverableType,
					},
				],
			});
		}
		return {
			goal,
			reasoning: dependencyType
				? "Heuristic generic artifact dependency pipeline."
				: "Heuristic generic independent deliverables plan.",
			tasks,
		};
	}

	private assertNoCycles(plan: KanbanPlanSpec): void {
		const graph = new Map<string, string[]>();
		const artifactProducer = new Map<string, string>();
		for (const task of plan.tasks) graph.set(task.key, []);
		for (const task of plan.tasks) {
			for (const artifact of task.produces ?? []) {
				artifactProducer.set(artifact.artifactKey, task.key);
			}
		}
		for (const task of plan.tasks) {
			for (const requirement of task.requires ?? []) {
				if (requirement.type === "task_status" && requirement.taskKey) {
					graph.get(requirement.taskKey)?.push(task.key);
				}
				if (requirement.type === "artifact" && requirement.artifactKey) {
					const producer = artifactProducer.get(requirement.artifactKey);
					if (producer) graph.get(producer)?.push(task.key);
				}
			}
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (key: string) => {
			if (visiting.has(key))
				throw new Error(`Cycle detected at task '${key}'.`);
			if (visited.has(key)) return;
			visiting.add(key);
			for (const next of graph.get(key) ?? []) visit(next);
			visiting.delete(key);
			visited.add(key);
		};
		for (const key of graph.keys()) visit(key);
	}
}
