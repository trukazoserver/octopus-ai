import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { LLMRouter } from "../ai/router.js";
import type {
	ContentPart,
	LLMMessage,
	LLMRequest,
	LLMResponse,
	LLMTool,
	LLMToolCall,
} from "../ai/types.js";
import type { LearningEngine, LearningInsight } from "../learning/index.js";
import type { ExperienceSkillTrace, ExperienceToolTrace } from "../learning/types.js";
import type { MemoryConsolidator } from "../memory/consolidator.js";
import type { GlobalDailyMemory } from "../memory/daily.js";
import type { MemoryRetrieval } from "../memory/retrieval.js";
import type { ShortTermMemory } from "../memory/stm.js";
import type { ConsolidationResult, MemoryContext } from "../memory/types.js";
import type { UserProfileManager } from "../memory/user-profile.js";
import { WorkingMemory } from "../memory/working-memory.js";
import type { SkillLoader } from "../skills/loader.js";
import type { LoadedSkill } from "../skills/types.js";
import type { ToolExecutionContext, ToolExecutor } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/registry.js";
import type { AgentConfig, ConversationTurn, TaskState } from "./types.js";
import { OctopusOrchestrator, type OrchestratorConfig, type OrchestratorEvent } from "./orchestrator.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 18;
const MAX_REPEATED_TOOL_SIGNATURES = 2;
const MAX_TOOL_RESULT_CONTEXT_CHARS = 12000;
const MAX_TOOL_RESULT_STORED_CHARS = 2000;
const TOOL_IMAGE_RE = /\[IMG:(data:image\/[a-zA-Z0-9-]+;base64,[^\]]+)\]/;
const MEDIA_FILE_RE = /\/api\/media\/file\/([^\s)\]]+)/g;

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

type ToolDecision =
	| { action: "execute" }
	| { action: "skip"; reason: string }
	| { action: "stop"; reason: string };

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

export class AgentRuntime {
	private config: AgentConfig;
	private llmRouter: LLMRouter;
	public stm: ShortTermMemory;
	private memoryRetrieval: MemoryRetrieval;
	private memoryConsolidator: MemoryConsolidator;
	private skillLoader: SkillLoader;
	private toolRegistry?: ToolRegistry;
	private toolExecutor?: ToolExecutor;
	private dailyMemory?: GlobalDailyMemory;
	private userProfileManager?: UserProfileManager;
	private learningEngine?: LearningEngine;
	private orchestrator?: OctopusOrchestrator;
	private workingMemory: WorkingMemory = new WorkingMemory();

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
	}

	setToolSystem(registry: ToolRegistry, executor: ToolExecutor): void {
		this.toolRegistry = registry;
		this.toolExecutor = executor;
	}

	setDailyMemory(dailyMemory: GlobalDailyMemory): void {
		this.dailyMemory = dailyMemory;
	}

	setUserProfileManager(manager: UserProfileManager): void {
		this.userProfileManager = manager;
	}

	setLearningEngine(engine: LearningEngine): void {
		this.learningEngine = engine;
	}

	/**
	 * Configura el orquestador multi-agente para ejecución paralela.
	 * Si se configura, las tareas complejas se descomponen automáticamente.
	 */
	enableOrchestrator(config?: Partial<OrchestratorConfig>): void {
		if (!this.toolRegistry || !this.toolExecutor) {
			console.warn("[Orchestrator] Tool system not configured yet. Call setToolSystem first.");
			return;
		}
		this.orchestrator = new OctopusOrchestrator(
			this.llmRouter,
			this.toolRegistry,
			this.toolExecutor,
			this.config,
			config,
		);
	}

	/**
	 * Obtener el orquestador (para acceso directo desde el servidor).
	 */
	getOrchestrator(): OctopusOrchestrator | undefined {
		return this.orchestrator;
	}

	setToolIterationLimit(toolIterationLimit: AgentConfig["toolIterationLimit"]): void {
		this.config = { ...this.config, toolIterationLimit };
	}

	private toSkillTrace(skills: LoadedSkill[]): ExperienceSkillTrace[] {
		return skills.map((loaded) => ({
			id: loaded.skill.id,
			name: loaded.skill.name,
			level: loaded.level,
		}));
	}

	private async getRelevantLearning(message: string): Promise<LearningInsight[]> {
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
		metadata?: Record<string, unknown>;
	}): void {
		if (!this.learningEngine) return;
		this.learningEngine.recordExperience({
			agentId: this.config.id,
			conversationId: input.channelId,
			channelId: input.channelId,
			userRequest: input.userRequest,
			finalResponse: input.finalResponse,
			toolsUsed: input.toolsUsed,
			skillsUsed: input.skillsUsed,
			durationMs: Date.now() - input.startedAt,
			metadata: input.metadata,
		}).catch((err) => console.error("Learning experience record failed:", err));
	}

	private shouldUseZaiVisionToolsForImages(): boolean {
		return requiresZaiVisionToolForModel(this.config.model);
	}

	private getToolExecutionContext(): ToolExecutionContext {
		return {
			model: this.config.model,
			usesZaiVisionToolForImages: this.shouldUseZaiVisionToolsForImages(),
		};
	}

	private getToolIterationLimit(): { enabled: boolean; maxIterations: number } {
		const configuredMax = this.config.toolIterationLimit?.maxIterations;
		const maxIterations = typeof configuredMax === "number" && Number.isFinite(configuredMax)
			? Math.max(1, Math.trunc(configuredMax))
			: DEFAULT_MAX_TOOL_ITERATIONS;

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

	private toImageContentParts(content: string): ContentPart[] {
		const parts: ContentPart[] = [{ type: "text", text: content }];
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

	private appendZaiVisionHint(content: string, localPaths: string[]): string {
		if (localPaths.length === 0) return content;
		const quotedPaths = localPaths.map((p) => JSON.stringify(p)).join(", ");
		return `${content}\n\n[ZAI VISION REQUIRED] This image must be inspected with a Z.AI Vision MCP tool because the active model is Z.ai GLM. Use the available vision tool schema with one of these local screenshot paths (${quotedPaths}) before deciding the next browser action.`;
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

	private formatToolResultForModel(resultContent: string): string | ContentPart[] {
		const imgMatch = resultContent.match(TOOL_IMAGE_RE);
		if (!imgMatch) return this.compactToolResultForContext(resultContent);

		const textContent = this.compactToolResultForContext(
			resultContent.replace(imgMatch[0], ""),
		);
		if (this.shouldUseZaiVisionToolsForImages()) {
			return this.appendZaiVisionHint(
				textContent || "Image data.",
				this.getLocalMediaPathsFromContent(resultContent),
			);
		}

		return `${textContent || "Image data."}\n[Image data omitted: screenshot is available via the saved media URL/local path above.]`;
	}

	private sanitizeActivityDetail(content: string): string {
		const cleaned = content
			.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
			.replace(/<!--\s*tool:[\s\S]*?-->/gi, "")
			.replace(/!\[[^\]]*\]\([^)]+\)/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!cleaned) return "";
		return cleaned.length > 220 ? `${cleaned.slice(0, 217).trimEnd()}...` : cleaned;
	}

	private describeToolActivity(
		toolName: string,
		params: Record<string, unknown>,
		modelMessage: string,
	): string {
		const modelDetail = this.sanitizeActivityDetail(modelMessage);
		if (modelDetail) return modelDetail;

		const text = typeof params.text === "string" ? params.text : typeof params.value === "string" ? params.value : undefined;
		const selector = typeof params.selector === "string" ? params.selector : undefined;
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
			default:
				return `Ejecutando ${toolName.replace(/[_-]/g, " ")}.`;
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

		if (toolName === "browser_screenshot") return 2;
		if (toolName === "browser_snapshot") return 4;
		if (toolName === "browser_read_page") return 4;
		if (toolName === "browser_wait") return 2;
		if (toolName === "browser_eval") return 3;
		if (toolName === "browser_extract_images") return 3;
		if (toolName.startsWith("browser_")) return 4;
		if (toolName === "image-url-to-base64" || toolName === "save_media") return 6;
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

	private createToolPolicyResult(
		message: string,
	): { success: false; resultContent: string } {
		return { success: false, resultContent: `Tool policy: ${message}` };
	}

	private createEvidenceLedger(message: string): EvidenceLedger {
		const lower = message.toLowerCase();
		const objectiveKind: ObjectiveKind =
			/(imagen|imágenes|image|images|foto|fotos|producto|product|media|screenshot|captura)/i.test(lower)
				? "media_collection"
				: "generic";
		const countMatch = lower.match(/(?:las|los|the)?\s*(\d{1,2})\s*(?:im[aá]genes|images|fotos|photos)/i);
		// Detect domain-specific CDN patterns from the user message
		const cdnPatterns: string[] = [];
		const knownCdns: Record<string, string> = {
			"etsy": "etsystatic.com",
			"amazon": "images-amazon.com",
			"ebay": "ebayimg.com",
			"aliexpress": "ae01.alicdn.com",
			"shopify": "cdn.shopify.com",
		};
		for (const [keyword, cdn] of Object.entries(knownCdns)) {
			if (lower.includes(keyword)) cdnPatterns.push(cdn);
		}
		return {
			objectiveKind,
			requestedItemCount: countMatch ? Number.parseInt(countMatch[1], 10) : undefined,
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
			const isCdnImage = cdnPatterns?.some((p) => url.toLowerCase().includes(p)) ?? false;
			if (isImageExt || isCdnImage) {
				urls.add(url);
			}
		}
		return Array.from(urls);
	}

	private extractMediaUrls(text: string): string[] {
		const urls = new Set<string>();
		for (const match of text.matchAll(/\/api\/media\/file\/[^\s)\]]+/g)) {
			urls.add(match[0]);
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

	private collectUrlsFromJson(value: unknown, urls: Set<string>, cdnPatterns?: string[]): void {
		if (typeof value === "string") {
			if (/^https?:\/\//i.test(value)) {
				const isImageExt = /\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i.test(value);
				const isCdnImage = cdnPatterns?.some((p) => value.toLowerCase().includes(p)) ?? false;
				if (isImageExt || isCdnImage) urls.add(value);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) this.collectUrlsFromJson(item, urls, cdnPatterns);
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
			if (typeof parsed.status === "string" && ["completed", "partial"].includes(parsed.status)) useful = true;
			const detail = parsed.product as Record<string, unknown> | undefined;
			if (detail && typeof detail.url === "string") ledger.detailUrl = detail.url;
			const list = parsed.search as Record<string, unknown> | undefined;
			if (list && typeof list.url === "string") ledger.listUrl = list.url;
		}

		if (this.addUnique(ledger.imageUrls, this.extractImageUrls(resultContent, ledger.imageCdnPatterns))) useful = true;

		// Generic detail/list URL extraction from any e-commerce domain
		const detailUrlMatch = resultContent.match(/https?:\/\/[^\s"')]+\/(?:listing|product|item|dp)\/[^\s"')]+/i);
		if (detailUrlMatch) {
			ledger.detailUrl = detailUrlMatch[0];
			useful = true;
		}
		const listUrlMatch = resultContent.match(/https?:\/\/[^\s"')]+\/(?:search|browse|category|s\?)[^\s"')]+/i);
		if (listUrlMatch) ledger.listUrl = listUrlMatch[0];

		if (/datadome|captcha|blocked|access denied|pardon our interruption|cloudflare|challenge/i.test(resultContent)) {
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
		if (ledger.requestedItemCount && ledger.imageUrls.length >= ledger.requestedItemCount) return true;
		return ledger.imageUrls.length > 0 && (ledger.capturedScreenshots.length > 0 || ledger.detailScreenshots.length > 0 || Boolean(ledger.detailUrl));
	}

	private decideBeforeToolCall(
		toolName: string,
		params: Record<string, unknown>,
		ledger: EvidenceLedger,
		remainingIterations: number | null,
	): ToolDecision {
		if (ledger.usefulResults > 0 && ledger.consecutiveErrors >= 3) {
			return { action: "stop", reason: "Ya hay evidencia útil y los intentos de recuperación están fallando." };
		}

		if (ledger.usefulResults > 0 && remainingIterations !== null && remainingIterations <= 1) {
			return { action: "stop", reason: "Queda poco presupuesto de herramientas y ya existe evidencia útil." };
		}

		const recent = ledger.toolHistory.slice(-3);
		if (toolName === "browser_screenshot" && recent.filter((t) => t.name === "browser_screenshot" && !t.success).length >= 2) {
			return { action: "skip", reason: "Se omitió otra captura porque las últimas capturas fallaron; usar DOM/extracción o responder con evidencia parcial." };
		}

		if (toolName === "browser_wait" && recent.some((t) => t.name === "browser_wait" && !t.useful)) {
			return { action: "skip", reason: "Otra espera sin una condición nueva tiene bajo valor esperado." };
		}

		if (toolName === "browser_navigate" && typeof params.url === "string" && params.url === ledger.detailUrl) {
			return { action: "skip", reason: "La navegación solicitada apunta al detalle ya identificado." };
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
		const recent = ledger.toolHistory.slice(-4).map((item) => `${item.name}:${item.success ? "ok" : "error"}${item.useful ? ":useful" : ""}`).join(", ");
		const objectiveSatisfied = this.isObjectiveSatisfied(ledger);
		const remainingBudget = remainingIterations === null ? "unlimited" : remainingIterations;
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
		if (ledger.blockers.length > 0) lines.push(`Blockers: ${ledger.blockers.join(" | ")}`);
		if (ledger.imageUrls.length > 0) {
			lines.push("Images:");
			ledger.imageUrls.slice(0, 20).forEach((url, index) => lines.push(`${index + 1}. ${url}`));
		}
		if (ledger.mediaUrls.length > 0) {
			lines.push("Media:");
			ledger.mediaUrls.slice(0, 10).forEach((url, index) => lines.push(`${index + 1}. ${url}`));
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
		const sanitized = messages.filter((msg) => msg.role !== "tool" && !msg.toolCalls);
		return [
			...sanitized,
			{
				role: "system",
				content: `Runtime decision gate stopped further tool use. Reason: ${reason}\n\nUse the evidence below to answer the user now. Do not call tools. If something is missing, state exactly what is available and what could not be confirmed.\n\n${this.evidenceSummary(ledger)}`,
			},
		];
	}

	private buildFallbackFinalResponse(ledger: EvidenceLedger, reason: string): string {
		const lines = [`Detuve las herramientas porque ${reason}`];
		if (ledger.capturedScreenshots.length > 0) {
			lines.push("", "Capturas:");
			ledger.capturedScreenshots.forEach((url) => lines.push(`![Captura](${url})`));
		}
		if (ledger.detailScreenshots.length > 0) {
			lines.push("", "Capturas de detalle:");
			ledger.detailScreenshots.forEach((url) => lines.push(`![Detalle](${url})`));
		}
		if (ledger.detailUrl) lines.push("", `URL de detalle: ${ledger.detailUrl}`);
		if (ledger.imageUrls.length > 0) {
			lines.push("", "Imagenes encontradas:");
			ledger.imageUrls.slice(0, 20).forEach((url, index) => lines.push(`${index + 1}. ${url}`));
		}
		if (ledger.blockers.length > 0) {
			lines.push("", `Bloqueos detectados: ${ledger.blockers.join(" | ")}`);
		}
		return lines.join("\n");
	}

	private async *streamFinalResponse(
		messages: LLMMessage[],
		ledger: EvidenceLedger,
		reason: string,
	): AsyncIterable<string> {
		let yielded = false;
		try {
			const request: LLMRequest = {
				model: this.config.model ?? "default",
				messages: this.buildFinalizationMessages(messages, ledger, reason),
				maxTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				stream: true,
			};
			for await (const chunk of this.llmRouter.chatStream(request)) {
				if (!chunk.content) continue;
				yielded = true;
				yield chunk.content;
			}
		} catch {
			/* fallback below */
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
			});
			if (response.content?.trim()) return response.content;
		} catch {
			/* fallback below */
		}
		return this.buildFallbackFinalResponse(ledger, reason);
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

	async processMessage(message: string, channelId?: string): Promise<string> {
		const startedAt = Date.now();
		const userTurn: ConversationTurn = {
			role: "user",
			content: message,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(userTurn);

		// Update working memory from user message
		this.workingMemory.updateFromUserMessage(message);

		const memories = await this.memoryRetrieval.retrieveForContext(message);

		const skills = await this.skillLoader.resolveSkillsForTask({
			description: message,
			complexity: 0.5,
			domains: [],
			keywords: message.split(/\s+/).filter((w) => w.length > 3),
		});
		const learningInsights = await this.getRelevantLearning(message);

		const context = await this.buildContext(memories, skills, message, channelId, learningInsights);
		const tools = this.getAvailableTools();

		const response = await this.executeWithTools(context, tools);

		const assistantTurn: ConversationTurn = {
			role: "assistant",
			content: response.content,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(assistantTurn);

		if (this.userProfileManager) {
			this.userProfileManager.updateFromConversation("owner", [userTurn, assistantTurn])
				.catch(err => console.error("Failed to update user profile:", err));
		}

		this.updateActiveTask(response.content);

		this.dailyMemory?.addMessage(message, "user", channelId || "system").catch(() => {});
		this.dailyMemory?.addMessage(response.content, "assistant", channelId || "system").catch(() => {});

		this.recordLearningExperience({
			userRequest: message,
			finalResponse: response.content,
			channelId,
			startedAt,
			toolsUsed: response.toolCallsExecuted.map((tool) => ({
				name: tool.name,
				success: !tool.result.startsWith("Error:"),
				summary: tool.result.slice(0, MAX_TOOL_RESULT_STORED_CHARS),
			})),
			skillsUsed: this.toSkillTrace(skills),
		});

		return response.content;
	}

	static readonly STATUS_RE =
		/^\\x00STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?\\x00$/;

	async *processMessageStream(
		message: string,
		channelId?: string,
	): AsyncIterable<string> {
		const startedAt = Date.now();
		const userTurn: ConversationTurn = {
			role: "user",
			content: message,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(userTurn);

		// === Auto-escalado a multi-agente ===
		if (this.orchestrator) {
			try {
				const shouldDecompose = await this.orchestrator.shouldDecompose(message);
				if (shouldDecompose) {
					const decomposition = await this.orchestrator.decompose(message);
					if (decomposition.subtasks.length > 0) {
						yield `\x00STATUS:orchestrating:${decomposition.subtasks.length}\x00`;
						for await (const event of this.orchestrator.executeParallel(decomposition)) {
							switch (event.type) {
								case "worker_started":
									yield `\x00STATUS:worker_start:${event.workerId}:${Buffer.from(event.description.slice(0, 100), "utf8").toString("base64")}\x00`;
									break;
								case "worker_progress":
									yield `\x00STATUS:worker_progress:${event.workerId}:${Buffer.from(event.message.slice(0, 100), "utf8").toString("base64")}\x00`;
									break;
								case "worker_done":
									yield `\x00STATUS:worker_done:${event.workerId}\x00`;
									break;
								case "worker_error":
									yield `\x00STATUS:worker_error:${event.workerId}:${Buffer.from(event.error.slice(0, 100), "utf8").toString("base64")}\x00`;
									break;
								case "synthesis":
									yield "\x00STATUS:responding\x00";
									yield event.result;
									// Guardar en STM y memoria
									const assistantTurn: ConversationTurn = {
										role: "assistant",
										content: event.result,
										timestamp: new Date(),
										metadata: channelId ? { conversationId: channelId } : undefined,
									};
									this.stm.add(assistantTurn);
									this.dailyMemory?.addMessage(message, "user", channelId || "system").catch(() => {});
									this.dailyMemory?.addMessage(event.result, "assistant", channelId || "system").catch(() => {});
									this.recordLearningExperience({
										userRequest: message,
										finalResponse: event.result,
										channelId,
										startedAt,
										metadata: { mode: "multi-agent", workers: decomposition.subtasks.length },
									});
									return;
							}
						}
						return; // Multi-agent completado
					}
				}
			} catch (err) {
				console.error("[Orchestrator] Falló, usando single-agent:", err instanceof Error ? err.message : err);
				// Fallback a single-agent silenciosamente
			}
		}

		// === Single-agent (flujo normal) ===
		const memories = await this.memoryRetrieval.retrieveForContext(message);

		const skills = await this.skillLoader.resolveSkillsForTask({
			description: message,
			complexity: 0.5,
			domains: [],
			keywords: message.split(/\s+/).filter((w) => w.length > 3),
		});
		const learningInsights = await this.getRelevantLearning(message);

		const context = await this.buildContext(memories, skills, message, channelId, learningInsights);
		const tools = this.getAvailableTools();

		const messages = [...context];
		let iterations = 0;
		let fullResponse = "";
		const toolSignatureCounts = new Map<string, number>();
		const toolNameCounts = new Map<string, number>();
		const ledger = this.createEvidenceLedger(message);
		const toolTrace: ExperienceToolTrace[] = [];
		let stoppedByDecision = false;

		while (this.hasToolIterationsRemaining(iterations) && !stoppedByDecision) {
			iterations++;

			const request: LLMRequest = {
				model: this.config.model ?? "default",
				messages,
				maxTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				stream: true,
				tools: tools.length > 0 ? tools : undefined,
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

			try {
				yield "\x00STATUS:thinking\x00";
				for await (const chunk of this.llmRouter.chatStream(request)) {
					if (chunk.thinking) {
						if (!isThinking) {
							isThinking = true;
						}
					}
					
					if (chunk.content) {
						if (isThinking) {
							isThinking = false;
						}
						chunkContent += chunk.content;
						hasContent = true;
						if (!hasYieldedResponding) {
							yield "\x00STATUS:responding\x00";
							hasYieldedResponding = true;
						}
						yield chunk.content;
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
				fullResponse += `\n\n⚠️ Error: ${errMsg}`;
				yield errMsg;
				break;
			}

			const validToolCalls = toolCalls.filter(
				(tc) => tc.function.name.length > 0,
			);

			if (!hasContent && validToolCalls.length === 0) {
				const warnMsg = "\n\n⚠️ The AI model returned an empty response. This may be due to a content filter, context length limit, or an API error.";
				fullResponse += warnMsg;
				yield warnMsg;
				break;
			}

			if (
				validToolCalls.length === 0 ||
				!this.toolExecutor ||
				!this.toolRegistry
			) {
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

			for (const toolCall of validToolCalls) {
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
					toolResult = { success: false, output: "", error: policyResult.resultContent };
				} else {
					const toolNameCount = (toolNameCounts.get(toolCall.function.name) ?? 0) + 1;
					toolNameCounts.set(toolCall.function.name, toolNameCount);
					const toolBudget = this.getToolBudget(toolCall.function.name);
					const signature = `${toolCall.function.name}:${this.stableJson(params)}`;
					const signatureCount = (toolSignatureCounts.get(signature) ?? 0) + 1;
					toolSignatureCounts.set(signature, signatureCount);

					if (toolNameCount > toolBudget) {
						skipped = true;
						const policyResult = this.createToolPolicyResult(
							`${toolCall.function.name} exceeded its per-task budget (${toolBudget}). Use a simpler alternative, summarize progress, or finish with the useful results already collected.`,
						);
						toolResult = { success: false, output: "", error: policyResult.resultContent };
					} else if (signatureCount > MAX_REPEATED_TOOL_SIGNATURES) {
						skipped = true;
						const policyResult = this.createToolPolicyResult(
							`Repeated action suppressed for ${toolCall.function.name}. The same parameters were already tried ${MAX_REPEATED_TOOL_SIGNATURES} times. Choose a different approach or provide a final answer with the current evidence.`,
						);
						toolResult = { success: false, output: "", error: policyResult.resultContent };
					} else {
						const decision = this.decideBeforeToolCall(
							toolCall.function.name,
							params,
							ledger,
							this.getRemainingToolIterations(iterations),
						);
						if (decision.action === "skip") {
							skipped = true;
							const policyResult = this.createToolPolicyResult(decision.reason);
							toolResult = { success: false, output: "", error: policyResult.resultContent };
						} else {
							toolResult = await this.toolExecutor.execute(
								toolCall.function.name,
								params,
								this.getToolExecutionContext(),
							);
						}
					}
				}

				const rawResultContentStr = toolResult.success
					? (typeof toolResult.output === "string" ? toolResult.output : JSON.stringify(toolResult.output, null, 2))
					: `Error: ${toolResult.error ?? "Unknown error"}`;
				const resultContentStr = this.compactToolResultForContext(rawResultContentStr);
				this.updateEvidenceLedger(ledger, toolCall.function.name, resultContentStr, toolResult.success && !skipped);
				fullResponse += this.buildContinuationCheckpoint(
					ledger,
					toolCall.function.name,
					resultContentStr,
					toolResult.success && !skipped,
				);
				toolTrace.push({
					name: toolCall.function.name,
					success: toolResult.success && !skipped,
					useful: !skipped && toolResult.success && !resultContentStr.startsWith("Error:"),
					summary: resultContentStr.slice(0, MAX_TOOL_RESULT_STORED_CHARS),
					error: toolResult.success ? undefined : toolResult.error,
				});

				// Emit tool-done status (intercepted by frontend, not shown as text)
				if (skipped) {
					const skippedDetail = this.encodeStatusField(resultContentStr.replace(/^Error:\s*/, ""));
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

		// If we exhausted all iterations, warn the user
		if (!stoppedByDecision && this.hasReachedToolIterationLimit(iterations)) {
			const maxIterations = this.getToolIterationLimit().maxIterations;
			let limitMsg = `\n\n⚠️ He alcanzado el límite máximo de herramientas en una sola respuesta (${maxIterations} iteraciones). Puedo continuar si me lo pides.`;
			if (ledger.usefulResults > 0) {
				limitMsg = await this.generateFinalResponse(
					messages,
					ledger,
					`se alcanzó el límite de ${maxIterations} iteraciones con evidencia útil disponible`,
				);
			}
			fullResponse += limitMsg;
			yield limitMsg;
		}

		const assistantTurn: ConversationTurn = {
			role: "assistant",
			content: fullResponse,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(assistantTurn);
		
		if (this.userProfileManager) {
			this.userProfileManager.updateFromConversation("owner", [userTurn, assistantTurn])
				.catch(err => console.error("Failed to update user profile:", err));
		}

		this.dailyMemory?.addMessage(message, "user", channelId || "system").catch(() => {});
		this.dailyMemory?.addMessage(fullResponse, "assistant", channelId || "system").catch(() => {});
		
		this.updateActiveTask(fullResponse);
		this.recordLearningExperience({
			userRequest: message,
			finalResponse: fullResponse,
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
		const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
		const ledger = this.createEvidenceLedger(userText);

		while (this.hasToolIterationsRemaining(iterations)) {
			iterations++;

			const request: LLMRequest = {
				model: this.config.model ?? "default",
				messages,
				maxTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				tools: tools.length > 0 ? tools : undefined,
			};

			const response = await this.llmRouter.chat(request);

			if (
				response.toolCalls &&
				response.toolCalls.length > 0 &&
				this.toolExecutor &&
				this.toolRegistry
			) {
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
							const finalContent = await this.generateFinalResponse(messages, ledger, decision.reason);
							return { content: finalContent, toolCallsExecuted };
						}
						const toolNameCount = (toolNameCounts.get(toolCall.function.name) ?? 0) + 1;
						toolNameCounts.set(toolCall.function.name, toolNameCount);
						const signature = `${toolCall.function.name}:${this.stableJson(params)}`;
						const signatureCount = (toolSignatureCounts.get(signature) ?? 0) + 1;
						toolSignatureCounts.set(signature, signatureCount);
						const toolBudget = this.getToolBudget(toolCall.function.name);

						if (toolNameCount > toolBudget) {
							toolResult = {
								success: false,
								output: "",
								error: this.createToolPolicyResult(
									`${toolCall.function.name} exceeded its per-task budget (${toolBudget}). Use a simpler alternative, summarize progress, or finish with the useful results already collected.`,
								).resultContent,
							};
						} else if (signatureCount > MAX_REPEATED_TOOL_SIGNATURES) {
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
								error: this.createToolPolicyResult(decision.reason).resultContent,
							};
						} else {
							toolResult = await this.toolExecutor!.execute(
								toolCall.function.name,
								params,
								this.getToolExecutionContext(),
							);
						}
					}

					const rawResultContent = toolResult.success
						? toolResult.output
						: `Error: ${toolResult.error ?? "Unknown error"}`;
					const resultContent = this.compactToolResultForContext(rawResultContent);
					this.updateEvidenceLedger(ledger, toolCall.function.name, resultContent, toolResult.success);

					const parsedContent = this.formatToolResultForModel(resultContent);

					toolResults.push({
						toolCallId: toolCall.id,
						name: toolCall.function.name,
						resultContent: parsedContent,
						executedName: toolCall.function.name,
						executedResult: resultContent.slice(0, MAX_TOOL_RESULT_STORED_CHARS),
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
				return { content: response.content, toolCallsExecuted };
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
			content: `I reached the maximum number of tool iterations. Here is what I have so far:\n${messages[messages.length - 1]?.content ?? ""}`,
			toolCallsExecuted,
		};
	}

	private getAvailableTools(): LLMTool[] {
		if (!this.toolRegistry) return [];
		return this.toolRegistry.toLLMTools();
	}

	private async buildContext(
		memories: MemoryContext,
		skills: LoadedSkill[],
		userMessage: string,
		channelId?: string,
		learningInsights: LearningInsight[] = [],
	): Promise<LLMMessage[]> {
		const messages: LLMMessage[] = [];
		const contextParts: string[] = [];

		let systemContent = this.config.systemPrompt;
		
		if (this.userProfileManager) {
			try {
				const profile = await this.userProfileManager.getProfile("owner");
				let profileStr = `### User Profile (Preferences & Context)\n`;
				profileStr += `- Communication Style: ${profile.communicationStyle}\n`;
				if (Object.keys(profile.preferences).length > 0) {
					profileStr += `- Preferences: ${Object.entries(profile.preferences).map(([k, v]) => `${k}=${v}`).join(", ")}\n`;
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
			const guidance = learningInsights
				.map((insight) => {
					const label = insight.type.replace(/_/g, " ");
					return `- ${label}: ${insight.content}`;
				})
				.join("\n");
			systemContent += `\n\n# Learned Operating Guidance\nUse these prior operational learnings when they are relevant. Prefer higher-confidence procedures and avoid listed anti-patterns.\n${guidance}`;
		}

		if (this.toolRegistry && this.toolRegistry.list().length > 0) {
			const toolNames = this.toolRegistry
				.list()
				.map((t) => `- ${t.name}: ${t.description}`)
				.join("\n");
			systemContent += `\n\n# Available Tools\nYou have access to the following tools. Use them when needed to help the user:\n${toolNames}`;
			systemContent += "\n\nCRITICAL RULE: Do NOT use tools or hallucinate past tasks for simple greetings (e.g. 'hola') or casual conversation. Only use tools if the *latest* user request explicitly requires it.";
			systemContent += "\n\nIMPORTANT: When using the `create_tool` tool to create new tools, ALWAYS provide an animated SVG icon in the `uiIcon` parameter. The icon should be relevant to the tool's purpose and contain CSS animations like 'animation: pulse 2s infinite ease-in-out' on relevant elements.";
		}
		
		systemContent += `\n\nCRITICAL SYSTEM INSTRUCTION:
- You have access to a persistent Long-Term Memory (LTM) system.
- NEVER claim that you do not have memory or that "each conversation starts fresh".
- If no memories are provided in the context below, simply state that you don't have relevant information.`;

		systemContent += `\n\n## AUTHENTICATED BROWSING (MANDATORY)
Your browser has PERSISTENT SESSIONS. Cookies and login state are automatically saved to disk and restored when revisiting sites. This means:

1. **NEVER refuse to interact with logged-in websites.** If the user says "check my Facebook/Instagram/etc", DO IT. The session cookies are already saved from a previous login. Do NOT say you "cannot handle credentials" or "cannot log in" — you are NOT logging in, you are using an EXISTING session.
2. **If a site requires login and no session exists**, tell the user: "I need you to log in manually first. I'll open the page, you enter your credentials, and I'll remember the session for next time." Do NOT refuse the task entirely.
3. **Sessions persist for 7 days** across restarts. The user does not need to re-login every time.
4. **You CAN perform all human actions**: click, type, scroll, like, comment, post, upload, download, navigate menus, etc. You are a full browser automation agent.

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
5. **Be persistent**: If one approach fails, try another. Use at least 3 different strategies before reporting failure.`;

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
7. ${zaiVisionMode ? "Because the active model is Z.ai GLM, analyze browser screenshots with a Z.AI Vision MCP tool using the local screenshot path before deciding the next browser action. Do not rely on direct image understanding for these screenshots." : "Because the active model is not Z.ai GLM, use direct multimodal image understanding for browser screenshots when available. Do not call Z.AI Vision MCP tools solely to inspect browser screenshots."}
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

		if (memories.memories.length > 0) {
			const memoryFacts = memories.memories
				.map((m) => {
					let sourceStr = "";
					const sourceChannel = m.item.source?.channelId;
					if (sourceChannel) {
						sourceStr = `[Channel: ${sourceChannel}] `;
					} else if (m.item.source?.conversationId) {
						sourceStr = `[Conversation: ${m.item.source.conversationId}] `;
					}
					
					const timeMs = Date.now() - m.item.createdAt.getTime();
					const hours = Math.round(timeMs / (1000 * 60 * 60));
					const timeStr = hours > 24 
						? `[${Math.round(hours/24)} days ago] ` 
						: hours > 0 ? `[${hours} hours ago] ` : "[Recently] ";

					return `- ${sourceStr}${timeStr}${m.item.content}`;
				})
				.join("\n");
			messages.push({
				role: "system",
				content: `Relevant memories from long-term storage:\n${memoryFacts}`,
			});
		}

		const stmTurns = this.stm.getContext();
		let conversationTurns = stmTurns;
		if (channelId) {
			conversationTurns = stmTurns.filter(t => !t.metadata?.conversationId || t.metadata.conversationId === channelId);
		}
		const recentTurns = conversationTurns.slice(-20);
		for (const turn of recentTurns) {
			if (turn.role === "user" || turn.role === "assistant") {
				messages.push({ role: turn.role, content: turn.content });
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

		const parsedMessages = messages.map(msg => {
			if (typeof msg.content === "string") {
				const imgRegex = /!\[.*?\]\(\/api\/media\/file\/([^)]+)\)/g;
				const matches = [...msg.content.matchAll(imgRegex)];
				if (matches.length > 0) {
					const localPaths = this.getLocalMediaPathsFromContent(msg.content);
					if (this.shouldUseZaiVisionToolsForImages()) {
						return { ...msg, content: this.appendZaiVisionHint(msg.content, localPaths) };
					}

					return {
						...msg,
						content: `${msg.content}\n[Image media is referenced by URL/path and not re-embedded into context.]`,
					};
				}
			}
			return msg;
		});

		return parsedMessages;
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
