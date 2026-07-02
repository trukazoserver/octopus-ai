import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LLMRouter } from "../ai/router.js";
import {
	coerceReasoningEffort,
	getModelCapabilitiesByRef,
} from "../ai/model-capabilities.js";
import type {
	ContentPart,
	LLMMessage,
	LLMRequest,
	LLMRequestMetadata,
	LLMResponse,
	LLMTool,
	LLMToolCall,
	ReasoningConfig,
} from "../ai/types.js";
import type { ChatManager, ChatTaskLedgerEntry } from "../chat/manager.js";
import type { LearningEngine, LearningInsight } from "../learning/index.js";
import type {
	ExperienceSkillTrace,
	ExperienceStatus,
	ExperienceToolTrace,
} from "../learning/types.js";
import type { MemoryConsolidator } from "../memory/consolidator.js";
import type { ContextAssembler } from "../memory/context-assembler.js";
import type { GlobalDailyMemory } from "../memory/daily.js";
import type { MemoryOrchestrator } from "../memory/orchestrator.js";
import type { MemoryRetrieval } from "../memory/retrieval.js";
import type { ShortTermMemory } from "../memory/stm.js";
import type {
	ConsolidationResult,
	MemoryContext,
	MemoryExplanation,
	MemoryPack,
} from "../memory/types.js";
import type { UserProfileManager } from "../memory/user-profile.js";
import { WorkingMemory } from "../memory/working-memory.js";
import type { SkillLoader } from "../skills/loader.js";
import { SkillResearcher } from "../skills/researcher.js";
import type { LoadedSkill } from "../skills/types.js";
import {
	MAX_TOTAL_DOC_CHARS,
	extractDocumentText,
	fenceLangFor,
	guessDocumentKind,
} from "../tools/document-extract.js";
import type { ToolExecutionContext, ToolExecutor } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/registry.js";
import type { ToolHealthManager } from "../tools/tool-health-manager.js";
import { getOctopusArmProfile } from "./arm-profiles.js";
import { routeTaskToArm } from "./arm-router.js";
import { ContinuityGuard } from "./continuity-guard.js";
import type { AgentEvent, EventStream } from "./event-stream.js";
import type { KanbanDispatcher } from "./kanban-dispatcher.js";
import type { KanbanPlanner } from "./kanban-planner.js";
import {
	OctopusOrchestrator,
	type OrchestratorConfig,
	type OrchestratorEvent,
} from "./orchestrator.js";
import type { RequirementResolver } from "./requirement-resolver.js";
import { RollingContextManager } from "./rolling-context.js";
import type {
	AgentConfig,
	AgentReasoningEffort,
	ConversationTurn,
	TaskState,
} from "./types.js";
import type { WorkflowManager } from "./workflow-manager.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 128;
const MAX_REPEATED_TOOL_SIGNATURES = 3;
const MAX_TOOL_RESULT_CONTEXT_CHARS = 12000;
const MAX_TOOL_RESULT_STORED_CHARS = 2000;
const DELEGATE_SYNTHESIS_TIMEOUT_MS = 10_000;
const DELEGATE_SYNTHESIS_MAX_TOKENS = 1200;
const DELEGATE_SYNTHESIS_RESULT_CHARS = 1500;
const REQUIRED_RECENT_RAW_TURNS = 20;
const STM_MIN_TURNS = 30;
const STM_MAX_TURNS = 60;
const TOOL_IMAGE_RE = /\[IMG:(data:image\/[a-zA-Z0-9-]+;base64,[^\]]+)\]/;
const TOOL_IMAGE_RE_GLOBAL =
	/\[IMG:(data:image\/[a-zA-Z0-9-]+;base64,[^\]]+)\]/g;
const MEDIA_FILE_RE = /\/api\/media\/file\/([^\s)\]]+)/g;
const ZAI_VISION_REQUIRED_MARKER = "[ZAI VISION REQUIRED]";
const ZAI_VISION_REQUIRED_RE = /\s*\[ZAI VISION REQUIRED\][\s\S]*$/;
const VISIBLE_MEMORY_IDENTIFIER_RE =
	/\b(?=[A-Za-z0-9_-]{8,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*\b/g;

type ObjectiveKind = "media_collection" | "generic";

interface EvidenceLedger {
	objectiveKind: ObjectiveKind;
	requestedItemCount?: number;
	imageUrls: string[];
	mediaUrls: string[];
	capturedScreenshots: string[];
	detailScreenshots: string[];
	detailUrl?: string;
	listUrl?: string;
	blockers: string[];
	usefulResults: number;
	consecutiveErrors: number;
	/** Domain patterns for recognizing image CDN URLs (e.g., 'etsystatic.com', 'images-amazon.com') */
	imageCdnPatterns: string[];
	toolHistory: Array<{
		name: string;
		success: boolean;
		useful: boolean;
		summary: string;
	}>;
}

interface DelegateWorkflowTask {
	id: string;
	role: string;
	task: string;
	armKey?: string;
	produces?: Array<Record<string, unknown>>;
	model?: string;
}

interface DelegateWorkflowState {
	runId: string;
	taskIds: Map<string, string>;
}

interface DelegateTaskResult {
	workerId: string;
	role: string;
	task: string;
	result: string;
	error?: string;
}

function parseDelegateProduces(
	value: unknown,
): Array<Record<string, unknown>> | undefined {
	if (Array.isArray(value)) {
		const artifacts = value.filter(
			(item): item is Record<string, unknown> =>
				Boolean(item) && typeof item === "object" && !Array.isArray(item),
		);
		return artifacts.length > 0 ? artifacts : undefined;
	}
	if (typeof value === "string" && value.trim()) {
		return [{ artifactKey: value.trim(), artifactType: "result" }];
	}
	return undefined;
}

type ToolDecision =
	| { action: "execute" }
	| { action: "skip"; reason: string }
	| { action: "stop"; reason: string };

export interface RuntimeMemoryTrace {
	responseId: string;
	generatedAt: Date;
	objective: string;
	channelId?: string;
	uncertaintyLevel: string;
	memoryIds: string[];
	knownGaps: string[];
	proactiveNotices: string[];
	degradedSections: string[];
}

export interface AgentProcessOptions {
	signal?: AbortSignal;
	selectedAgentContext?: RuntimeSelectedAgentContext | null;
	disableOrchestrator?: boolean;
	disableDelegation?: boolean;
}

export interface RuntimeSelectedAgentContext {
	id: string;
	name: string;
	description?: string | null;
	role?: string | null;
	personality?: string | null;
	systemPrompt?: string | null;
	model?: string | null;
	avatar?: string | null;
	color?: string | null;
	armKey?: string | null;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Execution cancelled");
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(
				() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		}),
	]);
}

export function requiresZaiVisionToolForModel(model?: string): boolean {
	const normalized = (model ?? "").trim().toLowerCase();
	if (!normalized) return false;
	const slashIndex = normalized.indexOf("/");
	if (slashIndex === -1) return normalized.startsWith("glm-");
	const provider = normalized.slice(0, slashIndex);
	const modelName = normalized.slice(slashIndex + 1);
	return (
		(provider === "zhipu" || provider === "zai" || provider === "z-ai") &&
		modelName.startsWith("glm-")
	);
}

/**
 * True when `model` CANNOT see images natively and must therefore route any
 * image content through an external vision tool. Covers Z.ai GLM (special-cased
 * to the Z.AI Vision MCP tool) and any model whose provider is not multimodal
 * (e.g. text-only providers such as DeepSeek).
 *
 * `supportsVision` is injected so this stays pure and testable; the runtime
 * wires it to {@link LLMRouter.supportsVisionForModel}.
 */
export function requiresExternalVisionToolForModel(
	model: string | undefined,
	supportsVision: (model: string) => boolean,
): boolean {
	if (requiresZaiVisionToolForModel(model)) return true;
	const resolved = (model ?? "").trim() || "default";
	return !supportsVision(resolved);
}

export class AgentRuntime {
	private config: AgentConfig;
	private llmRouter: LLMRouter;
	public stm: ShortTermMemory;
	private memoryRetrieval: MemoryRetrieval;
	private memoryConsolidator: MemoryConsolidator;
	private skillLoader: SkillLoader;
	private toolRegistry?: ToolRegistry;
	private toolExecutor?: ToolExecutor;
	private toolHealth?: ToolHealthManager;
	private researcher?: SkillResearcher;
	private dailyMemory?: GlobalDailyMemory;
	private userProfileManager?: UserProfileManager;
	private memoryOrchestrator?: MemoryOrchestrator;
	private contextAssembler?: ContextAssembler;
	private learningEngine?: LearningEngine;
	private chatManager?: ChatManager;
	private workflowManager?: WorkflowManager;
	private orchestrator?: OctopusOrchestrator;
	private kanbanPlanner?: KanbanPlanner;
	private requirementResolver?: RequirementResolver;
	private kanbanDispatcher?: KanbanDispatcher;
	private durableEventStream?: EventStream;
	private readonly toolBillingFailures = new Map<string, number>();
	private subtaskTracker?: import("./subtask-tracker.js").SubtaskTracker;
	private continuityGuard: ContinuityGuard;
	private workingMemory: WorkingMemory = new WorkingMemory();
	private rollingContext: RollingContextManager;
	private rollingContexts = new Map<string, RollingContextManager>();
	private rollingContextHydrated = new Set<string>();
	private lastMemoryTrace?: RuntimeMemoryTrace;

	constructor(
		config: AgentConfig,
		llmRouter: LLMRouter,
		stm: ShortTermMemory,
		memoryRetrieval: MemoryRetrieval,
		memoryConsolidator: MemoryConsolidator,
		skillLoader: SkillLoader,
	) {
		this.config = config;
		this.llmRouter = llmRouter;
		this.stm = stm;
		this.memoryRetrieval = memoryRetrieval;
		this.memoryConsolidator = memoryConsolidator;
		this.skillLoader = skillLoader;
		// In relentless mode, use much higher auto-continuation limit
		if (config.tenacidad?.level === "tenaz") {
			const guardConfig = config.continuityGuard ?? {};
			this.continuityGuard = new ContinuityGuard({
				...guardConfig,
				maxAutoContinuations: guardConfig.maxAutoContinuations ?? 50,
				maxStallForcings: guardConfig.maxStallForcings ?? 5,
			});
		} else {
			this.continuityGuard = new ContinuityGuard(config.continuityGuard);
		}
		this.rollingContext = new RollingContextManager(llmRouter);
		this.rollingContexts.set("__default__", this.rollingContext);
	}

	private createRollingContext(key: string): RollingContextManager {
		return new RollingContextManager(this.llmRouter, async (summary) => {
			if (!this.chatManager || key === "__default__") return;
			await this.chatManager.saveConversationContextSnapshot?.(key, summary);
		});
	}

	private async getRollingContext(
		channelId?: string,
	): Promise<RollingContextManager> {
		const key = channelId || "__default__";
		let manager = this.rollingContexts.get(key);
		if (!manager) {
			manager = this.createRollingContext(key);
			this.rollingContexts.set(key, manager);
		}
		if (
			key !== "__default__" &&
			!this.rollingContextHydrated.has(key) &&
			!manager.getSummary()
		) {
			this.rollingContextHydrated.add(key);
			const snapshot =
				await this.chatManager?.getConversationContextSnapshot?.(key);
			if (snapshot?.rolling_summary) {
				manager.setSummary(snapshot.rolling_summary);
			}
		}
		return manager;
	}

	setToolSystem(registry: ToolRegistry, executor: ToolExecutor): void {
		this.toolRegistry = registry;
		this.toolExecutor = executor;
	}

	setToolHealthManager(manager: ToolHealthManager): void {
		this.toolHealth = manager;
	}

	/**
	 * Cablea el investigador de documentación fresca (Context7 → web → browser).
	 * Lo usa buildContext para inyectar docs verificadas antes de tareas de código.
	 */
	setResearcher(researcher: SkillResearcher): void {
		this.researcher = researcher;
	}

	setDailyMemory(dailyMemory: GlobalDailyMemory): void {
		this.dailyMemory = dailyMemory;
	}

	setUserProfileManager(manager: UserProfileManager): void {
		this.userProfileManager = manager;
	}

	setMemoryOrchestrator(orchestrator: MemoryOrchestrator): void {
		this.memoryOrchestrator = orchestrator;
	}

	setContextAssembler(assembler: ContextAssembler): void {
		this.contextAssembler = assembler;
	}

	getLastMemoryTrace(): RuntimeMemoryTrace | undefined {
		return this.lastMemoryTrace;
	}

	async explainLastMemoryUsage(): Promise<{
		trace?: RuntimeMemoryTrace;
		explanations: MemoryExplanation[];
	}> {
		if (!this.lastMemoryTrace || !this.memoryOrchestrator) {
			return { trace: this.lastMemoryTrace, explanations: [] };
		}
		const explanations = await this.memoryOrchestrator.explain(
			this.lastMemoryTrace.memoryIds,
		);
		return { trace: this.lastMemoryTrace, explanations };
	}

	setLearningEngine(engine: LearningEngine): void {
		this.learningEngine = engine;
	}

	setChatManager(manager: ChatManager): void {
		this.chatManager = manager;
	}

	setWorkflowManager(manager: WorkflowManager): void {
		this.workflowManager = manager;
	}
	setKanbanPlanner(planner: KanbanPlanner): void {
		this.kanbanPlanner = planner;
	}

	setRequirementResolver(resolver: RequirementResolver): void {
		this.requirementResolver = resolver;
	}

	setKanbanDispatcher(dispatcher: KanbanDispatcher): void {
		this.kanbanDispatcher = dispatcher;
	}

	setDurableEventStream(stream: EventStream): void {
		this.durableEventStream = stream;
	}

	/**
	 * After a successful kanban_create_plan_from_goal, optionally stream the
	 * durable workflow's progress live into the chat (Hermes-style) until all
	 * cards complete or the user interrupts. No-op unless a dispatcher and
	 * event stream are wired via setKanbanDispatcher/setDurableEventStream.
	 */
	private async *maybeStreamCreatedWorkflow(
		toolCall: LLMToolCall,
		toolResult: ToolResult,
		signal: AbortSignal | undefined,
	): AsyncGenerator<string> {
		if (
			toolCall.function.name !== "kanban_create_plan_from_goal" ||
			!toolResult.success ||
			!this.kanbanDispatcher ||
			!this.durableEventStream
		) {
			return;
		}
		const planMeta = toolResult.metadata as
			| { run?: { id?: string }; tasks?: Array<{ id?: string }> }
			| undefined;
		const runId = planMeta?.run?.id;
		const taskIds =
			planMeta?.tasks?.map((t) => t.id).filter((id): id is string => !!id) ??
			[];
		if (!runId || taskIds.length === 0) return;
		yield* this.streamDurableWorkflow(runId, taskIds, signal);
	}

	/**
	 * Drive the dispatcher's ticks and stream workflow events live until all
	 * tasks complete, the user aborts, or the stream budget is exhausted. The
	 * workflow itself keeps running in the background via the cron scheduler
	 * even if this loop exits early.
	 */
	private async *streamDurableWorkflow(
		runId: string,
		taskIds: string[],
		signal: AbortSignal | undefined,
	): AsyncGenerator<string> {
		const dispatcher = this.kanbanDispatcher;
		const stream = this.durableEventStream;
		if (!dispatcher || !stream) return;

		const pending: AgentEvent[] = [];
		const unsubscribe = stream.subscribe((event) => {
			if (event.runId === runId) pending.push(event);
		});

		const pollMs =
			Number.parseInt(
				process.env.OCTOPUS_WORKFLOW_STREAM_POLL_MS ?? "1500",
				10,
			) || 1500;
		const maxWaitMs =
			Number.parseInt(
				process.env.OCTOPUS_WORKFLOW_STREAM_MAX_MS ?? "1800000",
				10,
			) || 1800000;
		const startedAt = Date.now();
		let idleTicks = 0;

		try {
			yield `\n🟢 Workflow ${runId} en ejecución (${taskIds.length} subtareas). Streaming en vivo…\n\n`;
			while (true) {
				throwIfAborted(signal);
				if (Date.now() - startedAt > maxWaitMs) {
					yield `\n⏱ Stream pausado tras ${Math.round(maxWaitMs / 60000)} min; el workflow sigue en background.\n`;
					return;
				}
				try {
					await dispatcher.tick();
				} catch {
					/* transient tick errors must not kill the stream */
				}
				while (pending.length > 0) {
					const event = pending.shift();
					if (!event) continue;
					const message = event.data?.message ?? event.type;
					const prefix =
						event.type === "result"
							? "✅"
							: event.type === "error"
								? "❌"
								: event.type === "task_claimed"
									? "▶"
									: "📋";
					yield `${prefix} ${message}\n`;
				}
				if (stream.areAllTasksComplete(taskIds, runId)) {
					yield `\n✅ Workflow ${runId} completado.\n`;
					return;
				}
				if (dispatcher.getStatus().activeCount === 0) {
					idleTicks += 1;
					if (idleTicks >= 3) {
						yield "\n⏸ No hay cards activas ahora; el workflow continúa en background (algunas pueden requerir revisión).\n";
						return;
					}
				} else {
					idleTicks = 0;
				}
				await new Promise((resolve) => setTimeout(resolve, pollMs));
			}
		} finally {
			unsubscribe();
		}
	}

	setSubtaskTracker(
		tracker: import("./subtask-tracker.js").SubtaskTracker,
	): void {
		this.subtaskTracker = tracker;
	}

	setContinuityGuard(
		guard: import("./continuity-guard.js").ContinuityGuard,
	): void {
		this.continuityGuard = guard;
	}

	private isMediaWorkflowTool(toolName: string): boolean {
		return /(?:nano-banana|veo-video|image|video|audio|media|tts|save_media|import_media)/i.test(
			toolName,
		);
	}

	private shouldAutoContinueAfterToolLimit(
		ledger: EvidenceLedger,
		toolsUsed: Array<{ name: string }>,
	): boolean {
		const persistence = this.getTenacidad();

		// In relentless mode: always continue unless genuine API failure
		if (persistence.enabled) {
			return ledger.consecutiveErrors < persistence.maxGenuineApiErrors;
		}

		if (ledger.consecutiveErrors >= 3) return false;
		return (
			ledger.objectiveKind === "media_collection" ||
			Boolean(ledger.requestedItemCount) ||
			toolsUsed.some((tool) => this.isMediaWorkflowTool(tool.name))
		);
	}

	private async buildToolLimitAutoContinuePrompt(input: {
		guard: ContinuityGuard;
		ledger: EvidenceLedger;
		toolsUsed: Array<{ name: string }>;
		iterations: number;
		inlineRunId?: string;
	}): Promise<string | null> {
		if (!this.shouldAutoContinueAfterToolLimit(input.ledger, input.toolsUsed)) {
			return null;
		}
		const maxIterations = this.getToolIterationLimit().maxIterations;
		input.guard.recordFinishReason("tool_iteration_limit");
		const shouldContinue = input.guard.shouldAutoContinue({
			finishReason: "tool_iteration_limit",
			hasToolCalls: input.toolsUsed.length > 0,
			hasContent: true,
			iterationCount: input.iterations,
			maxIterations,
			inlineRunId: input.inlineRunId,
		});
		if (!shouldContinue) return null;

		input.guard.incrementContinuation();
		let reconciliationReport = null;
		if (this.subtaskTracker && input.inlineRunId) {
			try {
				reconciliationReport =
					await this.subtaskTracker.reconcileInterruptedRun(input.inlineRunId);
			} catch {
				/* non-critical */
			}
		}

		return [
			input.guard.buildContinuePrompt(reconciliationReport),
			"The previous segment exhausted the per-response tool iteration budget, but the original user goal remains active.",
			"Continue automatically from the first missing deliverable using the existing evidence ledger and generated media URLs.",
			"Do not ask the user to type 'continua' or wait for confirmation unless a missing credential, missing required reference, safety issue, or external manual action blocks progress.",
		].join("\n");
	}

	/**
	 * Configura el orquestador multi-agente para ejecución paralela.
	 * Si se configura, las tareas complejas se descomponen automáticamente.
	 */
	enableOrchestrator(config?: Partial<OrchestratorConfig>): void {
		if (!this.toolRegistry || !this.toolExecutor) {
			console.warn(
				"[Orchestrator] Tool system not configured yet. Call setToolSystem first.",
			);
			return;
		}
		this.orchestrator = new OctopusOrchestrator(
			this.llmRouter,
			this.toolRegistry,
			this.toolExecutor,
			this.config,
			config,
			this.workflowManager,
		);
	}

	/**
	 * Obtener el orquestador (para acceso directo desde el servidor).
	 */
	getOrchestrator(): OctopusOrchestrator | undefined {
		return this.orchestrator;
	}

	setToolIterationLimit(
		toolIterationLimit: AgentConfig["toolIterationLimit"],
	): void {
		this.config = { ...this.config, toolIterationLimit };
	}

	/** Read-only view of the effective runtime config (model, reasoning, etc.). */
	getConfig(): Readonly<AgentConfig> {
		return this.config;
	}

	/**
	 * Live reconfiguration of model / reasoning / sampling without rebuilding the
	 * runtime. Preserves all wired subsystems (tools, memory, orchestrator, ...).
	 * Called when an agent's model or reasoning is changed from the UI.
	 */
	updateConfig(patch: {
		model?: string;
		reasoningEffort?: AgentReasoningEffort;
		maxTokens?: number;
		temperature?: number;
	}): void {
		this.config = {
			...this.config,
			...(patch.model !== undefined ? { model: patch.model } : {}),
			...(patch.reasoningEffort !== undefined
				? { reasoningEffort: patch.reasoningEffort }
				: {}),
			...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
			...(patch.temperature !== undefined
				? { temperature: patch.temperature }
				: {}),
		};
	}

	/**
	 * Per-agent reasoning config derived from this runtime's profile. Always
	 * returns a defined object so the router's global `thinking` never silently
	 * overrides an agent that explicitly wants "none".
	 */
	private buildReasoning(): ReasoningConfig {
		// Coerce the configured effort against the *current* model's capabilities
		// so a model switch (or a stale profile) can never send an effort the
		// model rejects — e.g. "none" to an always-reasoning o-series, or "xhigh"
		// to a model that tops out at "high". If the model can't be resolved we
		// fall back to the configured value unchanged.
		const desired: AgentReasoningEffort =
			this.config.reasoningEffort ?? "none";
		const caps = getModelCapabilitiesByRef(this.config.model);
		const effort = caps ? coerceReasoningEffort(caps, desired) : desired;
		return {
			effort,
			includeThinking: effort !== "none",
		};
	}

	/** Metadata attached to every LLM request this runtime issues (usage attribution). */
	private requestMetadata(
		extra?: Partial<LLMRequestMetadata>,
	): LLMRequestMetadata {
		return {
			agentId: this.config.id,
			...extra,
		};
	}

	private toSkillTrace(skills: LoadedSkill[]): ExperienceSkillTrace[] {
		return skills.map((loaded) => ({
			id: loaded.skill.id,
			name: loaded.skill.name,
			level: loaded.level,
		}));
	}

	private async getRelevantLearning(
		message: string,
	): Promise<LearningInsight[]> {
		if (!this.learningEngine) return [];
		try {
			return await this.learningEngine.retrieveRelevant(message);
		} catch {
			return [];
		}
	}

	private recordLearningExperience(input: {
		userRequest: string;
		finalResponse: string;
		channelId?: string;
		startedAt: number;
		toolsUsed?: ExperienceToolTrace[];
		skillsUsed?: ExperienceSkillTrace[];
		status?: ExperienceStatus;
		metadata?: Record<string, unknown>;
	}): void {
		if (!this.learningEngine) return;
		if (this.learningEngine.isEnabled?.() === false) return;
		this.learningEngine
			.recordExperience({
				agentId: this.config.id,
				conversationId: input.channelId,
				channelId: input.channelId,
				userRequest: input.userRequest,
				finalResponse: input.finalResponse,
				status:
					input.status ??
					this.inferLearningStatus(input.finalResponse, input.toolsUsed ?? []),
				toolsUsed: input.toolsUsed,
				skillsUsed: input.skillsUsed,
				durationMs: Date.now() - input.startedAt,
				metadata: input.metadata,
			})
			.catch((err) => console.error("Learning experience record failed:", err));
	}

	private inferLearningStatus(
		finalResponse: string,
		toolsUsed: ExperienceToolTrace[],
	): ExperienceStatus {
		const lower = finalResponse.toLowerCase();
		const failedTools = toolsUsed.filter((tool) => !tool.success).length;
		const successfulTools = toolsUsed.length - failedTools;
		if (/error|failed|fall[oó]|bloque|captcha|limit|l[ií]mite/.test(lower)) {
			return successfulTools > 0 ? "partial" : "failed";
		}
		if (failedTools > successfulTools) return "partial";
		if (finalResponse.trim().length > 40) return "succeeded";
		return "unknown";
	}

	private getRecentTurnsForProfile(
		latestTurns: ConversationTurn[],
	): ConversationTurn[] {
		const seen = new Set<ConversationTurn>();
		const turns = [...this.stm.getContext().slice(-8), ...latestTurns];
		return turns.filter((turn) => {
			if (seen.has(turn)) return false;
			seen.add(turn);
			return true;
		});
	}

	private recordAuxiliaryMemories(
		userTurn: ConversationTurn,
		assistantTurn: ConversationTurn,
		channelId?: string,
	): void {
		if (this.userProfileManager) {
			this.userProfileManager
				.updateFromConversation(
					"owner",
					this.getRecentTurnsForProfile([userTurn, assistantTurn]),
				)
				.catch((err) => console.error("Failed to update user profile:", err));
		}

		this.dailyMemory
			?.addMessage(userTurn.content, "user", channelId || "system")
			.catch(() => {});
		this.dailyMemory
			?.addMessage(assistantTurn.content, "assistant", channelId || "system")
			.catch(() => {});

		this.recordExplicitUserMemoryCandidates(userTurn, channelId);
	}

	private recordExplicitUserMemoryCandidates(
		userTurn: ConversationTurn,
		channelId?: string,
	): void {
		if (!this.memoryOrchestrator) return;
		const content = userTurn.content.trim();
		if (!content) return;
		const isPreference =
			/\b(me llamo|mi nombre es|ll[aá]mame|prefiero|me gusta que|no me gusta|no quiero que|responde en|respondas en|my name is|call me|i prefer|please respond in)\b/i.test(
				content,
			);
		const isProspective =
			/\b(recuerdame|recu[eé]rdame|no olvides|pendiente|deadline|fecha l[ií]mite|remind me|follow up)\b/i.test(
				content,
			);
		const isProceduralCorrection =
			this.looksLikeUserFeedbackOrCorrection(content) &&
			/\b(modelo|modelos|tool|herramienta|veo|ffmpeg|procedimiento|flujo|pipeline|generaci[oó]n|video|imagen|referencia|frame|par[aá]metro|acepta|usar|utilizar)\b/i.test(
				content,
			);
		if (!isPreference && !isProspective && !isProceduralCorrection) return;

		if (isProceduralCorrection) {
			this.learningEngine
				?.recordUserCorrection?.({
					content,
					conversationId: channelId,
					channelId,
					agentId: this.config.id,
				})
				.catch((err) =>
					console.error("Failed to record user correction learning:", err),
				);
		}

		this.memoryOrchestrator
			.write({
				type: isProspective
					? "prospective"
					: isProceduralCorrection
						? "procedural"
						: "user",
				content,
				sourceTrust: "user_explicit",
				scope: {
					tenantId: "local",
					userId: "owner",
					projectId: process.cwd(),
					agentRole: this.config.id,
					sessionId: channelId,
				},
				source: { channelId },
				evidence: {
					sourceType: "message",
					sourceId: channelId,
					excerpt: content.slice(0, 1200),
				},
				metadata: {
					capturedBy: "agent_runtime_explicit_signal",
					...(isProspective
						? {
								prospectiveStatus: "pending",
								dueAt: this.extractProspectiveDueAt(content)?.toISOString(),
								triggerCondition: this.extractProspectiveTrigger(content),
							}
						: {}),
					originalRole: userTurn.role,
				},
			})
			.catch((err) =>
				console.error("Failed to write orchestrated memory:", err),
			);
	}

	private extractProspectiveDueAt(content: string): Date | undefined {
		const now = new Date();
		const lower = content.toLowerCase();
		if (/\b(mañana|tomorrow)\b/.test(lower)) {
			const due = new Date(now);
			due.setDate(due.getDate() + 1);
			due.setHours(9, 0, 0, 0);
			return due;
		}
		if (/\b(hoy|today)\b/.test(lower)) {
			const due = new Date(now);
			due.setHours(18, 0, 0, 0);
			return due;
		}
		const isoLike = content.match(
			/\b(20\d{2}-\d{2}-\d{2})(?:[ t](\d{1,2}:\d{2}))?\b/i,
		);
		if (isoLike?.[1]) {
			const parsed = new Date(`${isoLike[1]}T${isoLike[2] ?? "09:00"}:00`);
			return Number.isNaN(parsed.getTime()) ? undefined : parsed;
		}
		const weekday = lower.match(
			/\b(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
		);
		if (weekday?.[1]) return this.nextWeekdayDate(weekday[1], now);
		return undefined;
	}

	private extractProspectiveTrigger(content: string): string | undefined {
		const match = content.match(/\b(?:cuando|if|when)\s+([^.!?\n]{4,120})/i);
		return match?.[1]?.trim();
	}

	private nextWeekdayDate(day: string, from: Date): Date | undefined {
		const weekdays: Record<string, number> = {
			domingo: 0,
			sunday: 0,
			lunes: 1,
			monday: 1,
			martes: 2,
			tuesday: 2,
			miércoles: 3,
			miercoles: 3,
			wednesday: 3,
			jueves: 4,
			thursday: 4,
			viernes: 5,
			friday: 5,
			sábado: 6,
			sabado: 6,
			saturday: 6,
		};
		const target = weekdays[day];
		if (target === undefined) return undefined;
		const due = new Date(from);
		const delta = (target - due.getDay() + 7) % 7 || 7;
		due.setDate(due.getDate() + delta);
		due.setHours(9, 0, 0, 0);
		return due;
	}

	/**
	 * Whether the active model cannot see images natively and must route image
	 * content through an external vision tool (Z.ai GLM, or any text-only model).
	 * The field name `usesZaiVisionToolForImages` is kept for backward
	 * compatibility with tool consumers (browser, executor, worker-pool, tests).
	 */
	private shouldUseZaiVisionToolsForImages(): boolean {
		return requiresExternalVisionToolForModel(this.config.model, (m) =>
			this.llmRouter.supportsVisionForModel(m),
		);
	}

	/** Whether the active model can see images natively (multimodal, non-GLM). */
	private modelSeesImagesNatively(): boolean {
		return !this.shouldUseZaiVisionToolsForImages();
	}

	private getToolExecutionContext(): ToolExecutionContext {
		return {
			agentId: this.config.id,
			model: this.config.model,
			usesZaiVisionToolForImages: this.shouldUseZaiVisionToolsForImages(),
		};
	}

	private async startDelegateWorkflow(
		message: string,
		channelId: string | undefined,
		tasks: DelegateWorkflowTask[],
	): Promise<DelegateWorkflowState | null> {
		if (!this.workflowManager) return null;
		try {
			const run = await this.workflowManager.createRun({
				conversationId: channelId,
				rootAgentId: this.config.id,
				goal: message,
				metadata: {
					source: "kanban_swarm_delegate",
					workflowKind: "kanban_swarm",
					executionPlan: "parallel",
					taskCount: tasks.length,
				},
			});
			await this.workflowManager.updateRunStatus(run.id, "running", {
				currentPhase: "delegation",
			});
			const taskIds = new Map<string, string>();
			for (const task of tasks) {
				const routedArm = task.armKey
					? getOctopusArmProfile(task.armKey)
					: routeTaskToArm({ role: task.role, description: task.task });
				const workflowTask = await this.workflowManager.createTask({
					runId: run.id,
					assignedAgentId: routedArm?.agentId ?? this.config.id,
					armKey: routedArm?.key,
					title: `${task.role}: ${task.task.slice(0, 80)}`,
					description: task.task,
					priority: 3,
					produces: task.produces,
					model: task.model,
					metadata: {
						source: "kanban_swarm_delegate",
						workflowKind: "kanban_swarm",
						sourceTaskId: task.id,
						role: task.role,
						armKey: routedArm?.key,
						agentId: routedArm?.agentId,
						agentName: routedArm?.name,
					},
				});
				taskIds.set(task.id, workflowTask.id);
			}
			await this.requirementResolver?.evaluatePendingRequirements({
				runId: run.id,
			});
			await this.workflowManager.recordEvent({
				runId: run.id,
				agentId: this.config.id,
				eventType: "decomposition",
				message: `Delegated ${tasks.length} tasks via delegate_task.`,
				metadata: {
					source: "kanban_swarm_delegate",
					workflowKind: "kanban_swarm",
					subtasks: tasks.map((task) => ({
						id: task.id,
						workflowTaskId: taskIds.get(task.id),
						role: task.role,
						armKey: task.armKey,
						model: task.model,
					})),
				},
			});
			return { runId: run.id, taskIds };
		} catch (err) {
			console.error(
				"Failed to persist delegate_task workflow:",
				err instanceof Error ? err.message : err,
			);
			return null;
		}
	}

	private async updateDelegateWorkflowTask(
		workflow: DelegateWorkflowState | null,
		workerId: string,
		status: "running" | "done" | "failed",
		message: string,
	): Promise<void> {
		if (!workflow || !this.workflowManager) return;
		const taskId = workflow.taskIds.get(workerId);
		if (!taskId) return;
		try {
			await this.workflowManager.updateTaskStatus(taskId, status, {
				stepKey: status === "running" ? "delegate_task" : "result",
				progressSignature: `${status}:${message.slice(0, 200)}`,
			});
			await this.workflowManager.recordEvent({
				runId: workflow.runId,
				taskId,
				agentId: this.config.id,
				eventType: status === "failed" ? "error" : status,
				message: message.slice(0, 4000),
				toolName: "delegate_task",
				metadata: {
					source: "kanban_swarm_delegate",
					workflowKind: "kanban_swarm",
					workerId,
				},
			});
		} catch (err) {
			console.error(
				"Failed to update delegate_task workflow:",
				err instanceof Error ? err.message : err,
			);
		}
	}

	private async finishDelegateWorkflow(
		workflow: DelegateWorkflowState | null,
		results: DelegateTaskResult[],
		finalResponse: string,
	): Promise<void> {
		if (!workflow || !this.workflowManager) return;
		const failed = results.filter((result) => result.error).length;
		const succeeded = results.length - failed;
		const status = failed > 0 ? (succeeded > 0 ? "partial" : "failed") : "done";
		try {
			await this.workflowManager.updateRunStatus(workflow.runId, status, {
				currentPhase: "synthesis",
				metadata: {
					source: "kanban_swarm_delegate",
					workflowKind: "kanban_swarm",
					succeeded,
					failed,
				},
			});
			await this.workflowManager.recordEvent({
				runId: workflow.runId,
				agentId: this.config.id,
				eventType: "synthesis",
				message: finalResponse.slice(0, 4000),
				metadata: {
					source: "kanban_swarm_delegate",
					workflowKind: "kanban_swarm",
					succeeded,
					failed,
				},
			});
		} catch (err) {
			console.error(
				"Failed to finish delegate_task workflow:",
				err instanceof Error ? err.message : err,
			);
		}
	}

	private getTenacidad(): {
		enabled: boolean;
		maxGenuineApiErrors: number;
		streamErrorRetries: number;
		emptyResponseRetries: number;
	} {
		const tp = this.config.tenacidad;
		const enabled = tp?.level === "tenaz";
		return {
			enabled,
			maxGenuineApiErrors: tp?.maxGenuineApiErrors ?? 3,
			streamErrorRetries: tp?.streamErrorRetries ?? (enabled ? 3 : 0),
			emptyResponseRetries: tp?.emptyResponseRetries ?? (enabled ? 3 : 0),
		};
	}

	private isGenuineApiError(message: string): boolean {
		return /auth|unauthorized|forbidden|invalid.?api.?key|quota.?exceed|billing|payment|required/i.test(
			message,
		);
	}

	private getMaxRepeatedToolSignatures(): number {
		return this.getTenacidad().enabled ? 5 : MAX_REPEATED_TOOL_SIGNATURES;
	}

	private getToolIterationLimit(): { enabled: boolean; maxIterations: number } {
		const configuredMax = this.config.toolIterationLimit?.maxIterations;
		const persistence = this.getTenacidad();
		const defaultMax = persistence.enabled ? 512 : DEFAULT_MAX_TOOL_ITERATIONS;
		const maxIterations =
			typeof configuredMax === "number" && Number.isFinite(configuredMax)
				? Math.max(1, Math.trunc(configuredMax))
				: defaultMax;

		return {
			enabled: this.config.toolIterationLimit?.enabled ?? true,
			maxIterations,
		};
	}

	private hasToolIterationsRemaining(iterations: number): boolean {
		const limit = this.getToolIterationLimit();
		return !limit.enabled || iterations < limit.maxIterations;
	}

	private getRemainingToolIterations(iterations: number): number | null {
		const limit = this.getToolIterationLimit();
		if (!limit.enabled) return null;
		return Math.max(0, limit.maxIterations - iterations);
	}

	private hasReachedToolIterationLimit(iterations: number): boolean {
		const limit = this.getToolIterationLimit();
		return limit.enabled && iterations >= limit.maxIterations;
	}

	private getLocalMediaPathsFromContent(content: string): string[] {
		const localPaths = new Set<string>();
		MEDIA_FILE_RE.lastIndex = 0;
		for (const match of content.matchAll(MEDIA_FILE_RE)) {
			const rawFilename = match[1]?.split(/[?#]/)[0];
			if (!rawFilename) continue;
			let filename = rawFilename;
			try {
				filename = decodeURIComponent(rawFilename);
			} catch {
				/* use raw filename */
			}
			localPaths.add(path.join(os.homedir(), ".octopus", "media", filename));
		}
		return Array.from(localPaths);
	}

	private guessImageMime(filePath: string): string {
		switch (path.extname(filePath).toLowerCase()) {
			case ".jpg":
			case ".jpeg":
				return "image/jpeg";
			case ".webp":
				return "image/webp";
			case ".gif":
				return "image/gif";
			case ".svg":
				return "image/svg+xml";
			default:
				return "image/png";
		}
	}

	private static readonly IMAGE_MEDIA_EXTS = new Set([
		".png",
		".jpg",
		".jpeg",
		".gif",
		".webp",
		".svg",
		".bmp",
		".ico",
	]);

	private isImageMediaFilename(filename: string): boolean {
		return AgentRuntime.IMAGE_MEDIA_EXTS.has(
			path.extname(filename).toLowerCase(),
		);
	}

	/**
	 * Build native image_url content parts for the inline `[IMG:base64]` markers
	 * and the local media file references found in `sources`. Used for models that
	 * can see images natively, so they receive the actual image bytes instead of a
	 * text placeholder.
	 *
	 * `text` is the cleaned text part (already stripped of inline base64 /
	 * truncated as needed by the caller); `sources` is the raw content scanned for
	 * image references.
	 */
	private toImageContentParts(
		text: string,
		sources: string = text,
	): ContentPart[] {
		const parts: ContentPart[] = [
			{ type: "text", text: text || "Image data." },
		];
		parts.push(...this.inlineBase64ImageParts(sources));
		parts.push(...this.localMediaImageParts(sources));
		return parts;
	}

	private inlineBase64ImageParts(content: string): ContentPart[] {
		const parts: ContentPart[] = [];
		TOOL_IMAGE_RE_GLOBAL.lastIndex = 0;
		for (const match of content.matchAll(TOOL_IMAGE_RE_GLOBAL)) {
			const dataUrl = match[1];
			if (dataUrl) {
				parts.push({ type: "image_url", image_url: { url: dataUrl } });
			}
		}
		return parts;
	}

	private localMediaImageParts(content: string): ContentPart[] {
		const parts: ContentPart[] = [];
		for (const localPath of this.getLocalMediaPathsFromContent(content)) {
			try {
				if (!fs.existsSync(localPath)) continue;
				const mimeType = this.guessImageMime(localPath);
				if (!mimeType.startsWith("image/")) continue;
				const data = fs.readFileSync(localPath).toString("base64");
				parts.push({
					type: "image_url",
					image_url: { url: `data:${mimeType};base64,${data}` },
				});
			} catch {
				/* ignore unreadable media */
			}
		}
		return parts;
	}

	/**
	 * Attach the local media paths for an image-bearing message as a discrete
	 * HTML comment.
	 *
	 * The directive to call a Z.AI Vision MCP tool lives in the system prompt,
	 * NOT here. Inlining the `[ZAI VISION REQUIRED] ...` imperative into message
	 * content made Z.ai GLM echo it back verbatim into its visible reply. Keeping
	 * only the paths (data, not an instruction) avoids that echo while still
	 * letting the model resolve the image to pass to the vision tool.
	 */
	private appendZaiVisionHint(content: string, localPaths: string[]): string {
		if (localPaths.length === 0) return content;
		const quotedPaths = localPaths.map((p) => JSON.stringify(p)).join(", ");
		return `${content}\n\n<!-- octopus-local-media-paths: ${quotedPaths} -->`;
	}

	/**
	 * Inline extracted text from non-image attachments (pdf, office docs,
	 * spreadsheets, code, text, ...) into the most recent user message so the
	 * model can read them directly. Only mutates the LLM-bound copy of the
	 * messages (never STM), so the chat UI is unaffected. Runs for every model.
	 */
	private async inlineDocumentAttachments(
		messages: LLMMessage[],
	): Promise<LLMMessage[]> {
		// Inline extracted text for document attachments in EVERY user message in
		// the assembled context, not just the latest. A follow-up question ("which
		// name repeats most?") arrives in a later user turn that doesn't itself
		// reference the file; if we only inlined the latest message, the file's
		// content would be absent from context and the model would re-fetch it via
		// a tool (e.g. the browser). Extraction is cached, so revisiting earlier
		// turns each build is cheap. A shared budget bounds total inlined text.
		const docMediaRe = /!\[([^\]]*)\]\(\/api\/media\/file\/([^)]+)\)/g;
		let budget = MAX_TOTAL_DOC_CHARS;
		const seenFiles = new Set<string>();
		const blocksByMsg = new Map<number, string[]>();
		const ensureBucket = (i: number): string[] => {
			let arr = blocksByMsg.get(i);
			if (!arr) {
				arr = [];
				blocksByMsg.set(i, arr);
			}
			return arr;
		};

		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role !== "user") continue;
			if (budget <= 0) break;
			const msg = messages[i];
			const contentStr =
				typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.map((p) => (p.type === "text" ? p.text : "")).join("")
						: "";
			if (!contentStr.includes("/api/media/file/")) continue;

			docMediaRe.lastIndex = 0;
			for (const match of contentStr.matchAll(docMediaRe)) {
				if (budget <= 0) break;
				const storedName = (match[2] ?? "").split(/[?#]/)[0];
				if (!storedName || seenFiles.has(storedName)) continue;
				const kind = guessDocumentKind(storedName);
				if (kind === "media" || kind === "unknown") continue;
				seenFiles.add(storedName);

				const localPath = path.join(
					os.homedir(),
					".octopus",
					"media",
					storedName,
				);
				let text = "";
				try {
					text = (await extractDocumentText(localPath, storedName)).text;
				} catch {
					continue;
				}
				if (!text) continue;
				const slice = text.slice(0, budget);
				if (!slice) break;
				budget -= slice.length;

				const lang = fenceLangFor(storedName);
				const label = (match[1] ?? "").trim() || storedName;
				ensureBucket(i).push(
					`\n\n--- Archivo adjunto: ${label} (${kind}). Contenido ya extraído en este contexto; responde sobre él directamente y NO uses el navegador ni otros tools para releerlo. ---\n\`\`\`${lang ?? ""}\n${slice}\n\`\`\``,
				);
			}
		}

		if (blocksByMsg.size === 0) return messages;
		const result = messages.slice();
		for (const [i, blocks] of blocksByMsg) {
			const target = result[i];
			const annotation = blocks.join("");
			const updated: LLMMessage = { ...target };
			if (typeof target.content === "string") {
				updated.content = target.content + annotation;
			} else if (Array.isArray(target.content)) {
				updated.content = [
					...target.content,
					{ type: "text", text: annotation } as ContentPart,
				];
			}
			result[i] = updated;
		}
		return result;
	}

	private sanitizeAssistantOutput(content: string | undefined): string {
		return (content ?? "").replace(ZAI_VISION_REQUIRED_RE, "").trimEnd();
	}

	private createAssistantOutputStreamSanitizer(): {
		push: (chunk: string) => string;
		flush: () => string;
	} {
		let buffer = "";
		let suppressed = false;
		const retainedTailLength = ZAI_VISION_REQUIRED_MARKER.length - 1;

		return {
			push: (chunk: string): string => {
				if (suppressed) return "";
				buffer += chunk;
				const markerIndex = buffer.indexOf(ZAI_VISION_REQUIRED_MARKER);
				if (markerIndex >= 0) {
					const visible = buffer.slice(0, markerIndex).trimEnd();
					buffer = "";
					suppressed = true;
					return visible;
				}
				if (buffer.length <= retainedTailLength) return "";
				const emitLength = buffer.length - retainedTailLength;
				const visible = buffer.slice(0, emitLength);
				buffer = buffer.slice(emitLength);
				return visible;
			},
			flush: (): string => {
				if (suppressed) return "";
				const visible = buffer;
				buffer = "";
				return visible;
			},
		};
	}

	private stripInlineImageData(content: string): string {
		return content.replace(
			TOOL_IMAGE_RE,
			"[Image data omitted: screenshot is available via the saved media URL/local path above.]",
		);
	}

	private compactToolResultForContext(content: string): string {
		const stripped = this.stripInlineImageData(content).trim();
		if (stripped.length <= MAX_TOOL_RESULT_CONTEXT_CHARS) return stripped;
		return `${stripped.slice(0, MAX_TOOL_RESULT_CONTEXT_CHARS)}\n...[tool result truncated to keep memory bounded]`;
	}

	private compactTextForContext(content: string): string {
		const stripped = content.replace(TOOL_IMAGE_RE, "").trim();
		if (stripped.length <= MAX_TOOL_RESULT_CONTEXT_CHARS) return stripped;
		return `${stripped.slice(0, MAX_TOOL_RESULT_CONTEXT_CHARS)}\n...[tool result truncated to keep memory bounded]`;
	}

	private formatToolResultForModel(
		resultContent: string,
	): string | ContentPart[] {
		MEDIA_FILE_RE.lastIndex = 0;
		const hasInlineImage = TOOL_IMAGE_RE.test(resultContent);
		const hasMediaRef = MEDIA_FILE_RE.test(resultContent);
		if (!hasInlineImage && !hasMediaRef) {
			return this.compactToolResultForContext(resultContent);
		}

		// Models that cannot see images natively (Z.ai GLM, text-only models)
		// route image content through an external vision tool: strip the inline
		// base64, keep a compact text summary, and append the local media paths.
		if (this.shouldUseZaiVisionToolsForImages()) {
			const textContent = this.compactToolResultForContext(
				hasInlineImage
					? resultContent.replace(TOOL_IMAGE_RE, "")
					: resultContent,
			);
			return this.appendZaiVisionHint(
				textContent || "Image data.",
				this.getLocalMediaPathsFromContent(resultContent),
			);
		}

		// Native multimodal models: embed the actual image bytes as content parts
		// so the model can see them directly instead of a text placeholder.
		const textPart = this.compactTextForContext(
			hasInlineImage ? resultContent.replace(TOOL_IMAGE_RE, "") : resultContent,
		);
		return this.toImageContentParts(textPart, resultContent);
	}

	/**
	 * Obtener un resumen compacto del STM para pasar a workers.
	 */
	getContextSummary(maxChars = 2000): string {
		const context = this.stm.getContext();
		const turns = context.slice(-10);
		if (turns.length === 0) return "";

		const lines = turns.map((t) => `[${t.role}]: ${t.content.slice(0, 200)}`);
		const joined = lines.join("\n");
		if (joined.length <= maxChars) return joined;
		return `${joined.slice(0, maxChars)}\n...[context truncated]`;
	}

	/**
	 * Inyecta un mensaje asíncrono (ej. alertas del equipo) en el contexto de memoria.
	 */
	injectSystemMessage(message: string): void {
		this.stm.add({
			role: "system",
			content: message,
			timestamp: new Date(),
		});
	}

	/**
	 * Usado por el Blackboard para que el orquestador responda rápidamente a un sub-agente.
	 */
	async answerWorkerQuestion(prompt: string): Promise<string> {
		try {
			const response = await this.llmRouter.chat({
				model: this.config.model ?? "default",
				messages: [
					{
						role: "system",
						content:
							"Eres el orquestador de un sistema multi-agente respondiendo a un agente subordinado. Sé muy breve, directo y ayúdale a desatascarse o tomar una decisión técnica.",
					},
					{ role: "user", content: prompt },
				],
				maxTokens: 500,
				reasoning: this.buildReasoning(),
				metadata: this.requestMetadata(),
			});
			return response.content || "Sin respuesta.";
		} catch (err) {
			return `Error de LLM del orquestador: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	private formatSelectedAgentContext(
		selectedAgent?: RuntimeSelectedAgentContext | null,
	): string | null {
		if (!selectedAgent) return null;
		return [
			"# Selected Agent Context",
			`The user selected ${selectedAgent.name} (${selectedAgent.id}) for this conversation. Octavio remains the root orchestrator, but should honor this agent's identity, specialty, and intent when coordinating the arms.`,
			selectedAgent.role ? `- Role: ${selectedAgent.role}` : "",
			selectedAgent.armKey ? `- Arm key: ${selectedAgent.armKey}` : "",
			selectedAgent.description
				? `- Description: ${selectedAgent.description}`
				: "",
			selectedAgent.personality
				? `- Personality: ${selectedAgent.personality}`
				: "",
			selectedAgent.systemPrompt
				? `- Protected/agent instructions to preserve: ${selectedAgent.systemPrompt}`
				: "",
		]
			.filter(Boolean)
			.join("\n");
	}

	private async buildSharedWorkerContext(
		userMessage: string,
		channelId?: string,
		signal?: AbortSignal,
		selectedAgent?: RuntimeSelectedAgentContext | null,
	): Promise<LLMMessage[]> {
		const memories = await this.memoryRetrieval.retrieveForContext(userMessage);
		throwIfAborted(signal);

		const skills = await this.skillLoader.resolveSkillsForTask({
			description: userMessage,
			complexity: 0.5,
			domains: [],
			keywords: userMessage.split(/\s+/).filter((w) => w.length > 3),
		});
		throwIfAborted(signal);

		const learningInsights = await this.getRelevantLearning(userMessage);
		throwIfAborted(signal);

		const context = await this.buildContext(
			memories,
			skills,
			userMessage,
			channelId,
			learningInsights,
			selectedAgent,
		);

		try {
			const skillCatalog = await this.skillLoader.listSkills();
			if (skillCatalog.length > 0) {
				context.splice(1, 0, {
					role: "system",
					content: `Available skill catalog for worker awareness:\n${skillCatalog
						.map((skill) => `- ${skill.name}: ${skill.description}`)
						.join(
							"\n",
						)}\nRelevant skill instructions, when selected for this task, are included in the main system context above.`,
				});
			}
		} catch {
			// Skill catalog is helpful but not required for worker execution.
		}

		return context;
	}

	private sanitizeActivityDetail(content: string): string {
		const cleaned = content
			.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
			.replace(/<!--\s*tool:[\s\S]*?-->/gi, "")
			.replace(/!\[[^\]]*\]\([^)]+\)/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!cleaned) return "";
		return cleaned.length > 220
			? `${cleaned.slice(0, 217).trimEnd()}...`
			: cleaned;
	}

	private describeToolActivity(
		toolName: string,
		params: Record<string, unknown>,
		modelMessage: string,
	): string {
		const modelDetail = this.sanitizeActivityDetail(modelMessage);

		const filePath =
			typeof params.path === "string"
				? params.path
				: typeof params.file_path === "string"
					? params.file_path
					: typeof params.filePath === "string"
						? params.filePath
						: undefined;
		const pattern =
			typeof params.pattern === "string"
				? params.pattern
				: typeof params.query === "string"
					? params.query
					: typeof params.search === "string"
						? params.search
						: undefined;
		const command =
			typeof params.command === "string"
				? params.command
				: typeof params.cmd === "string"
					? params.cmd
					: undefined;
		const action =
			typeof params.action === "string" ? params.action : undefined;
		const prompt =
			typeof params.prompt === "string" ? params.prompt : undefined;

		const text =
			typeof params.text === "string"
				? params.text
				: typeof params.value === "string"
					? params.value
					: undefined;
		const selector =
			typeof params.selector === "string" ? params.selector : undefined;
		const url = typeof params.url === "string" ? params.url : undefined;
		const key = typeof params.key === "string" ? params.key : undefined;
		const uid = typeof params.uid === "string" ? params.uid : undefined;
		const waitForNavigation = params.waitForNavigation === true;

		switch (toolName) {
			case "browser_observe":
				return "Observando el estado actual de la página antes de decidir la siguiente acción.";
			case "browser_snapshot":
				return "Obteniendo el snapshot del árbol de accesibilidad de la página.";
			case "browser_navigate":
				return url
					? `Abriendo ${url} y esperando que cargue la página.`
					: "Abriendo la página solicitada.";
			case "browser_read_page":
				return "Leyendo el contenido visible de la página para confirmar qué cargó.";
			case "browser_screenshot":
				return "Tomando una captura de pantalla de la página actual.";
			case "browser_click_uid":
				return uid
					? `Dando clic en el elemento ${uid} usando el árbol de accesibilidad${waitForNavigation ? " y esperando que cargue la página" : ""}.`
					: "Dando clic en el elemento usando su UID de accesibilidad.";
			case "browser_fill_uid":
				return text
					? `Ingresando "${text}" en el campo usando su UID de accesibilidad.`
					: "Ingresando texto en el campo usando su UID de accesibilidad.";
			case "browser_click_text":
				return text
					? `Dando clic en "${text}"${waitForNavigation ? " y esperando que cargue la página" : ""}.`
					: "Dando clic en el elemento indicado por su texto.";
			case "browser_click":
				return selector
					? `Dando clic en el elemento ${selector}${waitForNavigation ? " y esperando navegación" : ""}.`
					: "Dando clic en el elemento seleccionado.";
			case "browser_type":
				return text
					? `Ingresando "${text}" en el campo seleccionado.`
					: "Ingresando texto en el campo seleccionado.";
			case "browser_press_key":
				return key
					? `Presionando ${key}${waitForNavigation ? " y esperando que cargue la página" : ""}.`
					: "Presionando una tecla en la página.";
			case "browser_get_elements":
				return "Buscando botones, enlaces y campos disponibles en la página.";
			case "browser_scroll":
				return "Desplazando la página para revisar más contenido.";
			case "browser_wait":
				return "Esperando que la página termine de cargar o estabilizarse.";
			case "browser_eval":
				return "Ejecutando JavaScript en la página para extraer datos o URLs.";
			// ── Filesystem / workspace ──
			case "write_file":
				return filePath
					? `Creando el archivo ${filePath}.`
					: "Creando un archivo en el workspace.";
			case "edit_file":
			case "apply_patch":
				return filePath
					? `Editando el archivo ${filePath}.`
					: "Editando un archivo.";
			case "read_file":
				return filePath
					? `Leyendo el archivo ${filePath}.`
					: "Leyendo un archivo.";
			case "search_files":
			case "search":
				return pattern
					? `Buscando "${pattern}"${filePath ? ` en ${filePath}` : ""}.`
					: "Buscando archivos en el workspace.";
			case "list_directory":
			case "list_dir":
				return filePath
					? `Listando el contenido de ${filePath}.`
					: "Listando archivos del workspace.";
			case "create_directory":
			case "mkdir":
				return filePath
					? `Creando la carpeta ${filePath}.`
					: "Creando una carpeta.";
			case "move_file":
				return filePath ? `Moviendo ${filePath}.` : "Moviendo un archivo.";
			case "copy_file":
				return filePath ? `Copiando ${filePath}.` : "Copiando un archivo.";
			case "delete_file":
			case "remove_file":
				return filePath
					? `Eliminando ${filePath}.`
					: "Eliminando un archivo.";
			case "manage_workspace":
				return action && filePath
					? `${action} en ${filePath}.`
					: action
						? `Operación ${action} en el workspace.`
						: "Gestionando archivos del workspace.";
			// ── Shell / code / media / delegation ──
			case "run_command":
			case "shell":
			case "execute_code":
				return command
					? `Ejecutando comando: ${command.slice(0, 80)}.`
					: `Ejecutando ${toolName.replace(/[_-]/g, " ")}.`;
			case "codex_generate_image":
			case "nano-banana-generate":
			case "nano-banana-edit":
				return prompt
					? `Generando imagen: "${prompt.slice(0, 80)}".`
					: "Generando una imagen.";
			case "delegate_task":
				return "Delegando una subtarea a un brazo especialista.";
			case "kanban_create_plan_from_goal":
				return "Planificando el trabajo (Kanban swarm) y dividiendo la meta.";
			default:
				return (
					modelDetail || `Ejecutando ${toolName.replace(/[_-]/g, " ")}.`
				);
		}
	}

	private encodeStatusField(value: string): string {
		return Buffer.from(value, "utf8").toString("base64");
	}

	private stableJson(value: unknown): string {
		const normalize = (input: unknown): unknown => {
			if (Array.isArray(input)) return input.map(normalize);
			if (input && typeof input === "object") {
				return Object.keys(input as Record<string, unknown>)
					.sort()
					.reduce<Record<string, unknown>>((acc, key) => {
						acc[key] = normalize((input as Record<string, unknown>)[key]);
						return acc;
					}, {});
			}
			return input;
		};

		try {
			return JSON.stringify(normalize(value));
		} catch {
			return String(value);
		}
	}

	private getToolBudget(toolName: string): number {
		const persistence = this.getTenacidad();
		const maxIter = this.getToolIterationLimit().maxIterations;

		// In relentless mode, all budgets are much more generous
		if (persistence.enabled) {
			if (/\b(video|image|audio|generate|edit|veo|nano)\b/i.test(toolName))
				return maxIter;
			if (toolName === "save_media") return maxIter;
			if (toolName.startsWith("browser_")) return 20;
			if (toolName === "create_tool") return 8;
			if (toolName === "execute_code" || toolName === "run_shell") return 12;
			return 16;
		}

		// Original budgets (existing behavior)
		if (toolName === "create_tool") return 2;
		if (toolName === "execute_code" || toolName === "run_shell") return 3;
		if (toolName === "browser_screenshot") return 2;
		if (toolName === "browser_snapshot") return 4;
		if (toolName === "browser_read_page") return 4;
		if (toolName === "browser_wait") return 2;
		if (toolName === "browser_eval") return 3;
		if (toolName === "browser_extract_images") return 3;
		if (toolName.startsWith("browser_")) return 4;
		if (toolName === "save_media") return 6;
		if (/\b(video|image|audio|generate|edit|veo|nano)\b/i.test(toolName))
			return maxIter;
		return 8;
	}

	private parseToolParams(toolCall: LLMToolCall): {
		params: Record<string, unknown>;
		error?: string;
	} {
		try {
			const parsed = JSON.parse(toolCall.function.arguments || "{}");
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return {
					params: {},
					error: "Tool arguments must be a JSON object.",
				};
			}
			return { params: parsed as Record<string, unknown> };
		} catch (err) {
			return {
				params: {},
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private createToolPolicyResult(message: string): {
		success: false;
		resultContent: string;
	} {
		return { success: false, resultContent: `Tool policy: ${message}` };
	}

	private extractArtifactsFromToolResult(
		toolName: string,
		resultContent: string,
	): Array<{
		artifactType: string;
		url?: string;
		path?: string;
		description?: string;
	}> {
		const artifacts: Array<{
			artifactType: string;
			url?: string;
			path?: string;
			description?: string;
		}> = [];
		const MEDIA_URL_RE = /\/api\/media\/file\/[a-f0-9-]+.[a-z0-9]+/gi;
		let match = MEDIA_URL_RE.exec(resultContent);
		while (match !== null) {
			const url = match[0];
			const ext = url.split(".").pop()?.toLowerCase() ?? "";
			const artifactType = [
				"png",
				"jpg",
				"jpeg",
				"gif",
				"webp",
				"svg",
			].includes(ext)
				? "image"
				: ["mp4", "webm"].includes(ext)
					? "video"
					: ["mp3", "wav", "ogg", "m4a"].includes(ext)
						? "audio"
						: "media";
			artifacts.push({
				artifactType,
				url,
				description: `${artifactType} from ${toolName}`,
			});
			match = MEDIA_URL_RE.exec(resultContent);
		}
		return artifacts;
	}

	private createEvidenceLedger(message: string): EvidenceLedger {
		const lower = message.toLowerCase();
		const objectiveKind: ObjectiveKind =
			/(imagen|imágenes|image|images|foto|fotos|producto|product|media|screenshot|captura)/i.test(
				lower,
			)
				? "media_collection"
				: "generic";
		const countMatch = lower.match(
			/(?:las|los|the)?\s*(\d{1,2})\s*(?:im[aá]genes|images|fotos|photos)/i,
		);
		// Detect domain-specific CDN patterns from the user message
		const cdnPatterns: string[] = [];
		const knownCdns: Record<string, string> = {
			etsy: "etsystatic.com",
			amazon: "images-amazon.com",
			ebay: "ebayimg.com",
			aliexpress: "ae01.alicdn.com",
			shopify: "cdn.shopify.com",
		};
		for (const [keyword, cdn] of Object.entries(knownCdns)) {
			if (lower.includes(keyword)) cdnPatterns.push(cdn);
		}
		return {
			objectiveKind,
			requestedItemCount: countMatch
				? Number.parseInt(countMatch[1], 10)
				: undefined,
			imageUrls: [],
			mediaUrls: [],
			capturedScreenshots: [],
			detailScreenshots: [],
			blockers: [],
			usefulResults: 0,
			consecutiveErrors: 0,
			imageCdnPatterns: cdnPatterns,
			toolHistory: [],
		};
	}

	private shouldStopOnToolBudgetExceeded(toolName: string): boolean {
		// In relentless mode, never hard-stop on budget alone
		if (this.getTenacidad().enabled) return false;

		return (
			toolName === "create_tool" ||
			toolName === "execute_code" ||
			toolName === "run_shell"
		);
	}

	private isManualVeoApiAttempt(
		toolName: string,
		params: Record<string, unknown>,
	): boolean {
		if (toolName !== "execute_code" && toolName !== "run_shell") return false;
		const text = [params.code, params.command, params.script]
			.filter((value): value is string => typeof value === "string")
			.join("\n");
		return /\b(aiplatform\.googleapis\.com|predictLongRunning|fetchPredictOperation|generateVideos|GOOGLE_APPLICATION_CREDENTIALS|gcloud\s+auth\s+print-access-token)\b/i.test(
			text,
		);
	}

	private formatTaskLedgerEntry(entry: ChatTaskLedgerEntry): string {
		const outputs = this.parseJsonArray(entry.outputs).slice(0, 5);
		const tools = this.parseJsonArray(entry.tool_names).slice(0, 8);
		return [
			`- status=${entry.status}; objective=${entry.objective}`,
			entry.summary ? `  summary=${entry.summary}` : "",
			outputs.length > 0 ? `  outputs=${outputs.join(", ")}` : "",
			tools.length > 0 ? `  tools=${tools.join(", ")}` : "",
			entry.completed_at ? `  completedAt=${entry.completed_at}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	private parseJsonArray(value: string | null): string[] {
		if (!value) return [];
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === "string")
				: [];
		} catch {
			return [];
		}
	}

	private addUnique(target: string[], values: string[]): boolean {
		let changed = false;
		for (const value of values) {
			if (!value || target.includes(value)) continue;
			target.push(value);
			changed = true;
		}
		return changed;
	}

	private extractImageUrls(text: string, cdnPatterns?: string[]): string[] {
		const urls = new Set<string>();
		for (const match of text.matchAll(/https?:\/\/[^\s"'<>\])]+/gi)) {
			const url = match[0].replace(/[,.]+$/, "");
			const isImageExt = /\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i.test(url);
			const isCdnImage =
				cdnPatterns?.some((p) => url.toLowerCase().includes(p)) ?? false;
			if (isImageExt || isCdnImage) {
				urls.add(url);
			}
		}
		return Array.from(urls);
	}

	private extractMediaUrls(text: string): string[] {
		const urls = new Set<string>();
		for (const match of text.matchAll(/\/api\/media\/file\/[^\s)\]]+/g)) {
			urls.add(match[0].replace(/[,.]+$/, ""));
		}
		return Array.from(urls);
	}

	private extractJsonPayload(text: string): unknown | null {
		const firstObject = text.indexOf("{");
		const lastObject = text.lastIndexOf("}");
		if (firstObject >= 0 && lastObject > firstObject) {
			try {
				return JSON.parse(text.slice(firstObject, lastObject + 1));
			} catch {
				/* try array */
			}
		}
		const firstArray = text.indexOf("[");
		const lastArray = text.lastIndexOf("]");
		if (firstArray >= 0 && lastArray > firstArray) {
			try {
				return JSON.parse(text.slice(firstArray, lastArray + 1));
			} catch {
				return null;
			}
		}
		return null;
	}

	private collectUrlsFromJson(
		value: unknown,
		urls: Set<string>,
		cdnPatterns?: string[],
	): void {
		if (typeof value === "string") {
			if (/^https?:\/\//i.test(value)) {
				const isImageExt = /\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i.test(
					value,
				);
				const isCdnImage =
					cdnPatterns?.some((p) => value.toLowerCase().includes(p)) ?? false;
				if (isImageExt || isCdnImage) urls.add(value);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value)
				this.collectUrlsFromJson(item, urls, cdnPatterns);
			return;
		}
		if (value && typeof value === "object") {
			for (const item of Object.values(value as Record<string, unknown>)) {
				this.collectUrlsFromJson(item, urls, cdnPatterns);
			}
		}
	}

	private updateEvidenceLedger(
		ledger: EvidenceLedger,
		toolName: string,
		resultContent: string,
		success: boolean,
	): void {
		let useful = false;
		const mediaUrls = this.extractMediaUrls(resultContent);
		if (this.addUnique(ledger.mediaUrls, mediaUrls)) useful = true;

		if (toolName === "browser_screenshot") {
			const target = /listing\/\d+|product|detail/i.test(resultContent)
				? ledger.detailScreenshots
				: ledger.capturedScreenshots;
			if (this.addUnique(target, mediaUrls)) useful = true;
		}

		const json = this.extractJsonPayload(resultContent);
		if (json) {
			const jsonUrls = new Set<string>();
			this.collectUrlsFromJson(json, jsonUrls, ledger.imageCdnPatterns);
			if (this.addUnique(ledger.imageUrls, Array.from(jsonUrls))) useful = true;
			const parsed = json as Record<string, unknown>;
			if (
				typeof parsed.status === "string" &&
				["completed", "partial"].includes(parsed.status)
			)
				useful = true;
			const detail = parsed.product as Record<string, unknown> | undefined;
			if (detail && typeof detail.url === "string")
				ledger.detailUrl = detail.url;
			const list = parsed.search as Record<string, unknown> | undefined;
			if (list && typeof list.url === "string") ledger.listUrl = list.url;
		}

		if (
			this.addUnique(
				ledger.imageUrls,
				this.extractImageUrls(resultContent, ledger.imageCdnPatterns),
			)
		)
			useful = true;

		// Generic detail/list URL extraction from any e-commerce domain
		const detailUrlMatch = resultContent.match(
			/https?:\/\/[^\s"')]+\/(?:listing|product|item|dp)\/[^\s"')]+/i,
		);
		if (detailUrlMatch) {
			ledger.detailUrl = detailUrlMatch[0];
			useful = true;
		}
		const listUrlMatch = resultContent.match(
			/https?:\/\/[^\s"')]+\/(?:search|browse|category|s\?)[^\s"')]+/i,
		);
		if (listUrlMatch) ledger.listUrl = listUrlMatch[0];

		if (
			/datadome|captcha|blocked|access denied|pardon our interruption|cloudflare|challenge/i.test(
				resultContent,
			)
		) {
			this.addUnique(ledger.blockers, [resultContent.slice(0, 300)]);
		}

		if (success) ledger.consecutiveErrors = 0;
		else ledger.consecutiveErrors += 1;
		if (useful) ledger.usefulResults += 1;
		ledger.toolHistory.push({
			name: toolName,
			success,
			useful,
			summary: resultContent.slice(0, 300),
		});
	}

	private isObjectiveSatisfied(ledger: EvidenceLedger): boolean {
		if (ledger.objectiveKind !== "media_collection") return false;
		if (ledger.imageUrls.length === 0) return false;
		if (
			ledger.requestedItemCount &&
			ledger.imageUrls.length >= ledger.requestedItemCount
		)
			return true;
		return (
			ledger.imageUrls.length > 0 &&
			(ledger.capturedScreenshots.length > 0 ||
				ledger.detailScreenshots.length > 0 ||
				Boolean(ledger.detailUrl))
		);
	}

	private isToolBillingBlocked(toolName: string): boolean {
		return (this.toolBillingFailures.get(toolName) ?? 0) >= 3;
	}

	private recordToolResultForBilling(
		toolName: string,
		toolResult: ToolResult,
	): void {
		const text = `${toolResult.error ?? ""} ${toolResult.output ?? ""}`;
		if (
			/403|billing|permission.?denied|requires billing|enabled billing/i.test(
				text,
			)
		) {
			this.toolBillingFailures.set(
				toolName,
				(this.toolBillingFailures.get(toolName) ?? 0) + 1,
			);
		} else if (toolResult.success) {
			this.toolBillingFailures.delete(toolName);
		}
	}

	private decideBeforeToolCall(
		toolName: string,
		params: Record<string, unknown>,
		ledger: EvidenceLedger,
		remainingIterations: number | null,
	): ToolDecision {
		if (this.isToolBillingBlocked(toolName)) {
			return {
				action: "stop",
				reason: `La herramienta '${toolName}' está temporalmente desactivada: falló varias veces seguidas por falta de facturación/permisos (HTTP 403). Habilita la facturación del proveedor o corrige los permisos y vuelve a intentarlo; no la reintentes hasta entonces.`,
			};
		}
		if (
			this.isManualVeoApiAttempt(toolName, params) &&
			this.toolRegistry?.has("veo-video-generator")
		) {
			return {
				action: "stop",
				reason:
					"Se bloqueó un intento manual de llamar la API de Veo desde execute_code/run_shell. Usa la herramienta dedicada `veo-video-generator` con `model_preference`, `image_url`/`first_frame_url` y `generate_audio`; no construyas endpoints de Vertex AI manualmente ni expongas credenciales.",
			};
		}

		const persistence = this.getTenacidad();

		// In relentless mode: only stop for genuine repeated API failures
		if (persistence.enabled) {
			if (ledger.consecutiveErrors >= persistence.maxGenuineApiErrors) {
				return {
					action: "stop",
					reason: `Deteniendo: ${persistence.maxGenuineApiErrors}+ errores consecutivos sugieren un problema real (API caída, error de autenticación, etc.).`,
				};
			}
			// Don't stop on "remaining iterations <= 1" or "already have useful results"
		} else {
			if (ledger.usefulResults > 0 && ledger.consecutiveErrors >= 3) {
				return {
					action: "stop",
					reason:
						"Ya hay evidencia útil y los intentos de recuperación están fallando.",
				};
			}

			if (
				ledger.usefulResults > 0 &&
				remainingIterations !== null &&
				remainingIterations <= 1
			) {
				return {
					action: "stop",
					reason:
						"Queda poco presupuesto de herramientas y ya existe evidencia útil.",
				};
			}
		}
		const recent = ledger.toolHistory.slice(-3);
		if (
			toolName === "browser_screenshot" &&
			recent.filter((t) => t.name === "browser_screenshot" && !t.success)
				.length >= 2
		) {
			return {
				action: "skip",
				reason:
					"Se omitió otra captura porque las últimas capturas fallaron; usar DOM/extracción o responder con evidencia parcial.",
			};
		}

		if (
			toolName === "browser_wait" &&
			recent.some((t) => t.name === "browser_wait" && !t.useful)
		) {
			return {
				action: "skip",
				reason:
					"Otra espera sin una condición nueva tiene bajo valor esperado.",
			};
		}

		if (
			toolName === "browser_navigate" &&
			typeof params.url === "string" &&
			params.url === ledger.detailUrl
		) {
			return {
				action: "skip",
				reason: "La navegación solicitada apunta al detalle ya identificado.",
			};
		}

		return { action: "execute" };
	}

	private buildDecisionGuidance(
		ledger: EvidenceLedger,
		toolName: string,
		resultContent: string,
		success: boolean,
		remainingIterations: number | null,
	): string {
		const recent = ledger.toolHistory
			.slice(-4)
			.map(
				(item) =>
					`${item.name}:${item.success ? "ok" : "error"}${item.useful ? ":useful" : ""}`,
			)
			.join(", ");
		const objectiveSatisfied = this.isObjectiveSatisfied(ledger);
		const remainingBudget =
			remainingIterations === null ? "unlimited" : remainingIterations;
		return [
			"# Navigation Decision Guidance",
			`Previous tool: ${toolName} (${success ? "success" : "error"}).`,
			`Remaining tool budget: ${remainingBudget}.`,
			`Evidence: images=${ledger.imageUrls.length}, media=${ledger.mediaUrls.length}, screenshots=${ledger.capturedScreenshots.length}, detailScreenshots=${ledger.detailScreenshots.length}, detailUrl=${ledger.detailUrl ? "yes" : "no"}.`,
			`Recent actions: ${recent || "none"}.`,
			objectiveSatisfied
				? "The requested evidence appears sufficient. Prefer answering now unless one clearly required artifact is still missing."
				: "Before the next action, evaluate whether the previous action changed the page or produced evidence. Choose exactly one next action with a clear expected observable change.",
			"If uncertain about the current page, use browser_observe before clicking. Do not repeat a failed click/wait/screenshot unless new evidence changed the target or condition.",
			`Last result excerpt: ${resultContent.replace(/\s+/g, " ").slice(0, 700)}`,
		].join("\n");
	}

	private evidenceSummary(ledger: EvidenceLedger): string {
		const lines = [
			`Objective: ${ledger.objectiveKind}`,
			`Image URLs found: ${ledger.imageUrls.length}`,
			`Media URLs found: ${ledger.mediaUrls.length}`,
			`Screenshots: ${ledger.capturedScreenshots.length}`,
			`Detail screenshots: ${ledger.detailScreenshots.length}`,
		];
		if (ledger.detailUrl) lines.push(`Detail URL: ${ledger.detailUrl}`);
		if (ledger.listUrl) lines.push(`List URL: ${ledger.listUrl}`);
		if (ledger.blockers.length > 0)
			lines.push(`Blockers: ${ledger.blockers.join(" | ")}`);
		if (ledger.imageUrls.length > 0) {
			lines.push("Images:");
			ledger.imageUrls
				.slice(0, 20)
				.forEach((url, index) => lines.push(`${index + 1}. ${url}`));
		}
		if (ledger.mediaUrls.length > 0) {
			lines.push("Media:");
			ledger.mediaUrls
				.slice(0, 10)
				.forEach((url, index) => lines.push(`${index + 1}. ${url}`));
		}
		return lines.join("\n");
	}

	private buildContinuationCheckpoint(
		ledger: EvidenceLedger,
		toolName: string,
		resultContent: string,
		success: boolean,
	): string {
		const safeResult = resultContent
			.replace(/--/g, "- -")
			.replace(/\s+/g, " ")
			.slice(0, 1200);
		const safeEvidence = this.evidenceSummary(ledger).replace(/--/g, "- -");
		return `\n<!-- octopus-continuation-checkpoint\nLast tool: ${toolName} (${success ? "success" : "error"})\n${safeEvidence}\nLast result excerpt: ${safeResult}\nInstruction for continuation: reuse completed evidence and artifacts above; resume from the first missing requirement instead of repeating completed steps.\n-->\n`;
	}

	private buildFinalizationMessages(
		messages: LLMMessage[],
		ledger: EvidenceLedger,
		reason: string,
	): LLMMessage[] {
		const sanitized = messages.filter(
			(msg) => msg.role !== "tool" && !msg.toolCalls,
		);
		return [
			...sanitized,
			{
				role: "system",
				content: `Runtime decision gate stopped further tool use. Reason: ${reason}\n\nUse the evidence below to answer the user now. Do not call tools. If something is missing, state exactly what is available and what could not be confirmed.\n\n${this.evidenceSummary(ledger)}`,
			},
		];
	}

	private buildFallbackFinalResponse(
		ledger: EvidenceLedger,
		reason: string,
	): string {
		const lines = [`Detuve las herramientas porque ${reason}`];
		if (ledger.capturedScreenshots.length > 0) {
			lines.push("", "Capturas:");
			for (const url of ledger.capturedScreenshots) {
				lines.push(`![Captura](${url})`);
			}
		}
		if (ledger.detailScreenshots.length > 0) {
			lines.push("", "Capturas de detalle:");
			for (const url of ledger.detailScreenshots) {
				lines.push(`![Detalle](${url})`);
			}
		}
		if (ledger.detailUrl) lines.push("", `URL de detalle: ${ledger.detailUrl}`);
		if (ledger.imageUrls.length > 0) {
			lines.push("", "Imagenes encontradas:");
			for (const [index, url] of ledger.imageUrls.slice(0, 20).entries()) {
				lines.push(`${index + 1}. ${url}`);
			}
		}
		if (ledger.mediaUrls.length > 0) {
			lines.push("", "Media generado o encontrado:");
			for (const [index, url] of ledger.mediaUrls.slice(0, 10).entries()) {
				lines.push(`${index + 1}. ${url}`);
			}
		}
		if (ledger.blockers.length > 0) {
			lines.push("", `Bloqueos detectados: ${ledger.blockers.join(" | ")}`);
		}
		const recentFailures = ledger.toolHistory
			.filter((entry) => !entry.success)
			.slice(-3);
		if (recentFailures.length > 0) {
			lines.push("", "Ultimos errores de herramientas:");
			for (const failure of recentFailures) {
				lines.push(`- ${failure.name}: ${failure.summary}`);
			}
		}
		return lines.join("\n");
	}

	private async *streamFinalResponse(
		messages: LLMMessage[],
		ledger: EvidenceLedger,
		reason: string,
	): AsyncIterable<string> {
		let yielded = false;
		const sanitizer = this.createAssistantOutputStreamSanitizer();
		try {
			const request: LLMRequest = {
				model: this.config.model ?? "default",
				messages: this.buildFinalizationMessages(messages, ledger, reason),
				maxTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				stream: true,
				reasoning: this.buildReasoning(),
				metadata: this.requestMetadata(),
			};
			for await (const chunk of this.llmRouter.chatStream(request)) {
				if (!chunk.content) continue;
				const visibleContent = sanitizer.push(chunk.content);
				if (!visibleContent) continue;
				yielded = true;
				yield visibleContent;
			}
			const tail = sanitizer.flush();
			if (tail) {
				yielded = true;
				yield tail;
			}
		} catch (err) {
			if (yielded) {
				yield `\n\nLa respuesta se interrumpió mientras cerraba la tarea. Estado actual: ${reason}.`;
				const fallback = this.buildFallbackFinalResponse(ledger, reason);
				if (fallback.trim()) yield `\n\n${fallback}`;
				console.error(
					"Final response stream failed after partial output:",
					err,
				);
				return;
			}
		}
		if (!yielded) yield this.buildFallbackFinalResponse(ledger, reason);
	}

	private async generateFinalResponse(
		messages: LLMMessage[],
		ledger: EvidenceLedger,
		reason: string,
	): Promise<string> {
		try {
			const response = await this.llmRouter.chat({
				model: this.config.model ?? "default",
				messages: this.buildFinalizationMessages(messages, ledger, reason),
				maxTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				reasoning: this.buildReasoning(),
				metadata: this.requestMetadata(),
			});
			const content = this.sanitizeAssistantOutput(response.content);
			if (content.trim()) return content;
		} catch {
			/* fallback below */
		}
		return this.buildFallbackFinalResponse(ledger, reason);
	}

	private buildDelegateSynthesisFallback(
		results: DelegateTaskResult[],
	): string {
		const lines = [
			"# Resultados combinados",
			"",
			"La sintesis automatica no termino correctamente. Estos son los resultados verificados de los workers.",
		];
		for (const result of results) {
			lines.push(
				"",
				`## ${result.role} (${result.workerId})`,
				`Tarea: ${result.task}`,
				result.error ? `Estado: failed - ${result.error}` : "Estado: done",
				"",
				result.result.slice(0, DELEGATE_SYNTHESIS_RESULT_CHARS),
			);
		}
		return lines.join("\n");
	}

	private async generateDelegateSynthesis(
		messages: LLMMessage[],
		results: DelegateTaskResult[],
	): Promise<string> {
		const summary = results
			.map((result) =>
				[
					`## ${result.role} (${result.workerId})`,
					`Tarea: ${result.task}`,
					result.error ? `Estado: failed - ${result.error}` : "Estado: done",
					"",
					result.result.slice(0, DELEGATE_SYNTHESIS_RESULT_CHARS),
				].join("\n"),
			)
			.join("\n\n---\n\n");
		try {
			const response = await withTimeout(
				this.llmRouter.chat({
					model: this.config.model ?? "default",
					messages: [
						...messages,
						{
							role: "system",
							content: [
								"Sintetiza ahora los resultados de delegate_task en una respuesta final.",
								"No llames herramientas. No inventes artefactos, archivos, URLs ni pruebas que no aparezcan en los resultados.",
								"Si algun worker fallo, reporta el resultado como parcial y cita el error exacto.",
								"Evita repetir contenido redundante y prioriza conclusiones accionables.",
							].join("\n"),
						},
						{
							role: "user",
							content: `Resultados de workers:\n\n${summary}`,
						},
					],
					maxTokens: Math.min(
						this.config.maxTokens ?? DELEGATE_SYNTHESIS_MAX_TOKENS,
						DELEGATE_SYNTHESIS_MAX_TOKENS,
					),
					temperature: this.config.temperature ?? 0.3,
					reasoning: this.buildReasoning(),
					metadata: this.requestMetadata(),
				}),
				DELEGATE_SYNTHESIS_TIMEOUT_MS,
			);
			const content = this.sanitizeAssistantOutput(response.content);
			if (content.trim()) return content;
		} catch {
			/* fallback below */
		}
		return this.buildDelegateSynthesisFallback(results);
	}

	async initialize(): Promise<void> {
		if (!this.config.id) {
			throw new Error("Agent config must have an id");
		}
		if (!this.config.name) {
			throw new Error("Agent config must have a name");
		}
		if (!this.config.systemPrompt) {
			throw new Error("Agent config must have a systemPrompt");
		}
	}

	async processMessage(
		message: string,
		channelId?: string,
		options: AgentProcessOptions = {},
	): Promise<string> {
		const startedAt = Date.now();
		throwIfAborted(options.signal);
		const userTurn: ConversationTurn = {
			role: "user",
			content: message,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(userTurn);

		// Update working memory from user message
		this.workingMemory.updateFromUserMessage(message);

		// === Auto-escalado a multi-agente ===
		if (this.orchestrator && !options.disableOrchestrator) {
			try {
				throwIfAborted(options.signal);
				const shouldDecompose =
					await this.orchestrator.shouldDecompose(message);
				if (shouldDecompose) {
					const decomposition = this.kanbanPlanner
						? await this.orchestrator.decomposeViaKanban(message, {
								conversationId: channelId,
								rootAgentId: this.config.id,
							})
						: await this.orchestrator.decompose(message);
					if (decomposition.subtasks.length > 1) {
						const sharedContext = await this.buildSharedWorkerContext(
							message,
							channelId,
							options.signal,
							options.selectedAgentContext,
						);
						let synthesisResult = "";
						for await (const event of this.orchestrator.executeParallel(
							decomposition,
							{
								sharedContext,
								channelId,
								signal: options.signal,
								usesZaiVisionToolForImages:
									this.shouldUseZaiVisionToolsForImages(),
							},
						)) {
							if (event.type === "synthesis") {
								synthesisResult = event.result;
							}
							throwIfAborted(options.signal);
						}
						if (synthesisResult) {
							const safeSynthesisResult =
								this.sanitizeAssistantOutput(synthesisResult);
							const assistantTurn: ConversationTurn = {
								role: "assistant",
								content: safeSynthesisResult,
								timestamp: new Date(),
								metadata: channelId ? { conversationId: channelId } : undefined,
							};
							this.stm.add(assistantTurn);
							this.recordAuxiliaryMemories(userTurn, assistantTurn, channelId);
							this.recordLearningExperience({
								userRequest: message,
								finalResponse: safeSynthesisResult,
								channelId,
								startedAt,
								metadata: { mode: "multi-agent" },
							});
							return safeSynthesisResult;
						}
					}
				}
			} catch (err) {
				console.error(
					"[Orchestrator] Falló en processMessage, usando single-agent:",
					err instanceof Error ? err.message : err,
				);
			}
		}

		const { memories, skills, learningInsights } =
			await this.retrieveContextInputs(message);
		throwIfAborted(options.signal);

		const context = await this.buildContext(
			memories,
			skills,
			message,
			channelId,
			learningInsights,
			options.selectedAgentContext,
		);
		const tools = this.getAvailableTools(options);

		throwIfAborted(options.signal);
		const response = await this.executeWithTools(
			context,
			tools,
			options,
			channelId,
		);
		throwIfAborted(options.signal);
		const safeResponseContent = this.sanitizeAssistantOutput(response.content);

		const assistantTurn: ConversationTurn = {
			role: "assistant",
			content: safeResponseContent,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(assistantTurn);

		this.recordAuxiliaryMemories(userTurn, assistantTurn, channelId);
		await this.recordTaskLedgerEntry({
			userRequest: message,
			assistantTurn,
			channelId,
			toolsUsed: response.toolCallsExecuted.map((tool) => ({
				name: tool.name,
				success: !tool.result.startsWith("Error:"),
				summary: tool.result.slice(0, MAX_TOOL_RESULT_STORED_CHARS),
			})),
		});

		this.updateActiveTask(safeResponseContent);

		this.recordLearningExperience({
			userRequest: message,
			finalResponse: safeResponseContent,
			channelId,
			startedAt,
			toolsUsed: response.toolCallsExecuted.map((tool) => ({
				name: tool.name,
				success: !tool.result.startsWith("Error:"),
				summary: tool.result.slice(0, MAX_TOOL_RESULT_STORED_CHARS),
			})),
			skillsUsed: this.toSkillTrace(skills),
		});

		return safeResponseContent;
	}

	static readonly STATUS_RE =
		/^\\x00STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?\\x00$/;

	/**
	 * Retrieve memory + skills + learning insights for a turn. Runs the three
	 * INDEPENDENT lookups in parallel (they used to run serially, blocking
	 * ~300-1300ms before the LLM call) and skips them entirely for trivial
	 * turns (greetings/acks) where deep retrieval adds latency without value.
	 */
	private async retrieveContextInputs(message: string): Promise<{
		memories: MemoryContext;
		skills: LoadedSkill[];
		learningInsights: LearningInsight[];
	}> {
		if (this.isTrivialTurn(message)) {
			return {
				memories: { memories: [], totalTokens: 0, fromSTM: [], combined: [] },
				skills: [],
				learningInsights: [],
			};
		}
		const [memories, skills, learningInsights] = await Promise.all([
			this.memoryRetrieval.retrieveForContext(message),
			this.skillLoader.resolveSkillsForTask({
				description: message,
				complexity: 0.5,
				domains: [],
				keywords: message.split(/\s+/).filter((w) => w.length > 3),
			}),
			this.getRelevantLearning(message),
		]);
		return { memories, skills, learningInsights };
	}

	/** Very conservative trivial-turn detector (greetings/acks only). */
	private isTrivialTurn(message: string): boolean {
		const trimmed = message.trim();
		if (trimmed.length === 0 || trimmed.length > 24) return false;
		if (/[?]/.test(trimmed)) return false;
		return /^(hola|buenas|buenos\s+d[ií]as|buenas\s+(tardes|noches)|hey|hi|hello|ok|okay|oke|vale|gracias|thanks|thank\s+you|perfecto|genial|buen[ií]simo|s[ií]|no|ya|contin[uú]a|sigue|dale|listo|hecho)\s*[!.?¡-]*$/i.test(
			trimmed,
		);
	}

	async *processMessageStream(
		message: string,
		channelId?: string,
		options: AgentProcessOptions = {},
	): AsyncIterable<string> {
		const startedAt = Date.now();
		throwIfAborted(options.signal);
		const userTurn: ConversationTurn = {
			role: "user",
			content: message,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(userTurn);
		this.workingMemory.updateFromUserMessage(message);

		// Señal inmediata de "Trabajando": el usuario ve actividad al instante,
		// antes del ensamblaje de contexto (que puede tardar 500-3500ms) y de la
		// decisión de escalado. "Pensando" se reserva para el razonamiento LLM.
		yield "\x00STATUS:working\x00";

		// === Auto-escalado a multi-agente ===
		if (this.orchestrator && !options.disableOrchestrator) {
			try {
				throwIfAborted(options.signal);
				const shouldDecompose =
					await this.orchestrator.shouldDecompose(message);
				if (shouldDecompose) {
					const decomposition = this.kanbanPlanner
						? await this.orchestrator.decomposeViaKanban(message, {
								conversationId: channelId,
								rootAgentId: this.config.id,
							})
						: await this.orchestrator.decompose(message);
					if (decomposition.subtasks.length > 1) {
						yield `\x00STATUS:orchestrating:planning::${this.encodeStatusField("Analizando la solicitud para decidir cuántos agentes crear y cómo dividir el trabajo.")}\x00`;
						const sharedContext = await this.buildSharedWorkerContext(
							message,
							channelId,
							options.signal,
							options.selectedAgentContext,
						);
						yield `\x00STATUS:orchestrating:${decomposition.subtasks.length}\x00`;
						for await (const event of this.orchestrator.executeParallel(
							decomposition,
							{
								sharedContext,
								channelId,
								signal: options.signal,
								usesZaiVisionToolForImages:
									this.shouldUseZaiVisionToolsForImages(),
							},
						)) {
							throwIfAborted(options.signal);
							switch (event.type) {
								case "decomposition":
									yield `\x00STATUS:orchestrating:multiagent::${this.encodeStatusField(
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
									)}\x00`;
									break;
								case "worker_started":
									yield `\x00STATUS:worker_start:${event.workerId}::${this.encodeStatusField(
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
									)}\x00`;
									break;
								case "worker_progress":
									yield `\x00STATUS:worker_progress:${event.workerId}::${this.encodeStatusField(
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
									)}\x00`;
									break;
								case "worker_done":
									yield `\x00STATUS:worker_done:${event.workerId}::${this.encodeStatusField(
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
									)}\x00`;
									break;
								case "worker_error":
									yield `\x00STATUS:worker_error:${event.workerId}::${this.encodeStatusField(
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
									)}\x00`;
									break;
								case "telemetry":
									yield `\x00STATUS:orchestrating:telemetry::${this.encodeStatusField(JSON.stringify(event.data))}\x00`;
									break;
								case "synthesis": {
									const safeResult = this.sanitizeAssistantOutput(event.result);
									yield "\x00STATUS:responding\x00";
									if (safeResult) yield safeResult;
									// Guardar en STM y memoria
									const assistantTurn: ConversationTurn = {
										role: "assistant",
										content: safeResult,
										timestamp: new Date(),
										metadata: channelId
											? { conversationId: channelId }
											: undefined,
									};
									this.stm.add(assistantTurn);
									this.recordAuxiliaryMemories(
										userTurn,
										assistantTurn,
										channelId,
									);
									this.recordLearningExperience({
										userRequest: message,
										finalResponse: safeResult,
										channelId,
										startedAt,
										metadata: {
											mode: "multi-agent",
											workers: decomposition.subtasks.length,
										},
									});
									return;
								}
							}
						}
						return; // Multi-agent completado
					}
				}
			} catch (err) {
				console.error(
					"[Orchestrator] Falló, usando single-agent:",
					err instanceof Error ? err.message : err,
				);
				// Fallback a single-agent silenciosamente
			}
		}

		// === Single-agent (flujo normal) ===
		const continuityGuard = this.continuityGuard;
		if (continuityGuard) continuityGuard.reset(message);

		let inlineRunId: string | undefined;
		if (this.subtaskTracker && channelId) {
			try {
				inlineRunId = await this.subtaskTracker.beginInlineRun({
					conversationId: channelId,
					agentId: this.config.id,
					goal: message,
				});
			} catch {
				/* non-critical, continue without tracking */
			}
		}
		const { memories, skills, learningInsights } =
			await this.retrieveContextInputs(message);
		throwIfAborted(options.signal);

		const context = await this.buildContext(
			memories,
			skills,
			message,
			channelId,
			learningInsights,
			options.selectedAgentContext,
		);
		const tools = this.getAvailableTools(options);

		const messages = [...context];
		let iterations = 0;
		let fullResponse = "";
		const toolSignatureCounts = new Map<string, number>();
		const toolNameCounts = new Map<string, number>();
		const ledger = this.createEvidenceLedger(message);
		const toolTrace: ExperienceToolTrace[] = [];
		let stoppedByDecision = false;
		let continueAfterToolLimit = true;
		let streamErrorRetryCount = 0;
		let emptyResponseRetryCount = 0;

		while (continueAfterToolLimit && !stoppedByDecision) {
			continueAfterToolLimit = false;
			while (
				this.hasToolIterationsRemaining(iterations) &&
				!stoppedByDecision
			) {
				throwIfAborted(options.signal);
				iterations++;

				const compressedMessages = await (
					await this.getRollingContext(channelId)
				).maybeSummarize(messages, this.config.model ?? "default");
				if (compressedMessages !== messages) {
					messages.length = 0;
					messages.push(...compressedMessages);
				}

				const request: LLMRequest = {
					model: this.config.model ?? "default",
					messages,
					maxTokens: this.config.maxTokens,
					temperature: this.config.temperature,
					stream: true,
					tools: tools.length > 0 ? tools : undefined,
					reasoning: this.buildReasoning(),
					metadata: this.requestMetadata({ conversationId: channelId }),
				};

				let chunkContent = "";
				const toolCalls: Array<{
					id: string;
					type: "function";
					function: { name: string; arguments: string };
				}> = [];
				let hasContent = false;
				let isThinking = false;
				let hasYieldedResponding = false;
				let streamFinishReason: string | undefined;
				const outputSanitizer = this.createAssistantOutputStreamSanitizer();

				try {
					yield "\x00STATUS:thinking\x00";
					for await (const chunk of this.llmRouter.chatStream(request)) {
						throwIfAborted(options.signal);
						if (chunk.thinking) {
							if (!isThinking) {
								isThinking = true;
							}
						}

						if (chunk.content) {
							if (isThinking) {
								isThinking = false;
							}
							const visibleContent = outputSanitizer.push(chunk.content);
							if (visibleContent) {
								chunkContent += visibleContent;
								hasContent = true;
								if (!hasYieldedResponding) {
									yield "\x00STATUS:responding\x00";
									hasYieldedResponding = true;
								}
								yield visibleContent;
							}
						}
						if (chunk.toolCalls) {
							const tc = chunk.toolCalls;
							const tcFn = tc.function ?? { name: "", arguments: "" };
							const existing = toolCalls.find(
								(t) => t.id === tc.id && tc.id !== "",
							);
							if (existing) {
								existing.function.arguments += tcFn.arguments ?? "";
								if (tcFn.name) existing.function.name = tcFn.name;
							} else {
								toolCalls.push({
									id: tc.id || `tc_${iterations}_${toolCalls.length}`,
									type: "function",
									function: {
										name: tcFn.name ?? "",
										arguments: tcFn.arguments ?? "",
									},
								});
							}
						}
						if (chunk.finishReason) {
							streamFinishReason = chunk.finishReason;
						}
					}
					const visibleTail = outputSanitizer.flush();
					if (visibleTail) {
						chunkContent += visibleTail;
						hasContent = true;
						if (!hasYieldedResponding) {
							yield "\x00STATUS:responding\x00";
							hasYieldedResponding = true;
						}
						yield visibleTail;
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					if (chunkContent) {
						fullResponse += chunkContent;
					}
					if (ledger.usefulResults > 0) {
						fullResponse += this.buildContinuationCheckpoint(
							ledger,
							"runtime_error",
							errMsg,
							false,
						);
					}

					// In relentless mode, retry transient stream errors
					const persistence = this.getTenacidad();
					const isGenuine = this.isGenuineApiError(errMsg);

					if (
						persistence.enabled &&
						!isGenuine &&
						streamErrorRetryCount < persistence.streamErrorRetries
					) {
						streamErrorRetryCount++;
						const retryNotice = `\n\n[Stream error (attempt ${streamErrorRetryCount}/${persistence.streamErrorRetries}), retrying...]\n\n`;
						fullResponse += retryNotice;
						yield retryNotice;
						yield ` STATUS:persistence_retry:stream_error::${this.encodeStatusField(`Stream error attempt ${streamErrorRetryCount}/${persistence.streamErrorRetries}: ${errMsg.slice(0, 200)}`)} `;
						// Brief backoff
						await new Promise((r) =>
							setTimeout(r, Math.min(1000 * streamErrorRetryCount, 5000)),
						);
						continue;
					}

					const llmFailureNotice = `\n\n⚠️ No pude completar la respuesta: el servicio de IA falló tras varios reintentos (incluido el modelo de respaldo). Detalle técnico: ${errMsg.slice(0, 300)}.\n\nPuedes reintentar en unos momentos; si persiste, revisa los créditos o permisos del proveedor en Ajustes.`;
					fullResponse += llmFailureNotice;
					yield llmFailureNotice;
					// Interrupt inline run tracking
					if (inlineRunId && this.subtaskTracker) {
						try {
							await this.subtaskTracker.interruptInlineRun(inlineRunId, errMsg);
						} catch {
							/* non-critical */
						}
					}
					break;
				}

				// Record finish reason in continuity guard
				if (continuityGuard) {
					continuityGuard.recordFinishReason(streamFinishReason);
				}

				const validToolCalls = toolCalls.filter(
					(tc) => tc.function.name.length > 0,
				);

				// A turn that produced real output (text or tool calls) has
				// recovered from any earlier transient blip. Reset the per-turn
				// transient-retry budgets so later connection drops in the same
				// long session each get their full retry allowance — otherwise the
				// counters (incremented, never reset) exhaust after the first few
				// drops and the agent stops recovering for the rest of the turn,
				// requiring a manual pause + continue.
				if (hasContent || validToolCalls.length > 0) {
					streamErrorRetryCount = 0;
					emptyResponseRetryCount = 0;
				}

				// Real progress this turn (tool calls emitted): clear accumulated stall state
				// so a fresh "promised-but-not-acted" cycle can be detected later.
				if (validToolCalls.length > 0 && continuityGuard) {
					continuityGuard.clearStall();
				}

				if (!hasContent && validToolCalls.length === 0) {
					const persistence = this.getTenacidad();

					// In relentless mode, retry on empty responses
					if (
						persistence.enabled &&
						emptyResponseRetryCount < persistence.emptyResponseRetries
					) {
						emptyResponseRetryCount++;
						const retryMsg = `\n\n[Empty response (attempt ${emptyResponseRetryCount}/${persistence.emptyResponseRetries}), retrying...]\n\n`;
						fullResponse += retryMsg;
						yield retryMsg;
						yield ` STATUS:persistence_retry:empty_response::${this.encodeStatusField(`Empty model response retry ${emptyResponseRetryCount}/${persistence.emptyResponseRetries}`)} `;
						messages.push({
							role: "system",
							content:
								"The previous model response was empty. Please continue working on the task.",
						});
						continue;
					}

					const warnMsg =
						"\n\n⚠️ The AI model returned an empty response. This may be due to a content filter, context length limit, or an API error.";
					fullResponse += warnMsg;
					yield warnMsg;
					break;
				}

				if (
					validToolCalls.length === 0 ||
					!this.toolExecutor ||
					!this.toolRegistry
				) {
					// Auto-continuation: check if response was truncated
					if (
						continuityGuard &&
						streamFinishReason === "length" &&
						inlineRunId
					) {
						continuityGuard.incrementContinuation();
						const shouldContinue = continuityGuard.shouldAutoContinue({
							finishReason: streamFinishReason,
							hasToolCalls: validToolCalls.length > 0,
							hasContent: !!chunkContent,
							iterationCount: iterations,
							maxIterations: this.getToolIterationLimit().maxIterations,
							inlineRunId,
						});
						if (shouldContinue) {
							let reconciliationReport = null;
							if (this.subtaskTracker) {
								try {
									reconciliationReport =
										await this.subtaskTracker.reconcileInterruptedRun(
											inlineRunId,
										);
								} catch {
									/* non-critical */
								}
							}
							const continuePrompt =
								continuityGuard.buildContinuePrompt(reconciliationReport);
							messages.push({ role: "assistant", content: chunkContent || "" });
							messages.push({ role: "system", content: continuePrompt });
							if (chunkContent) fullResponse += chunkContent;
							fullResponse += "\n\n[Auto-continuing...]\n\n";
							yield "\n\n[Auto-continuing...]\n\n";
							continue; // Continue the while loop for another LLM call
						}
					}
					// Stall / "promised-but-not-acted" detection (active in all modes).
					// If the model ended its turn with text but no tool call, and either
					// promised an imminent action or repeated earlier text, force another
					// turn that must emit the tool call. When the retry budget is spent,
					// emit a clear warning and fall through to the break.
					if (continuityGuard && chunkContent) {
						const stall = continuityGuard.shouldForceActOnStall(
							chunkContent,
							streamFinishReason,
						);
						if (stall.force) {
							continuityGuard.recordStall(chunkContent);
							const forcePrompt = continuityGuard.buildForceActPrompt(
								stall.reason,
								stall.repeated,
								{
									content: chunkContent,
									attempt: continuityGuard.stallForceCount,
								},
							);
							messages.push({ role: "assistant", content: chunkContent });
							messages.push({ role: "system", content: forcePrompt });
							const notice = stall.repeated
								? "\n\n[Repetición sin acción detectada — forzando tool call...]\n\n"
								: "\n\n[Acción pendiente prometida sin ejecutar — forzando tool call...]\n\n";
							fullResponse += notice;
							yield notice;
							yield ` STATUS:persistence_retry:stall_force::${this.encodeStatusField(
								`Stall force ${continuityGuard.stallForceCount}: ${stall.reason}`,
							)} `;
							continue; // re-enter the inner loop for another LLM call
						}
						if (stall.exhausted && continuityGuard.stallForceCount > 0) {
							const stallWarnMsg =
								"\n\n⚠️ El agente declaró una intención de acción varias veces pero no emitió la tool call correspondiente tras varios reintentos. La ejecución se detiene para evitar un bucle. Revisa el historial: la última intención declarada NO se completó.";
							fullResponse += stallWarnMsg;
							yield stallWarnMsg;
						}
					}
					if (chunkContent) {
						fullResponse += chunkContent;
					}
					break;
				}

				messages.push({
					role: "assistant",
					content: chunkContent || "",
					toolCalls: validToolCalls,
				});
				const toolExecutor = this.toolExecutor;

				const delegateCalls = validToolCalls.filter(
					(tc) => tc.function.name === "delegate_task",
				);
				const otherCalls = validToolCalls.filter(
					(tc) => tc.function.name !== "delegate_task",
				);

				if (delegateCalls.length === 1) {
					const singleDelegate = delegateCalls[0];
					if (!singleDelegate) continue;
					messages.push({
						role: "tool",
						content: [
							"Delegación omitida: solo se solicitó una subtarea.",
							"Resuelve esta tarea directamente como Octopus usando las herramientas disponibles.",
							"Solo uses delegate_task cuando haya 2 o más subtareas independientes que puedan correr en paralelo.",
						].join("\n"),
						toolCallId: singleDelegate.id,
					});
				}

				if (delegateCalls.length > 1) {
					const delegatedTasks = delegateCalls.map((tc, index) => {
						const parsedParams = this.parseToolParams(tc);
						const role =
							!parsedParams.error &&
							typeof parsedParams.params.role === "string"
								? parsedParams.params.role
								: `Delegated Worker ${index + 1}`;
						const task =
							!parsedParams.error &&
							typeof parsedParams.params.task === "string"
								? parsedParams.params.task
								: (parsedParams.error ?? "Delegated task");
						const armKey =
							!parsedParams.error &&
							typeof parsedParams.params.arm_key === "string"
								? parsedParams.params.arm_key
								: undefined;
						const model =
							!parsedParams.error &&
							typeof parsedParams.params.model === "string"
								? parsedParams.params.model
								: undefined;
						return {
							id: `delegate_${iterations}_${index + 1}`,
							toolCall: tc,
							parsedParams,
							role,
							task,
							armKey,
							produces: !parsedParams.error
								? parseDelegateProduces(parsedParams.params.produces)
								: undefined,
							model,
						};
					});
					const delegateWorkflow = await this.startDelegateWorkflow(
						message,
						channelId,
						delegatedTasks,
					);

					yield `\x00STATUS:orchestrating:multiagent::${this.encodeStatusField(
						JSON.stringify({
							count: delegatedTasks.length,
							executionPlan: "parallel",
							reasoning: `El modelo delegó ${delegatedTasks.length} subtarea${delegatedTasks.length === 1 ? "" : "s"} a workers especializados mediante delegate_task.`,
							subtasks: delegatedTasks.map((task) => ({
								id: task.id,
								role: task.role,
								description: task.task,
								armKey: task.armKey,
								model: task.model,
								toolScope: ["delegate_task"],
							})),
						}),
					)}\x00`;
					if (delegateWorkflow) {
						yield `\x00STATUS:orchestrating:telemetry::${this.encodeStatusField(
							JSON.stringify({
								runId: `delegate_${Date.now()}`,
								workflowRunId: delegateWorkflow.runId,
								totalMs: 0,
								executionMs: 0,
								synthesisMs: 0,
								workerCount: delegatedTasks.length,
								succeeded: 0,
								failed: 0,
								cancelled: 0,
							}),
						)}\x00`;
					}

					for (const task of delegatedTasks) {
						await this.updateDelegateWorkflowTask(
							delegateWorkflow,
							task.id,
							"running",
							"Worker delegado ejecutandose mediante delegate_task.",
						);
						yield `\x00STATUS:worker_start:${task.id}::${this.encodeStatusField(
							JSON.stringify({
								workerId: task.id,
								taskId: task.id,
								role: task.role,
								description: task.task,
								armKey: task.armKey,
								model: task.model,
							}),
						)}\x00`;
						yield `\x00STATUS:worker_progress:${task.id}::${this.encodeStatusField(
							JSON.stringify({
								workerId: task.id,
								taskId: task.id,
								message: "Worker delegado ejecutándose mediante delegate_task.",
								progress: 10,
								toolName: "delegate_task",
							}),
						)}\x00`;
					}

					type DelegateJobResult = {
						promise: Promise<DelegateJobResult>;
						index: number;
						workerId: string;
						toolCallId: string;
						result: string;
						error?: string;
					};
					const pending = new Set<Promise<DelegateJobResult>>();
					for (const [index, task] of delegatedTasks.entries()) {
						const job = {
							promise: undefined as unknown as Promise<DelegateJobResult>,
						};
						job.promise = (async () => {
							if (task.parsedParams.error) {
								return {
									promise: job.promise,
									index,
									workerId: task.id,
									toolCallId: task.toolCall.id,
									result: `Error: ${task.parsedParams.error}`,
									error: task.parsedParams.error,
								};
							}
							const result = await toolExecutor.execute(
								"delegate_task",
								task.parsedParams.params,
								{
									...this.getToolExecutionContext(),
									abortSignal: options.signal,
								},
							);
							return {
								promise: job.promise,
								index,
								workerId: task.id,
								toolCallId: task.toolCall.id,
								result: result.output || result.error || "",
								error: result.success
									? undefined
									: result.error || "Worker delegado falló.",
							};
						})();
						pending.add(job.promise);
					}

					const delegateResults = new Array<DelegateJobResult>(
						delegatedTasks.length,
					);
					while (pending.size > 0) {
						throwIfAborted(options.signal);
						const settled = await Promise.race(pending);
						pending.delete(settled.promise);
						delegateResults[settled.index] = settled;
						if (settled.error) {
							await this.updateDelegateWorkflowTask(
								delegateWorkflow,
								settled.workerId,
								"failed",
								settled.error,
							);
							yield `\x00STATUS:worker_error:${settled.workerId}::${this.encodeStatusField(
								JSON.stringify({
									workerId: settled.workerId,
									taskId: settled.workerId,
									error: settled.error,
								}),
							)}\x00`;
						} else {
							await this.updateDelegateWorkflowTask(
								delegateWorkflow,
								settled.workerId,
								"done",
								settled.result,
							);
							yield `\x00STATUS:worker_done:${settled.workerId}::${this.encodeStatusField(
								JSON.stringify({
									workerId: settled.workerId,
									taskId: settled.workerId,
									result: settled.result.slice(0, 2000),
								}),
							)}\x00`;
						}
					}

					for (const result of delegateResults) {
						const resultContent =
							result?.result ??
							"Error: delegated worker did not return a result.";
						this.workingMemory.updateFromToolResult(
							"delegate_task",
							!result?.error,
							result?.error,
						);
						messages.push({
							role: "tool",
							content: this.compactToolResultForContext(resultContent),
							toolCallId: result?.toolCallId ?? "delegate_task",
						});
					}

					if (otherCalls.length === 0) {
						const delegateTaskResults = delegateResults.map((result, index) => {
							const task = delegatedTasks[index];
							return {
								workerId:
									result?.workerId ?? task?.id ?? `delegate_${index + 1}`,
								role: task?.role ?? "Delegated Worker",
								task: task?.task ?? "Delegated task",
								result:
									result?.result ??
									"Error: delegated worker did not return a result.",
								error: result?.error,
							};
						});
						yield "\x00STATUS:responding\x00";
						const finalText = await this.generateDelegateSynthesis(
							messages,
							delegateTaskResults,
						);
						fullResponse += finalText;
						yield finalText;
						await this.finishDelegateWorkflow(
							delegateWorkflow,
							delegateTaskResults,
							finalText,
						);
						stoppedByDecision = true;
						break;
					}
				}

				for (const toolCall of otherCalls) {
					throwIfAborted(options.signal);
					const isCodeTool =
						toolCall.function.name === "execute_code" ||
						toolCall.function.name === "run_shell";
					const toolDef = this.toolRegistry?.get(toolCall.function.name);
					const uiIconB64 = toolDef?.uiIcon
						? Buffer.from(toolDef.uiIcon).toString("base64")
						: "";
					const statusType = isCodeTool ? "code" : "tool";

					const parsedParams = this.parseToolParams(toolCall);
					const params = parsedParams.params;

					if (!parsedParams.error) {
						const decision = this.decideBeforeToolCall(
							toolCall.function.name,
							params,
							ledger,
							this.getRemainingToolIterations(iterations),
						);
						if (decision.action === "stop") {
							const detail = this.encodeStatusField(decision.reason);
							yield `\x00STATUS:tool_skipped:${toolCall.function.name}::${detail}\x00`;
							yield "\x00STATUS:responding\x00";
							let finalText = "";
							for await (const finalChunk of this.streamFinalResponse(
								messages,
								ledger,
								decision.reason,
							)) {
								finalText += finalChunk;
								yield finalChunk;
							}
							fullResponse += finalText;
							stoppedByDecision = true;
							break;
						}
					}

					let currentSubtaskId: string | undefined;
					if (inlineRunId && this.subtaskTracker) {
						try {
							currentSubtaskId = await this.subtaskTracker.declareSubtask({
								runId: inlineRunId,
								title: toolCall.function.name,
								toolName: toolCall.function.name,
							});
							await this.subtaskTracker.startSubtask(currentSubtaskId);
						} catch {
							/* non-critical */
						}
					}
					const activityDetail = this.describeToolActivity(
						toolCall.function.name,
						params,
						chunkContent,
					);
					const activityDetailB64 = this.encodeStatusField(activityDetail);
					yield `\x00STATUS:${statusType}:${toolCall.function.name}:${uiIconB64}:${activityDetailB64}\x00`;

					let toolResult: ToolResult;
					let skipped = false;
					if (parsedParams.error) {
						skipped = true;
						const policyResult = this.createToolPolicyResult(
							`Invalid JSON arguments for ${toolCall.function.name}: ${parsedParams.error}. Retry once with valid JSON arguments instead of executing with empty parameters.`,
						);
						toolResult = {
							success: false,
							output: "",
							error: policyResult.resultContent,
						};
					} else {
						const toolNameCount =
							(toolNameCounts.get(toolCall.function.name) ?? 0) + 1;
						toolNameCounts.set(toolCall.function.name, toolNameCount);
						const toolBudget = this.getToolBudget(toolCall.function.name);
						const signature = `${toolCall.function.name}:${this.stableJson(params)}`;
						const signatureCount =
							(toolSignatureCounts.get(signature) ?? 0) + 1;
						toolSignatureCounts.set(signature, signatureCount);

						if (toolNameCount > toolBudget) {
							if (this.shouldStopOnToolBudgetExceeded(toolCall.function.name)) {
								const reason = `${toolCall.function.name} exceeded its strict per-response budget (${toolBudget}). Stop now, report the exact current state/error, and do not emit fake tool_call markup or attempt manual API workarounds.`;
								const detail = this.encodeStatusField(reason);
								yield `\x00STATUS:tool_skipped:${toolCall.function.name}::${detail}\x00`;
								yield "\x00STATUS:responding\x00";
								let finalText = "";
								for await (const finalChunk of this.streamFinalResponse(
									messages,
									ledger,
									reason,
								)) {
									finalText += finalChunk;
									yield finalChunk;
								}
								fullResponse += finalText;
								stoppedByDecision = true;
								break;
							}
							skipped = true;
							const policyResult = this.createToolPolicyResult(
								`${toolCall.function.name} exceeded its per-task budget (${toolBudget}). Use a simpler alternative, summarize progress, or finish with the useful results already collected.`,
							);
							toolResult = {
								success: false,
								output: "",
								error: policyResult.resultContent,
							};
						} else if (signatureCount > this.getMaxRepeatedToolSignatures()) {
							skipped = true;
							const policyResult = this.createToolPolicyResult(
								`Repeated action suppressed for ${toolCall.function.name}. The same parameters were already tried ${MAX_REPEATED_TOOL_SIGNATURES} times. Choose a different approach or provide a final answer with the current evidence.`,
							);
							toolResult = {
								success: false,
								output: "",
								error: policyResult.resultContent,
							};
						} else {
							const decision = this.decideBeforeToolCall(
								toolCall.function.name,
								params,
								ledger,
								this.getRemainingToolIterations(iterations),
							);
							if (decision.action === "skip") {
								skipped = true;
								const policyResult = this.createToolPolicyResult(
									decision.reason,
								);
								toolResult = {
									success: false,
									output: "",
									error: policyResult.resultContent,
								};
							} else {
								toolResult = await this.toolExecutor.execute(
									toolCall.function.name,
									params,
									this.getToolExecutionContext(),
								);
								throwIfAborted(options.signal);
								yield* this.maybeStreamCreatedWorkflow(
									toolCall,
									toolResult,
									options.signal,
								);
							}
						}
					}

					this.recordToolResultForBilling(toolCall.function.name, toolResult);
					const rawResultContentStr = toolResult.success
						? typeof toolResult.output === "string"
							? toolResult.output
							: JSON.stringify(toolResult.output, null, 2)
						: `Error: ${toolResult.error ?? "Unknown error"}`;
					const resultContentStr =
						this.compactToolResultForContext(rawResultContentStr);
					this.workingMemory.updateFromToolResult(
						toolCall.function.name,
						toolResult.success && !skipped,
						toolResult.success ? undefined : toolResult.error,
					);
					this.updateEvidenceLedger(
						ledger,
						toolCall.function.name,
						resultContentStr,
						toolResult.success && !skipped,
					);
					fullResponse += this.buildContinuationCheckpoint(
						ledger,
						toolCall.function.name,
						resultContentStr,
						toolResult.success && !skipped,
					);
					toolTrace.push({
						name: toolCall.function.name,
						success: toolResult.success && !skipped,
						useful:
							!skipped &&
							toolResult.success &&
							!resultContentStr.startsWith("Error:"),
						summary: resultContentStr.slice(0, MAX_TOOL_RESULT_STORED_CHARS),
						error: toolResult.success ? undefined : toolResult.error,
					});

					// Subtask tracking: complete or fail based on tool result
					if (currentSubtaskId && this.subtaskTracker) {
						if (toolResult.success && !skipped) {
							const producedArtifacts = this.extractArtifactsFromToolResult(
								toolCall.function.name,
								resultContentStr,
							);
							try {
								await this.subtaskTracker.completeSubtask(
									currentSubtaskId,
									producedArtifacts,
								);
							} catch {
								/* non-critical */
							}
						} else if (!toolResult.success) {
							try {
								await this.subtaskTracker.failSubtask(
									currentSubtaskId,
									toolResult.error ?? "Unknown error",
								);
							} catch {
								/* non-critical */
							}
						}
					}
					// Emit tool-done status (intercepted by frontend, not shown as text)
					if (skipped) {
						const skippedDetail = this.encodeStatusField(
							resultContentStr.replace(/^Error:\s*/, ""),
						);
						yield `\x00STATUS:tool_skipped:${toolCall.function.name}::${skippedDetail}\x00`;
					} else if (toolResult.success) {
						yield `\x00STATUS:tool_done:${toolCall.function.name}:\x00`;
					} else {
						yield `\x00STATUS:tool_error:${toolCall.function.name}:\x00`;
					}

					fullResponse += `
<!-- tool:${toolCall.function.name}:${toolResult.success ? "ok" : "error"} -->
`;

					const parsedContent = this.formatToolResultForModel(resultContentStr);

					messages.push({
						role: "tool",
						content: parsedContent,
						toolCallId: toolCall.id,
					});
					messages.push({
						role: "system",
						content: this.buildDecisionGuidance(
							ledger,
							toolCall.function.name,
							resultContentStr,
							toolResult.success && !skipped,
							this.getRemainingToolIterations(iterations),
						),
					});
				}
				if (stoppedByDecision) break;

				fullResponse += "\n\n";
			}

			if (!stoppedByDecision && this.hasReachedToolIterationLimit(iterations)) {
				const autoContinuePrompt = await this.buildToolLimitAutoContinuePrompt({
					guard: continuityGuard,
					ledger,
					toolsUsed: toolTrace,
					iterations,
					inlineRunId,
				});
				if (autoContinuePrompt) {
					messages.push({ role: "system", content: autoContinuePrompt });
					iterations = 0;
					const continuationNotice =
						"\n\n[Auto-continuing remaining media workflow...]\n\n";
					fullResponse += continuationNotice;
					yield continuationNotice;
					continueAfterToolLimit = true;
				}
			}
		}

		// If we exhausted all configured auto-continuations, warn without asking for a manual continue.
		if (!stoppedByDecision && this.hasReachedToolIterationLimit(iterations)) {
			const maxIterations = this.getToolIterationLimit().maxIterations;
			let limitMsg = `\n\n⚠️ He alcanzado el límite máximo de herramientas en esta ejecución (${maxIterations} iteraciones por segmento) y se agotaron las reanudaciones automáticas configuradas. Dejé el estado parcial guardado para reanudar desde el primer pendiente sin repetir trabajo.`;
			if (ledger.usefulResults > 0) {
				limitMsg = await this.generateFinalResponse(
					messages,
					ledger,
					`se alcanzó el límite de ${maxIterations} iteraciones; resume automáticamente desde el primer pendiente si la tarea original sigue incompleta`,
				);
			}
			fullResponse += limitMsg;
			yield limitMsg;
		}

		const safeFullResponse = this.sanitizeAssistantOutput(fullResponse);
		const assistantTurn: ConversationTurn = {
			role: "assistant",
			content: safeFullResponse,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(assistantTurn);
		this.recordAuxiliaryMemories(userTurn, assistantTurn, channelId);
		await this.recordTaskLedgerEntry({
			userRequest: message,
			assistantTurn,
			channelId,
			toolsUsed: toolTrace,
		});

		// Complete inline run tracking
		if (inlineRunId && this.subtaskTracker) {
			try {
				await this.subtaskTracker.completeInlineRun(inlineRunId);
			} catch {
				/* non-critical */
			}
		}

		this.updateActiveTask(safeFullResponse);
		this.recordLearningExperience({
			userRequest: message,
			finalResponse: safeFullResponse,
			channelId,
			startedAt,
			toolsUsed: toolTrace,
			skillsUsed: this.toSkillTrace(skills),
			metadata: {
				stoppedByDecision,
				toolIterations: iterations,
			},
		});
	}

	private async executeWithTools(
		context: LLMMessage[],
		tools: LLMTool[],
		options: AgentProcessOptions = {},
		channelId?: string,
	): Promise<{
		content: string;
		toolCallsExecuted: { name: string; result: string }[];
	}> {
		const toolCallsExecuted: { name: string; result: string }[] = [];
		const messages = [...context];
		let iterations = 0;
		const toolSignatureCounts = new Map<string, number>();
		const toolNameCounts = new Map<string, number>();
		const lastUser = [...context].reverse().find((msg) => msg.role === "user");
		const userText =
			typeof lastUser?.content === "string" ? lastUser.content : "";
		const ledger = this.createEvidenceLedger(userText);

		while (this.hasToolIterationsRemaining(iterations)) {
			throwIfAborted(options.signal);
			iterations++;

			const compressedMessages = await (
				await this.getRollingContext(channelId)
			).maybeSummarize(messages, this.config.model ?? "default");
			if (compressedMessages !== messages) {
				messages.length = 0;
				messages.push(...compressedMessages);
			}

			const request: LLMRequest = {
				model: this.config.model ?? "default",
				messages,
				maxTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				tools: tools.length > 0 ? tools : undefined,
				reasoning: this.buildReasoning(),
				metadata: this.requestMetadata({ conversationId: channelId }),
			};

			const response = await this.llmRouter.chat(request);
			throwIfAborted(options.signal);

			if (
				response.toolCalls &&
				response.toolCalls.length > 0 &&
				this.toolExecutor &&
				this.toolRegistry
			) {
				// Real progress this turn (tool calls emitted): clear accumulated stall state.
				if (this.continuityGuard) {
					this.continuityGuard.clearStall();
				}
				const assistantMessage: LLMMessage = {
					role: "assistant",
					content: response.content || "",
					toolCalls: response.toolCalls,
				};
				messages.push(assistantMessage);

				const toolResults: Array<{
					toolCallId: string;
					name: string;
					resultContent: string | ContentPart[];
					executedName: string;
					executedResult: string;
				}> = [];

				for (const toolCall of response.toolCalls) {
					throwIfAborted(options.signal);
					const parsedParams = this.parseToolParams(toolCall);
					const params = parsedParams.params;
					let toolResult: ToolResult;

					if (parsedParams.error) {
						toolResult = {
							success: false,
							output: "",
							error: this.createToolPolicyResult(
								`Invalid JSON arguments for ${toolCall.function.name}: ${parsedParams.error}. Retry once with valid JSON arguments instead of executing with empty parameters.`,
							).resultContent,
						};
					} else {
						const decision = this.decideBeforeToolCall(
							toolCall.function.name,
							params,
							ledger,
							this.getRemainingToolIterations(iterations),
						);
						if (decision.action === "stop") {
							const finalContent = await this.generateFinalResponse(
								messages,
								ledger,
								decision.reason,
							);
							return { content: finalContent, toolCallsExecuted };
						}
						const toolNameCount =
							(toolNameCounts.get(toolCall.function.name) ?? 0) + 1;
						toolNameCounts.set(toolCall.function.name, toolNameCount);
						const signature = `${toolCall.function.name}:${this.stableJson(params)}`;
						const signatureCount =
							(toolSignatureCounts.get(signature) ?? 0) + 1;
						toolSignatureCounts.set(signature, signatureCount);
						const toolBudget = this.getToolBudget(toolCall.function.name);

						if (toolNameCount > toolBudget) {
							if (this.shouldStopOnToolBudgetExceeded(toolCall.function.name)) {
								const finalContent = await this.generateFinalResponse(
									messages,
									ledger,
									`${toolCall.function.name} exceeded its strict per-response budget (${toolBudget}). Stop now, report the exact current state/error, and do not emit fake tool_call markup or attempt manual API workarounds.`,
								);
								return { content: finalContent, toolCallsExecuted };
							}
							toolResult = {
								success: false,
								output: "",
								error: this.createToolPolicyResult(
									`${toolCall.function.name} exceeded its per-task budget (${toolBudget}). Use a simpler alternative, summarize progress, or finish with the useful results already collected.`,
								).resultContent,
							};
						} else if (signatureCount > this.getMaxRepeatedToolSignatures()) {
							toolResult = {
								success: false,
								output: "",
								error: this.createToolPolicyResult(
									`Repeated action suppressed for ${toolCall.function.name}. The same parameters were already tried ${MAX_REPEATED_TOOL_SIGNATURES} times. Choose a different approach or provide a final answer with the current evidence.`,
								).resultContent,
							};
						} else if (decision.action === "skip") {
							toolResult = {
								success: false,
								output: "",
								error: this.createToolPolicyResult(decision.reason)
									.resultContent,
							};
						} else {
							toolResult = await this.toolExecutor?.execute(
								toolCall.function.name,
								params,
								this.getToolExecutionContext(),
							);
							throwIfAborted(options.signal);
						}
					}

					const rawResultContent = toolResult.success
						? toolResult.output
						: `Error: ${toolResult.error ?? "Unknown error"}`;
					const resultContent =
						this.compactToolResultForContext(rawResultContent);
					this.workingMemory.updateFromToolResult(
						toolCall.function.name,
						toolResult.success,
						toolResult.success ? undefined : toolResult.error,
					);
					this.updateEvidenceLedger(
						ledger,
						toolCall.function.name,
						resultContent,
						toolResult.success,
					);

					const parsedContent = this.formatToolResultForModel(resultContent);

					toolResults.push({
						toolCallId: toolCall.id,
						name: toolCall.function.name,
						resultContent: parsedContent,
						executedName: toolCall.function.name,
						executedResult: resultContent.slice(
							0,
							MAX_TOOL_RESULT_STORED_CHARS,
						),
					});
				}

				for (const res of toolResults) {
					toolCallsExecuted.push({
						name: res.executedName,
						result: res.executedResult,
					});

					messages.push({
						role: "tool",
						content: res.resultContent,
						toolCallId: res.toolCallId,
					});
					messages.push({
						role: "system",
						content: this.buildDecisionGuidance(
							ledger,
							res.executedName,
							res.executedResult,
							!res.executedResult.startsWith("Error:"),
							this.getRemainingToolIterations(iterations),
						),
					});
				}
			} else {
				// Stall / "promised-but-not-acted" detection (all modes). If the turn
				// ended with text but no tool call, and either promised an action or
				// repeated earlier text, force another iteration that must emit the
				// tool call. When the retry budget is spent, return with a clear warning.
				const stallContent = this.sanitizeAssistantOutput(response.content);
				const guard = this.continuityGuard;
				if (guard && stallContent) {
					const stall = guard.shouldForceActOnStall(
						stallContent,
						response.finishReason,
					);
					if (stall.force) {
						guard.recordStall(stallContent);
						messages.push({ role: "assistant", content: stallContent });
						messages.push({
							role: "system",
							content: guard.buildForceActPrompt(stall.reason, stall.repeated, {
								content: stallContent,
								attempt: guard.stallForceCount,
							}),
						});
						continue; // re-enter the while loop for another LLM call
					}
					if (stall.exhausted && guard.stallForceCount > 0) {
						return {
							content: `${stallContent}\n\n⚠️ El agente declaró una intención de acción varias veces pero no emitió la tool call correspondiente tras varios reintentos. La ejecución se detiene para evitar un bucle. Revisa el historial: la última intención declarada NO se completó.`,
							toolCallsExecuted,
						};
					}
				}
				return { content: stallContent, toolCallsExecuted };
			}
		}

		if (ledger.usefulResults > 0) {
			const maxIterations = this.getToolIterationLimit().maxIterations;
			return {
				content: await this.generateFinalResponse(
					messages,
					ledger,
					`se alcanzó el límite de ${maxIterations} iteraciones con evidencia útil disponible`,
				),
				toolCallsExecuted,
			};
		}

		return {
			content: this.sanitizeAssistantOutput(
				`I reached the maximum number of tool iterations. Here is what I have so far:\n${messages[messages.length - 1]?.content ?? ""}`,
			),
			toolCallsExecuted,
		};
	}

	private getAvailableTools(options: AgentProcessOptions = {}): LLMTool[] {
		if (!this.toolRegistry) return [];
		// Multimodal models see images natively, so they neither need nor should
		// use the Z.AI Vision MCP tools — hide that server from their tool list.
		const tools = this.toolRegistry.toLLMTools({
			excludeServerNames: this.modelSeesImagesNatively()
				? ["zai-vision"]
				: undefined,
		});
		return options.disableDelegation
			? tools.filter((tool) => tool.function.name !== "delegate_task")
			: tools;
	}

	private looksLikeUserFeedbackOrCorrection(content: string): boolean {
		return /\b(te voy a explicar|correcci[oó]n|corrige|fall[oó]|fallo|no fue|no era|en realidad|para futuro|ten en cuenta|cuando se requiera|se debe|debe usar|no acepta|solo acepta|obligatoriamente|gracias por la correcci[oó]n)\b/i.test(
			content,
		);
	}

	private isContinuationRequest(content: string): boolean {
		return /^\s*(contin[uú]a|continuar|sigue|seguimos|prosigue|reanuda|retoma|resume|continue|go on|keep going)\b/i.test(
			content,
		);
	}

	private indicatesIncompleteOrContinuation(content: string): boolean {
		return /\b(puedo continuar|puedo seguir|contin[uú]o si|si me lo pides|se alcanz[oó] el l[ií]mite|l[ií]mite m[aá]ximo|faltan?|quedan?|missing|remaining|pendiente|incomplet[oa]|parcial|partial|blocked|bloquead[oa]|no pude|no se pudo|could not|couldn['’]?t|unable to|failed to)\b/i.test(
			content,
		);
	}

	private looksLikeCompletedAssistantState(content: string): boolean {
		return /\b(¡?listo|hecho|completad[oa]|terminad[oa]|finalizado|ya lo|aqu[ií] tienes|video final|resultado final|import[éeoó]|generad[oa]|concatenad[oa]|guardad[oa]|subid[oa]|cread[oa])\b/i.test(
			content,
		);
	}

	private getTurnIdentity(turn: ConversationTurn): string {
		return [
			turn.role,
			turn.timestamp.getTime(),
			turn.metadata?.conversationId ?? "",
			turn.content,
		].join("\u0000");
	}

	private mergeConversationTurns(
		...groups: ConversationTurn[][]
	): ConversationTurn[] {
		const byIdentity = new Map<string, ConversationTurn>();
		for (const group of groups) {
			for (const turn of group) {
				const identity = this.getTurnIdentity(turn);
				if (byIdentity.has(identity)) byIdentity.delete(identity);
				byIdentity.set(identity, turn);
			}
		}
		return Array.from(byIdentity.values()).sort(
			(a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
		);
	}

	private filterTurnsForConversation(
		turns: ConversationTurn[],
		channelId?: string,
	): ConversationTurn[] {
		if (!channelId) return turns;
		return turns.filter(
			(turn) =>
				turn.role === "system" ||
				!turn.metadata?.conversationId ||
				turn.metadata.conversationId === channelId,
		);
	}

	private buildRecentStateGuidance(
		conversationTurns: ConversationTurn[],
		userMessage: string,
	): string | null {
		const recentRawTurns = conversationTurns
			.filter((turn) => turn.role === "user" || turn.role === "assistant")
			.slice(-REQUIRED_RECENT_RAW_TURNS);
		const recentAssistantCompletions = [...recentRawTurns]
			.reverse()
			.filter(
				(turn) =>
					turn.role === "assistant" &&
					this.looksLikeCompletedAssistantState(turn.content),
			)
			.slice(0, 3);
		const latestAssistant = [...recentRawTurns]
			.reverse()
			.find((turn) => turn.role === "assistant");
		const userLooksLikeFeedback =
			this.looksLikeUserFeedbackOrCorrection(userMessage);
		const userLooksLikeContinuation = this.isContinuationRequest(userMessage);
		const latestAssistantLooksIncomplete = Boolean(
			latestAssistant &&
				this.indicatesIncompleteOrContinuation(latestAssistant.content),
		);
		const assistantLooksCompleted = recentAssistantCompletions.length > 0;

		if (
			!userLooksLikeFeedback &&
			!assistantLooksCompleted &&
			!(userLooksLikeContinuation && latestAssistantLooksIncomplete)
		)
			return null;

		const lines = [
			"## Recent Conversation State",
			`The last ${Math.min(REQUIRED_RECENT_RAW_TURNS, recentRawTurns.length)} raw conversation turns are present below in full. Use them as authoritative state to avoid treating completed work as pending.`,
		];
		if (assistantLooksCompleted) {
			for (const completion of recentAssistantCompletions) {
				const excerpt = completion.content.replace(/\s+/g, " ").slice(0, 500);
				const mediaUrls = this.extractMediaUrls(completion.content).slice(0, 5);
				const mediaSuffix =
					mediaUrls.length > 0
						? ` Media/output URLs: ${mediaUrls.join(", ")}`
						: "";
				lines.push(
					`- Recent completed/delivered task evidence: ${excerpt}${mediaSuffix}`,
				);
			}
			lines.push(
				"- Do not ask whether to perform that same task again unless the latest user explicitly requests a redo, modification, or additional extension.",
			);
		}
		if (userLooksLikeContinuation && latestAssistantLooksIncomplete) {
			lines.push(
				`- The latest user is asking to continue and the latest assistant turn says work remains. Resume from this latest incomplete state instead of treating the previous execution metadata as final: ${latestAssistant?.content.replace(/\s+/g, " ").slice(0, 700)}`,
			);
		}
		if (latestAssistant && !assistantLooksCompleted) {
			lines.push(
				`- Latest assistant turn, for continuity: ${latestAssistant.content.replace(/\s+/g, " ").slice(0, 300)}`,
			);
		}
		if (userLooksLikeFeedback) {
			lines.push(
				"- The latest user message appears to be feedback/correction/explanation. Treat it as procedural guidance to acknowledge and apply going forward, not as an implicit request to re-run the previous task.",
			);
		}
		return lines.join("\n");
	}

	/**
	 * Detecta pedidos que implican escribir/modificar código técnico y, por tanto,
	 * merecen research fresco (Context7 → web → browser) antes de responder, para
	 * no asumir endpoints, nombres de modelo/versiones ni compatibilidad del stack.
	 */
	private isCodegenRequest(message: string): boolean {
		const text = message.toLowerCase();
		const tech =
			SkillResearcher.isTechnicalText(message) ||
			/\b(openai|anthropic|claude|gemini|google ai|stripe|vercel|supabase|firebase|aws|azure|hugging ?face|replicate|together|groq|mistral|zhipu|deepseek)\b/.test(
				text,
			);
		const codeVerb =
			/\b(crea|crear|creaci(?:ó|o)n|desarroll[ao]|implement[ao]|construy[ea]|build|program[ao]|codific[ao]|c(?:ó|o)digo|app|aplicaci(?:ó|o)n|script|funci(?:ó|o)n|herramienta|tool|endpoint|integr[ao]|integrar|configur[ao])\b/.test(
				text,
			);
		return tech && codeVerb;
	}

	/**
	 * Whether the current task involves building/editing a web page or HTML
	 * deliverable — used to auto-trigger the visual self-review rule. Matches
	 * the request OR (via the caller) a write_file of an .html / web app, in
	 * both English and Spanish.
	 */
	private isWebDeliverableRequest(message: string): boolean {
		const text = message.toLowerCase();
		const webNoun =
			/\b(web|website|web ?page|p(?:á|a)gina web|html|landing|sitio|site|invitaci(?:ó|o)n|frontend|front-?end|portfolio|one-?pager)\b/.test(
				text,
			);
		const buildVerb =
			/\b(crea|crear|creaci(?:ó|o)n|haz|hacer|dise(?:ñ|n)a|dise(?:ñ|n)ar|build|edit[ao]?|edita|edit|redise(?:ñ|n)a|genera|maquet[ao]|mockup)\b/.test(
				text,
			);
		return webNoun && buildVerb;
	}

	private userProfileCache: {
		value: Awaited<ReturnType<UserProfileManager["getProfile"]>>;
		at: number;
	} | null = null;

	/** Cached user profile (60s TTL) — avoids a DB read on every single turn. */
	private async getCachedUserProfile(): Promise<
		Awaited<ReturnType<UserProfileManager["getProfile"]>> | null
	> {
		if (!this.userProfileManager) return null;
		const now = Date.now();
		if (this.userProfileCache && now - this.userProfileCache.at < 60_000) {
			return this.userProfileCache.value;
		}
		try {
			const value = await this.userProfileManager.getProfile("owner");
			this.userProfileCache = { value, at: now };
			return value;
		} catch {
			return this.userProfileCache?.value ?? null;
		}
	}

	private async buildContext(
		memories: MemoryContext,
		skills: LoadedSkill[],
		userMessage: string,
		channelId?: string,
		learningInsights: LearningInsight[] = [],
		selectedAgent?: RuntimeSelectedAgentContext | null,
	): Promise<LLMMessage[]> {
		const messages: LLMMessage[] = [];
		const contextParts: string[] = [];
		let advancedMemoryPack: MemoryPack | undefined;
		let proactiveMemoryNotices: string[] = [];
		let degradedMemorySections: string[] = [];

		let systemContent = this.config.systemPrompt;

		if (this.contextAssembler) {
			try {
				const assembled = await this.contextAssembler.assemble({
					objective: userMessage,
					tenantId: "local",
					userId: "owner",
					projectId: process.cwd(),
					agentRole: this.config.id,
					sessionId: channelId,
					budgetTokens: 900,
				});
				advancedMemoryPack = assembled.memoryPack;
				proactiveMemoryNotices = assembled.proactiveNotices;
				degradedMemorySections = assembled.degradedSections;
				const generatedAt = new Date();
				this.lastMemoryTrace = {
					responseId: `memory-${generatedAt.getTime()}-${Math.random()
						.toString(36)
						.slice(2, 10)}`,
					generatedAt,
					objective: userMessage,
					channelId,
					uncertaintyLevel: assembled.memoryPack.uncertaintyLevel,
					memoryIds: Array.from(
						new Set([
							...assembled.memoryPack.memories.map((memory) => memory.item.id),
							...assembled.proactiveMemoryIds,
						]),
					),
					knownGaps: assembled.memoryPack.knownGaps,
					proactiveNotices: assembled.proactiveNotices,
					degradedSections: assembled.degradedSections,
				};
			} catch (e) {
				this.lastMemoryTrace = undefined;
				console.error("Failed to assemble advanced memory context:", e);
			}
		}

		const profile = await this.getCachedUserProfile();
		if (profile) {
			try {
				let profileStr = "### User Profile (Preferences & Context)\n";
				profileStr += `- Communication Style: ${profile.communicationStyle}\n`;
				if (Object.keys(profile.preferences).length > 0) {
					profileStr += `- Preferences: ${Object.entries(profile.preferences)
						.map(([k, v]) => `${k}=${v}`)
						.join(", ")}\n`;
				}
				if (profile.traits.length > 0) {
					profileStr += `- Traits: ${profile.traits.join(", ")}\n`;
				}
				const topExpertise = Object.entries(profile.expertiseAreas)
					.filter(([, v]) => v > 0.5)
					.map(([k]) => k);
				if (topExpertise.length > 0) {
					profileStr += `- Known User Expertise: ${topExpertise.join(", ")}\n`;
				}
				contextParts.push(profileStr);
			} catch (e) {
				console.error("Failed to load user profile for context:", e);
			}
		}

		if (this.dailyMemory) {
			const dailyContext = await this.dailyMemory.getCurrentContext();
			systemContent += `\n\n${dailyContext}`;
		}

		if (skills.length > 0) {
			const skillInstructions = skills.map((s) => s.content).join("\n\n");
			systemContent += `\n\n# Relevant Skills\n${skillInstructions}`;
		}

		if (learningInsights.length > 0) {
			// Surface captured failure lessons FIRST and unmissably — they are
			// the high-confidence anti-patterns the engine guarantees a slot
			// for, so the agent does not repeat a known costly mistake.
			const critical = learningInsights.filter(
				(i) =>
					(i.type === "anti_pattern" || i.type === "what_failed") &&
					i.confidence >= 0.8,
			);
			const general = learningInsights.filter((i) => !critical.includes(i));
			const lines: string[] = [];
			if (critical.length > 0) {
				lines.push(
					"# MISTAKES TO AVOID — DO NOT repeat these in this task (they failed before)",
				);
				for (const i of critical) lines.push(`- ${i.content}`);
			}
			if (general.length > 0) {
				lines.push("# Learned operating guidance (apply when relevant)");
				for (const i of general) {
					const label = i.type.replace(/_/g, " ");
					lines.push(`- ${label}: ${i.content}`);
				}
			}
			systemContent += `\n\n${lines.join("\n")}`;
		}

		// Auto-trigger the visual self-review loop for web/HTML deliverables: the
		// agent must SEE what it built (open → screenshot each section → analyze with
		// vision → fix → re-verify) before declaring the task done. Multimodal models
		// inspect the screenshot directly; text-only models use the analyze_image MCP.
		if (this.isWebDeliverableRequest(userMessage)) {
			systemContent +=
				"\n\n# Web self-review (mandatory before finishing)\nBefore declaring this web/HTML deliverable done, you MUST visually verify it: open the file with `browser_open_file` (use the absolute path from write_file), screenshot EACH section (scroll + browser_screenshot), and analyze every screenshot for flaws — layout, broken/missing images, overflow, contrast, responsiveness, and fit to the requested style. If you are a text-only model, call the `analyze_image` MCP tool on each screenshot. Fix every flaw you find (edit the HTML/CSS; regenerate images with codex_generate_image using a relative `path`, never base64), then re-screenshot the fixed section to confirm. Do NOT claim the task is finished until you have seen the page render correctly end-to-end, and report the final absolute path.";
		}

		// Web tool health: if a web search/reader provider is currently out of
		// quota (or repeatedly failing), tell the model up front so it goes
		// straight to the fallback (browser_search / pdf_read) instead of
		// discovering the failure by trying the tool and burning turns.
		const toolHealth =
			this.toolHealth ??
			(this.toolExecutor && "getHealth" in this.toolExecutor
				? this.toolExecutor.getHealth()
				: undefined);
		if (toolHealth) {
			try {
				const healthSummary = await toolHealth.getHealthSummary();
				if (healthSummary) systemContent += `\n\n${healthSummary}`;
			} catch {
				// Health summary is advisory; never block the turn on it.
			}
		}

		// Fresh research before codegen: for technical/code-writing requests, fetch
		// up-to-date docs (Context7 -> web -> browser) and ground the response in them
		// so the agent does not assume endpoints, model names, versions or compatibility.
		if (this.researcher && this.isCodegenRequest(userMessage)) {
			try {
				const research = await this.researcher.research({
					description: userMessage,
					keywords: [],
					domains: [],
				});
				if (research.context) {
					systemContent += `\n\n# Fresh Research (verified — prefer over assumptions)\nUp-to-date documentation gathered for this request. Ground your code in it. Verify the exact model/library names, endpoints, request/response shapes and current versions, and confirm compatibility across the stack you choose. Do NOT invent APIs, options or signatures that are not present here.\nSources: ${research.sources.join(", ") || "n/a"}\n\n${research.context}`;
				}
			} catch {
				/* best-effort: proceed without fresh research */
			}
		}

		const selectedAgentContext = this.formatSelectedAgentContext(selectedAgent);
		if (selectedAgentContext) {
			systemContent += `\n\n${selectedAgentContext}`;
		}

		if (advancedMemoryPack) {
			const knownGaps = advancedMemoryPack.knownGaps.slice(0, 5);
			const proactive = proactiveMemoryNotices.slice(0, 5);
			let advancedMemoryContext = "# Advanced Memory Context\n";
			advancedMemoryContext += `- Uncertainty: ${advancedMemoryPack.uncertaintyLevel}\n`;
			advancedMemoryContext += `- Token budget used: ${advancedMemoryPack.tokenBudgetUsed}\n`;
			if (advancedMemoryPack.verificationSummary) {
				advancedMemoryContext += `- Verification summary: ${Object.entries(
					advancedMemoryPack.verificationSummary,
				)
					.map(([status, count]) => `${status}=${count}`)
					.join(", ")}\n`;
			}
			if (advancedMemoryPack.sourceSummary) {
				const sourceSummary = advancedMemoryPack.sourceSummary;
				advancedMemoryContext += `- Source summary: strongestTrust=${sourceSummary.strongestSourceTrust ?? "unknown"}, averageAuthority=${sourceSummary.averageAuthority.toFixed(2)}\n`;
			}
			if (advancedMemoryPack.graphRelations?.length) {
				advancedMemoryContext += `- Graph relations available: ${advancedMemoryPack.graphRelations.length}\n`;
			}
			if (knownGaps.length > 0) {
				advancedMemoryContext += `- Known gaps: ${knownGaps.join("; ")}\n`;
			}
			if (proactive.length > 0) {
				advancedMemoryContext += `- Proactive notices: ${proactive.join("; ")}\n`;
			}
			if (degradedMemorySections.length > 0) {
				advancedMemoryContext += `- Degraded sections due to budget: ${degradedMemorySections.join(", ")}\n`;
			}
			advancedMemoryContext +=
				"Use retrieved memories only as scoped context. If uncertainty is NO_COVERAGE, explicitly avoid pretending you remember prior facts about this topic.";
			contextParts.push(advancedMemoryContext);
		}

		if (this.chatManager && channelId) {
			try {
				const [recentTasks, matchingCompleted] = await Promise.all([
					this.chatManager.listTaskLedgerEntries(channelId, { limit: 8 }),
					this.chatManager.searchTaskLedgerEntries(channelId, userMessage, {
						limit: 5,
						status: "completed",
					}),
				]);
				const taskLines = recentTasks.map((entry) =>
					this.formatTaskLedgerEntry(entry),
				);
				const matchLines = matchingCompleted.map((entry) =>
					this.formatTaskLedgerEntry(entry),
				);
				const incompleteLines = this.isContinuationRequest(userMessage)
					? recentTasks
							.filter((entry) => entry.status !== "completed")
							.slice(0, 5)
							.map((entry) => this.formatTaskLedgerEntry(entry))
					: [];
				if (taskLines.length > 0 || matchLines.length > 0) {
					contextParts.push(
						[
							"# Conversation Task Ledger",
							"This ledger is persistent per conversation. Use it as context for prior outputs, but never as a reason to skip a tool that the latest user request needs or explicitly asks for.",
							incompleteLines.length > 0
								? `## Active/Pending Tasks To Continue\n${incompleteLines.join("\n")}\nIf the latest user message is a short continuation prompt, resume the first active/pending task above from its last checkpoint. Treat a completed chat execution as transport state only, not proof that the broader user task is finished.`
								: "",
							matchLines.length > 0
								? `## Completed Tasks Matching Current Request\n${matchLines.join("\n")}`
								: "",
							taskLines.length > 0
								? `## Recent Task States\n${taskLines.join("\n")}`
								: "",
							"If the user asks to revise, improve, analyze, regenerate, continue, or use a tool, execute the needed tool call even when a similar prior task exists.",
						]
							.filter(Boolean)
							.join("\n\n"),
					);
				}
			} catch (err) {
				console.error("Failed to load conversation task ledger:", err);
			}
		}

		if (this.toolRegistry && this.toolRegistry.list().length > 0) {
			const toolNames = this.toolRegistry
				.list()
				.map((t) => `- ${t.name}: ${t.description}`)
				.join("\n");
			systemContent += `\n\n# Available Tools\nYou have access to the following tools. Use them when needed to help the user:\n${toolNames}`;
			systemContent +=
				"\n\nCRITICAL RULE: Do NOT use tools or hallucinate past tasks for simple greetings (e.g. 'hola') or casual conversation. Only use tools if the *latest* user request explicitly requires it.";
			systemContent +=
				"\n\nRAW CONVERSATION RECALL RULE: If the latest user asks whether you remember something, refers to what they told you before, asks about another/prior conversation, or needs an exact past detail that is not already in the visible context, call `recall_conversation` before answering. If the first search has no matches, search all saved conversations with short concrete keywords before saying you cannot find it.";
			systemContent += `\n\nRECENT STATE RULE: The last ${REQUIRED_RECENT_RAW_TURNS} raw conversation turns are mandatory continuity context and are more authoritative than summaries or older memories for the current task state. Use recent outputs as context, but do not let prior completion block the latest user request. If the user asks to revise, improve, analyze, regenerate, continue, or use a tool, call the needed tool instead of only describing what you would do.`;
			systemContent +=
				"\n\nTOOL DEBUGGING RULE: If a tool fails, do not repeatedly rewrite or recreate that tool. First read the exact current tool code and exact error. Make at most one focused fix, then run a cheap isolated validation or a single real retry. If the same failure persists, stop and report the tool as still broken with the exact error and workaround; do not claim the tool was fixed unless a validation actually passed.";
			systemContent +=
				"\n\nSTRUCTURED TOOL CALL RULE: Never print `<tool_call>`, `<tool_call_block>`, XML-like pseudo-tool calls, JSON call scaffolding, or code intended as a tool call in the final answer. If you cannot execute a real structured tool call, say that execution was blocked or failed and give the exact reason. For provider APIs with a dedicated tool, use the dedicated tool instead of execute_code/run_shell.";
			systemContent +=
				"\n\nIMPORTANT: When using the `create_tool` tool to create new tools, ALWAYS provide an animated SVG icon in the `uiIcon` parameter. The icon should be relevant to the tool's purpose and contain CSS animations like 'animation: pulse 2s infinite ease-in-out' on relevant elements.";
			systemContent +=
				"\n\nMANDATORY MEDIA OUTPUT RULE (PERSISTENT, NON-NEGOTIABLE): Any tool that generates or transforms images, audio, video, PDFs, documents, archives, or other binary media MUST save the generated file to the Octopus media library via the provided tool context (`context.media.save(buffer, mimeType, description, metadata)`), the `save_media` tool ONLY for small base64 payloads that already come from an external API, or `import_media_file` for any existing local file and any large output such as ffmpeg videos. If a file already exists on disk, NEVER convert it to base64; ALWAYS call `import_media_file` with the local path. For user-attached images or Octopus media URLs, pass the existing `/api/media/file/...` URL directly to tools that accept image URLs. For `nano-banana-generate`, use attached/reference images directly in `reference_images` as `/api/media/file/...`, http(s)://, or gs:// URLs; NEVER call or invent an image-to-base64 conversion step and NEVER pass `data:image/...;base64` as a tool argument. The tool result shown to the agent/user must contain only the saved `/api/media/file/...` URL and concise metadata. NEVER return raw base64, `data:` URLs, or large binary payloads in `output`, `metadata`, final answers, or follow-up tool arguments. For multi-step media workflows, every saved item MUST have a semantic description and metadata such as `workflowId`, `imageNumber`/`sceneNumber`, `stage`, `role`, `prompt`, and `parentMediaIds` so later steps can identify the correct file. Example description: `Construction timelapse Img 03 - sobre-cimientos final keyframe`; example metadata: `{ workflowId: 'construction-house-timelapse', imageNumber: 3, stage: 'sobre-cimientos', role: 'video-keyframe' }`. If creating a new media-generating dynamic tool, design it with `export default async function(params, context = {})` and save media before returning.";
			systemContent +=
				"\n\nLONG MEDIA WORKFLOW AUTONOMY RULE: For numbered or multi-batch image/video/audio workflows, keep progressing until the original requested deliverables are complete. If a provider, tool, or execution segment reaches a per-task, per-batch, generation, timeout, or iteration limit but completed artifacts and pending items are clear, immediately continue from the first missing item using the existing `/api/media/file/...` URLs and metadata. Do not ask the user to type 'continua', 'sigue', or confirm continuation just because a batch ended. Stop only when every deliverable is complete or when a missing credential/reference, safety issue, unrecoverable repeated tool failure, or external manual action truly blocks progress.";
			systemContent +=
				"\n\nKANBAN SWARM RULE: If the latest user request is a complex multi-agent objective, has multiple deliverables, needs parallel specialist work, or has concrete artifact dependencies such as image_1 -> video_1, Octavio must create or continue a Kanban Swarm workflow with `kanban_create_plan_from_goal` instead of manually doing all steps in one agent turn. Octavio is the director/supervisor, not a normal worker card claimant. Use verified artifacts and task comments to synthesize the final answer.";
		}

		systemContent += `\n\nCRITICAL SYSTEM INSTRUCTION:
- You have access to a persistent Long-Term Memory (LTM) system.
- NEVER claim that you do not have memory or that "each conversation starts fresh".
- If no memories are provided in the context below, simply state that you don't have relevant information.
- RESEARCH BEFORE CODING: when a request involves writing or modifying code that uses a library, framework, API or SDK, you MUST ground it in verified, up-to-date information — never assume. When a "# Fresh Research" section is provided, use it as the source of truth. If it is missing or insufficient, call context7 / web search first to confirm the correct endpoint, model/library name, request shape and current version, and verify compatibility across the stack before writing code.`;

		systemContent += `\n\n## AUTHENTICATED BROWSING (MANDATORY)
Your browser has PERSISTENT SESSIONS. Cookies and login state are automatically saved to disk and restored when revisiting sites. This means:

1. **NEVER refuse to interact with logged-in websites.** If the user says "check my Facebook/Instagram/etc", DO IT. The session cookies are already saved from a previous login. Do NOT say you "cannot handle credentials" or "cannot log in" — you are NOT logging in, you are using an EXISTING session.
2. **If a site requires login and no session exists**, tell the user: "I need you to log in manually first. I'll open the page, you enter your credentials, and I'll remember the session for next time." Do NOT refuse the task entirely.
3. **Sessions persist for 7 days** across restarts. The user does not need to re-login every time.
4. **You CAN perform all human actions**: click, type, scroll, like, comment, post, upload, download, navigate menus, etc. You are a full browser automation agent.
5. **Use known user context before searching.** Known Facebook page for this user: Cuentos Mitologicos / Cuentos Mitológicos = https://www.facebook.com/cuentosmitologicos1/. If the user asks about that page, navigate directly there or use the already-open authenticated Facebook tab; do not search for it first.

## SPA HANDLING (Facebook, Instagram, TikTok, YouTube, Reddit, Discord, etc.)
Modern web apps (SPAs) use heavy JavaScript rendering. The accessibility tree (browser_snapshot) may return EMPTY or INCOMPLETE content. When this happens:

1. **DO NOT give up or claim "the content won't load".** Instead, try these strategies IN ORDER:
   a. First scroll down 2-3 times (browser_eval: window.scrollBy(0, 800)) and wait 2 seconds between scrolls to trigger lazy loading.
   b. Use browser_eval to extract visible text directly from the DOM: document.body.innerText or specific selectors.
   c. Take a browser_screenshot and analyze it visually to understand what's on screen.
   d. Use browser_eval with platform-specific selectors (e.g., [role="article"] for Facebook posts, [data-testid="tweet"] for Twitter).
2. **For Facebook specifically**: Navigate to facebook.com/your-page/notifications or use Meta Business Suite (business.facebook.com) which has better accessibility.
3. **For comments/notifications**: Try direct URLs like facebook.com/page_id/notifications, youtube.com/comments, etc.
4. **NEVER say "Facebook detects automation"** as an excuse. The browser has stealth mode, realistic fingerprints, and persistent sessions. Just interact naturally.
5. **Do not claim CAPTCHA/DataDome unless visible evidence confirms it.** A hidden script name, an internal tool warning, or a failed extraction is not enough. Confirm with visible text, snapshot, screenshot analysis, or an actual CAPTCHA element before reporting a blocker.
6. **Be persistent**: If one approach fails, try another. Use at least 3 different strategies before reporting failure.`;

		const activeModel = this.config.model ?? "unspecified";
		const zaiVisionMode = this.shouldUseZaiVisionToolsForImages();
		systemContent += `\n\n## BROWSER AUTOMATION RULES (MANDATORY)
Active model: ${activeModel}
When using browser tools to navigate websites:

### ACCESSIBILITY TREE NAVIGATION (PRIMARY METHOD)
You MUST use the accessibility tree for all browser interactions. Follow this workflow:
1. After any page load (browser_navigate, browser_click_text with waitForNavigation, etc.), ALWAYS call browser_snapshot to get the accessibility tree of the new page.
2. Read the snapshot to understand what elements are available (buttons, links, inputs, headings, etc. with their UIDs).
3. To interact with elements, use browser_click_uid (for clicking) or browser_fill_uid (for typing into inputs) with the UID from the snapshot.
4. The UID tools use the cached snapshot first for speed and return an updated accessibility tree snapshot — use it to decide the next action.
5. If a UID is no longer valid (page changed), run browser_snapshot again to get fresh UIDs.

### NAVIGATION PRIORITY
1. Use browser_navigate with direct URLs when possible (e.g. a site's search URL with query parameters).
2. After navigation, use browser_snapshot (NOT browser_read_page) to understand the page.
3. Use browser_click_uid and browser_fill_uid as the PRIMARY interaction methods.
4. Only fall back to browser_click/browser_type with CSS selectors if browser_snapshot fails.
5. Only use browser_read_page when you need the raw text content of the page (not for navigation decisions).

### BLOCKED PAGE HANDLING
6. If the page appears blocked, empty, stuck on verification, hidden by an overlay, or not showing the expected content, take or inspect a browser screenshot before giving up.
7. ${zaiVisionMode ? "Because the active model cannot see images natively, analyze browser screenshots with a Z.AI Vision MCP tool using the local screenshot path before deciding the next browser action. Do not rely on direct image understanding for these screenshots." : "Because the active model can see images natively, use direct multimodal image understanding for browser screenshots when available. Do not call Z.AI Vision MCP tools solely to inspect browser screenshots."}
8. Based on the screenshot or vision analysis, decide and act: close popups, dismiss cookie banners, click Continue/Verify/Accept buttons using browser_click_uid, retry the original page, or continue reading if no real block exists.
9. For CAPTCHA pages, do not manually click reCAPTCHA/anti-bot checkboxes and do not claim the CAPTCHA was solved unless a fresh snapshot/read/screenshot shows the verification UI is gone. If configured, browser_solve_captchas may attempt supported provider handling, but token application is only an attempt; verifiedClear=true or equivalent page evidence is required before continuing. If the challenge remains visible, report the blocker, ask for manual completion, or use a source-specific/non-Google alternative.
10. If normal Playwright navigation is blocked, the IP appears blocked, or the task is pure public scraping where browser interaction is unnecessary, use Decodo: continue with the configured Decodo browser fallback or call decodo_scrape for advanced Web Scraping API retrieval.

### GENERAL RULES
11. NEVER navigate to Google as a fallback. Stay on the original target website and complete the task there.
12. When searching on a website, prefer a direct search URL or one robust form submission. Avoid trying the same submit/click repeatedly.
13. Cookie consent dialogs are automatically dismissed, but if you see one in a snapshot, click the "Accept" or equivalent button manually using browser_click_uid.
14. If a browser tool reports a connection error or unavailable browser, call browser_restart once and retry the same browser action. If it still fails, report the exact browser/configuration error; do not offer unrelated alternatives such as generating images, using a different task, or asking whether to proceed another way.
15. The browser may connect through a residential proxy, so pages may appear in the proxy region/language. This is normal; interact with the page language as shown.
16. Navigate step by step and decide intelligently. Before each browser action, evaluate the last snapshot: did URL/title/elements change, did the action fail, and what exact observable change is expected next?
16a. When using browser_scroll, read the reported actual page delta. If actual delta is 0px, do not say that visible scrolling happened; try a larger amount, an inner scrollable container with browser_eval, or direct DOM extraction.
17. browser_etsy_task is only a fallback if normal step-by-step navigation stalls repeatedly or the user explicitly requests a compact Etsy flow. Do not use it as the first/default action.
18. For requests to show, list, retrieve, or capture multiple page/product images, optimize for direct extraction once on the product/page: use browser_extract_images before clicking thumbnails. Only use browser_eval if the specialized extractor misses data. Deduplicate URLs, prefer the highest-resolution candidates, track obtained/pending internally, and avoid recapturing images already found.
19. Stop using browser tools as soon as requested data is available. If browser_extract_images returns images or the required screenshots/images are available, answer immediately with available screenshots/images instead of navigating again.
20. Keep browser/tool work out of the final answer while acting. When helpful, provide one concise present-tense activity sentence immediately before a tool call (for example: "Ingresando la búsqueda en Etsy", "Tomando una captura", "Extrayendo URLs de imágenes"); the UI will show it as transient progress instead of final response text. Return a compact final result with ordered images/URLs, missing items, or blockers only.`;

		if (contextParts.length > 0) {
			systemContent += `\n\n${contextParts.join("\n\n")}`;
		}

		// Inject WorkingMemory state
		if (this.workingMemory.hasContent()) {
			systemContent += `\n\n${this.workingMemory.toContextString()}`;
		}

		messages.push({ role: "system", content: systemContent });

		const memoryItems = this.filterMemoryPromptItems(
			advancedMemoryPack?.memories ?? memories.memories,
		);
		if (memoryItems.length > 0) {
			const memoryFacts = memoryItems
				.map((m) => {
					let sourceStr = "Source: unavailable";
					const sourceChannel = m.item.source?.channelId;
					if (sourceChannel) {
						sourceStr = `Source channel: ${sourceChannel}`;
					} else if (m.item.source?.conversationId) {
						sourceStr = `Source conversation: ${m.item.source.conversationId}`;
					}

					const timeMs = Date.now() - m.item.createdAt.getTime();
					const hours = Math.round(timeMs / (1000 * 60 * 60));
					const timeStr =
						hours > 24
							? `${Math.round(hours / 24)} days ago`
							: hours > 0
								? `${hours} hours ago`
								: "Recently";

					const visibleIdentifiers = this.extractVisibleMemoryIdentifiers(
						m.item.content,
					);
					const identifierStr =
						visibleIdentifiers.length > 0
							? `; Visible identifiers/codes: ${visibleIdentifiers.join(", ")}`
							: "";

					return `- ${sourceStr}; Time: ${timeStr}${identifierStr}; Visible content: ${m.item.content}`;
				})
				.join("\n");
			messages.push({
				role: "system",
				content: `Relevant memories from ${advancedMemoryPack ? "orchestrated memory" : "long-term storage"}:\nUse these retrieved memories as available context for the current answer. When the user asks what you remember or asks about a fact covered below, answer from these memories instead of saying you do not remember. Each memory line separates source metadata from Visible content; answer from Visible content, not from redacted source metadata. Respect any redacted memory markers and do not infer withheld content. A [REDACTED] span only withholds that span; still use the other visible facts and identifiers in the same memory. If the user asks whether you remember a visible code, codigo, token, name, or identifier and that exact value appears below, answer yes and provide the visible value. If Visible identifiers/codes contains the user-requested code or codigo, that is the exact public code you remember; do not say there is a separate missing value. Do not claim that value is hidden just because a different span in the same memory is [REDACTED]. Do not describe visible identifiers as merely labels or incomplete values unless the identifier itself contains [REDACTED].\n${memoryFacts}`,
			});
		}

		const fullStmContext = this.stm.getContext();
		const stmTurns = this.mergeConversationTurns(
			memories.fromSTM,
			fullStmContext,
		);
		for (const turn of stmTurns) {
			if (turn.role === "system") {
				messages.push({ role: "system", content: turn.content });
			}
		}
		const conversationTurns = this.filterTurnsForConversation(
			stmTurns,
			channelId,
		);
		const guaranteedRecentRawTurns = this.filterTurnsForConversation(
			fullStmContext,
			channelId,
		)
			.filter((turn) => turn.role === "user" || turn.role === "assistant")
			.slice(-REQUIRED_RECENT_RAW_TURNS);
		const recentStateGuidance = this.buildRecentStateGuidance(
			conversationTurns,
			userMessage,
		);
		if (recentStateGuidance) {
			messages.push({ role: "system", content: recentStateGuidance });
		}
		const maxTurns = Math.min(
			STM_MAX_TURNS,
			Math.max(
				STM_MIN_TURNS,
				REQUIRED_RECENT_RAW_TURNS,
				conversationTurns.length,
			),
		);
		const recentTurns = this.mergeConversationTurns(
			conversationTurns.slice(-maxTurns),
			guaranteedRecentRawTurns,
		);
		for (const turn of recentTurns) {
			if (turn.role === "user" || turn.role === "assistant") {
				const toolResults = (turn.metadata as Record<string, unknown>)
					?.toolResults as
					| Array<{ tool: string; success: boolean; excerpt: string }>
					| undefined;
				let content = turn.content;
				if (toolResults && toolResults.length > 0) {
					const existingCheckpoints = (
						content.match(/octopus-continuation-checkpoint/g) || []
					).length;
					if (existingCheckpoints === 0) {
						const outcomes = toolResults
							.map(
								(r) =>
									`- ${r.tool}: ${r.success ? "SUCCESS" : "FAILED"} — ${r.excerpt}`,
							)
							.join("\n");
						content += `\n<!-- tool-outcomes\n${outcomes}\n-->`;
					}
				}
				messages.push({ role: turn.role, content });
			}
		}

		let hasUserMessage = false;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user" && messages[i].content === userMessage) {
				hasUserMessage = true;
				break;
			}
		}
		if (!hasUserMessage) {
			messages.push({ role: "user", content: userMessage });
		}

		// Only re-embed screenshot/image BYTES for the most recent messages: the
		// model analyzes the latest captures directly, while older screenshots are
		// kept as path references (the agent still knows where each one is and can
		// re-open it) instead of re-sending their base64 every turn — which is what
		// ballooned the context (20K→40K tokens) during the visual self-review loop.
		const RECENT_IMAGE_MESSAGES = 3;
		const messageCount = messages.length;
		const parsedMessages = messages.map((msg, idx) => {
			if (typeof msg.content === "string") {
				const imgRegex = /!\[.*?\]\(\/api\/media\/file\/([^)]+)\)/g;
				const matches = [...msg.content.matchAll(imgRegex)];
				const imageMatches = matches.filter((m) =>
					this.isImageMediaFilename(m[1] ?? ""),
				);
				if (imageMatches.length > 0) {
					const isRecent = idx >= messageCount - RECENT_IMAGE_MESSAGES;
					// Text-only (GLM): append the local media paths so the model can
					// call analyze_image. Paths are cheap text (no base64), so this is
					// allowed for every message — the agent always knows where each
					// image lives, which is what we want.
					if (this.shouldUseZaiVisionToolsForImages()) {
						const localPaths = this.getLocalMediaPathsFromContent(
							msg.content,
						).filter((p) => this.isImageMediaFilename(p));
						return {
							...msg,
							content: this.appendZaiVisionHint(msg.content, localPaths),
						};
					}

					// Native multimodal: embed the actual image bytes ONLY for the most
					// recent captures (the ones being analyzed now). Older captures stay
					// as path references to bound the context.
					if (isRecent && this.modelSeesImagesNatively()) {
						return {
							...msg,
							content: this.toImageContentParts(msg.content),
						};
					}

					return {
						...msg,
						content: `${msg.content}\n[Earlier image referenced by path above — not re-embedded, to keep context bounded. Its path is shown above; re-open or re-screenshot to view it again.]`,
					};
				}
			}
			return msg;
		});

		// Inline extracted text from non-image attachments (pdf, docs, sheets,
		// code, ...) so the model can read them directly. Runs for every model.
		return await this.inlineDocumentAttachments(parsedMessages);
	}

	private extractVisibleMemoryIdentifiers(content: string): string[] {
		return Array.from(content.matchAll(VISIBLE_MEMORY_IDENTIFIER_RE))
			.map((match) => match[0])
			.filter((identifier) => !identifier.includes("REDACTED"))
			.filter(
				(identifier, index, identifiers) =>
					identifiers.indexOf(identifier) === index,
			)
			.slice(0, 8);
	}

	private filterMemoryPromptItems<
		T extends { item: { type: string; content: string } },
	>(items: T[]): T[] {
		const hasDirectMemory = items.some(
			(memory) =>
				memory.item.type !== "episodic" && memory.item.type !== "meta",
		);
		if (!hasDirectMemory) return items;

		return items.filter(
			(memory) =>
				memory.item.type !== "episodic" ||
				!this.isAssistantMemoryDenialEcho(memory.item.content),
		);
	}

	private isAssistantMemoryDenialEcho(content: string): boolean {
		const normalized = content.toLowerCase();
		if (!normalized.includes("assistant replied")) return false;
		return [
			"no lo recuerdo",
			"no recuerdo",
			"no tengo registro",
			"no tengo información",
			"no existe ningún registro",
			"no tengo acceso a conversaciones anteriores",
			"each conversation starts fresh",
		].some((phrase) => normalized.includes(phrase));
	}

	private updateActiveTask(responseText: string): void {
		const activeTask = this.stm.getActiveTask();
		if (
			activeTask &&
			activeTask.status === "running" &&
			this.detectTaskEnd(responseText)
		) {
			activeTask.status = "completed";
			activeTask.result = responseText;
			activeTask.completedAt = new Date();
			this.stm.setActiveTask(activeTask);
		}
	}

	private inferTaskLedgerStatus(
		responseText: string,
		toolsUsed: Array<{ name: string; success?: boolean }> = [],
	): ChatTaskLedgerEntry["status"] | null {
		const lower = responseText.toLowerCase();
		const hasOutputs = this.extractMediaUrls(responseText).length > 0;
		const hasSuccessfulTools = toolsUsed.some((tool) => tool.success !== false);
		const hasFailure =
			/\b(error|failed|fall[oó]|bloque|captcha|limit|l[ií]mite)\b/i.test(lower);
		if (this.indicatesIncompleteOrContinuation(responseText)) return "partial";
		if (hasFailure && !hasSuccessfulTools && !hasOutputs) return "failed";
		if (
			hasOutputs ||
			this.looksLikeCompletedAssistantState(responseText) ||
			/(task completed|completed successfully|finished successfully|final answer|resultado final|video final|archivo final)/i.test(
				lower,
			)
		) {
			return "completed";
		}
		if (hasFailure) {
			return hasSuccessfulTools ? "partial" : "failed";
		}
		if (hasSuccessfulTools) return "partial";
		return null;
	}

	private async recordTaskLedgerEntry(input: {
		userRequest: string;
		assistantTurn: ConversationTurn;
		channelId?: string;
		toolsUsed: Array<{ name: string; success?: boolean; summary?: string }>;
	}): Promise<void> {
		if (!this.chatManager || !input.channelId) return;
		const status = this.inferTaskLedgerStatus(
			input.assistantTurn.content,
			input.toolsUsed,
		);
		if (!status) return;
		const outputs = this.extractMediaUrls(input.assistantTurn.content).slice(
			0,
			12,
		);
		const toolNames = [
			...new Set(input.toolsUsed.map((tool) => tool.name).filter(Boolean)),
		].slice(0, 20);
		const summary = input.assistantTurn.content
			.replace(/\s+/g, " ")
			.slice(0, 1200);
		try {
			await this.chatManager.addTaskLedgerEntry({
				conversationId: input.channelId,
				objective: input.userRequest.slice(0, 800),
				status,
				summary,
				outputs,
				toolNames,
				completedAt:
					status === "completed" ? new Date().toISOString() : undefined,
			});
		} catch (err) {
			console.error("Failed to record task ledger entry:", err);
		}
	}

	private detectTaskEnd(response: string): boolean {
		const lower = response.toLowerCase();
		const markers = [
			"task done",
			"task completed",
			"task finished",
			"i'm done",
			"i am done",
			"completed successfully",
			"finished successfully",
			"all done",
			"task is complete",
			"task is done",
			"task is finished",
			"i have completed",
			"i have finished",
			"nothing more to do",
			"that concludes",
			"in summary",
			"final answer",
		];
		return markers.some((marker) => lower.includes(marker));
	}

	async runConsolidation(): Promise<ConsolidationResult> {
		return this.memoryConsolidator.consolidate(this.stm);
	}

	getState(): {
		stmLoad: number;
		conversationLength: number;
		activeTask: TaskState | null;
	} {
		return {
			stmLoad: this.stm.getLoad(),
			conversationLength: this.stm.getContext().length,
			activeTask: this.stm.getActiveTask(),
		};
	}
}
