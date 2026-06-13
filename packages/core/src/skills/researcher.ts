import type { LLMRouter } from "../ai/router.js";
import { createLogger } from "../utils/logger.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolResult } from "../tools/registry.js";
import { Context7HttpClient } from "./context7-http.js";
import type {
	SkillResearchConfig,
	SkillResearchInput,
	SkillResearchResult,
} from "./types.js";

const logger = createLogger("skill-researcher");

export const DEFAULT_SKILL_RESEARCH_CONFIG: SkillResearchConfig = {
	enabled: true,
	onlyTechnical: true,
	useLlmClassifier: false,
	context7: {
		enabled: true,
		mcpServer: "context7",
		httpEndpoint: "https://context7.com",
		timeoutMs: 8000,
	},
	webSearchTool: "zai-web-search",
	webReaderTool: "zai-web-reader",
	browserFetchTool: "browser_navigate",
	maxContextTokens: 2000,
	maxSources: 4,
};

const URL_RE = /https?:\/\/[^\s)"'<>]+/gi;

/**
 * Obtiene información **actualizada** para generar/mejorar una skill, con la
 * cadena Context7 → web → browser (invisible/headless). Cada paso es opcional y
 * best-effort: si una fuente falla o no existe, se pasa a la siguiente; si
 * ninguna aporta, se devuelve contexto vacío y la skill se genera sin research.
 *
 * Las skills puramente experienciales (no técnicas/documentables) no se
 * investiguan cuando `onlyTechnical` está activo.
 */
export class SkillResearcher {
	private config: SkillResearchConfig;
	private http: Context7HttpClient;
	private candidateUrls: string[] = [];

	constructor(
		private toolExecutor: ToolExecutor,
		private router?: LLMRouter,
		config?: Partial<SkillResearchConfig>,
	) {
		this.config = { ...DEFAULT_SKILL_RESEARCH_CONFIG, ...config };
		this.http = new Context7HttpClient(this.config.context7);
	}

	setRouter(router: LLMRouter): void {
		this.router = router;
	}

	updateConfig(config: Partial<SkillResearchConfig>): void {
		this.config = { ...this.config, ...config };
		this.http = new Context7HttpClient(this.config.context7);
	}

	async research(input: SkillResearchInput): Promise<SkillResearchResult> {
		const fetchedAt = new Date().toISOString();
		const empty: SkillResearchResult = {
			isTechnical: false,
			context: "",
			sources: [],
			fetchedAt,
			summary: "",
		};
		if (!this.config.enabled) return empty;

		const isTechnical = await this.classifyTechnical(input);
		if (this.config.onlyTechnical && !isTechnical) {
			return { ...empty, summary: "non-technical skill; no research needed" };
		}

		this.candidateUrls = [];
		const sources: string[] = [];
		const blocks: string[] = [];

		const c7 = await this.tryContext7(input);
		if (c7.context) {
			blocks.push(c7.context);
			sources.push(...c7.sources);
		}

		if (this.hasBudget(blocks)) {
			const web = await this.tryWeb(input);
			if (web.context) {
				blocks.push(web.context);
				sources.push(...web.sources);
			}
		}

		if (this.hasBudget(blocks) && this.candidateUrls.length > 0) {
			const br = await this.tryBrowser();
			if (br.context) {
				blocks.push(br.context);
				sources.push(...br.sources);
			}
		}

		const context = this.capChars(blocks.join("\n\n"), this.config.maxContextTokens);
		return {
			isTechnical: true,
			context,
			sources: sources.slice(0, this.config.maxSources),
			fetchedAt,
			summary: sources.length
				? `researched via ${sources.join(", ")}`
				: "no fresh info sources available",
		};
	}

	/** Clasifica si la skill es técnica/documentable (heurística, o LLM si está activo). */
	async classifyTechnical(input: SkillResearchInput): Promise<boolean> {
		const text = `${input.description} ${input.keywords.join(" ")} ${input.domains.join(" ")}`;
		if (this.config.useLlmClassifier && this.router) {
			try {
				return await this.classifyWithLlm(text);
			} catch (err) {
				logger.warn(`LLM classifier failed, using heuristic: ${String(err)}`);
			}
		}
		return this.classifyHeuristic(text, input.domains);
	}

	private classifyHeuristic(text: string, domains: string[]): boolean {
		const lower = text.toLowerCase();
		if (
			/\b(api|sdk|librer(?:í|i)a|framework|package|m(?:ó|o)dulo|endpoint|cli|library|compiler|runtime)\b/.test(
				lower,
			)
		)
			return true;
		if (/v?\d+\.\d+\.\d+|\bversi(?:ó|o)n\b|\b\d+\.\d+\b/.test(lower)) return true;
		if (
			/\b(react|next\.?js|vue|nuxt|angular|svelte|node|express|fastify|prisma|tailwind|django|flask|spring|laravel|rails|postgres|mysql|sqlite|redis|mongodb|docker|kubernetes|terraform|aws|gcp|azure|vite|webpack|turbo)\b/.test(
				lower,
			)
		)
			return true;
		if (/https?:\/\/(docs?|developer|api|reference)\./i.test(text)) return true;
		if (domains.some((d) => /code|api|backend|frontend|devops|database|web|ml|data|cloud/i.test(d)))
			return true;
		return false;
	}

	private async classifyWithLlm(text: string): Promise<boolean> {
		const res = await this.router!.chat({
			model: "default",
			maxTokens: 5,
			temperature: 0,
			messages: [
				{
					role: "system",
					content:
						"Reply ONLY 'YES' if the task is about a software library, framework, API, SDK, CLI, cloud service, or technical documentation. Otherwise reply 'NO'.",
				},
				{ role: "user", content: text.slice(0, 400) },
			],
		});
		return /^y/i.test((res.content ?? "").trim());
	}

	/** Context7: intenta las tools MCP (si están registradas); si no, fallback HTTP. */
	private async tryContext7(
		input: SkillResearchInput,
	): Promise<{ context: string; sources: string[] }> {
		const query = (input.keywords[0] || input.description.slice(0, 60) || "").trim();
		if (!query) return { context: "", sources: [] };

		const mcp = await this.tryContext7Mcp(query);
		if (mcp.context) return mcp;

		if (!this.config.context7.enabled) return { context: "", sources: [] };
		const lib = await this.http.searchLibrary(query);
		if (!lib?.id) return { context: "", sources: [] };
		const ctx = await this.http.fetchContext(lib.id, query, 1500);
		if (!ctx) return { context: "", sources: [] };
		return {
			context: this.capChars(ctx, 1500),
			sources: [`context7:${lib.id}`],
		};
	}

	private async tryContext7Mcp(
		query: string,
	): Promise<{ context: string; sources: string[] }> {
		const resolveNames = [
			"context7_resolve-library-id",
			`${this.config.context7.mcpServer}_resolve-library-id`,
		];
		const queryNames = [
			"context7_query-docs",
			`${this.config.context7.mcpServer}_query-docs`,
		];

		let libraryId: string | null = null;
		for (const name of resolveNames) {
			const r = await this.exec(name, { query });
			if (r?.success && r.output) {
				libraryId = this.extractLibraryId(r.output);
				if (libraryId) break;
			}
		}
		if (!libraryId) return { context: "", sources: [] };

		for (const name of queryNames) {
			const r = await this.exec(name, {
				libraryId,
				query,
				tokens: 1500,
			});
			if (r?.success && r.output) {
				return {
					context: this.capChars(r.output, 1500),
					sources: [`context7:${libraryId}`],
				};
			}
		}
		return { context: "", sources: [] };
	}

	private extractLibraryId(output: string): string | null {
		const match = output.match(/\/[a-z0-9_.-]+\/[a-z0-9_.-]+/i);
		return match ? match[0] : null;
	}

	/** Web: busca con zai-web-search y lee la primera URL con zai-web-reader. */
	private async tryWeb(
		input: SkillResearchInput,
	): Promise<{ context: string; sources: string[] }> {
		const query = input.description.slice(0, 80).trim();
		if (!query) return { context: "", sources: [] };

		const search = await this.exec(this.config.webSearchTool, { query });
		if (!search?.success || !search.output) return { context: "", sources: [] };

		const urls = (search.output.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:]$/, ""));
		if (urls.length === 0) return { context: "", sources: [] };
		this.candidateUrls.push(...urls.slice(0, 3));

		const url = urls[0];
		const read = await this.exec(this.config.webReaderTool, { url });
		if (!read?.success || !read.output) return { context: "", sources: [] };
		return {
			context: this.capChars(read.output, 1500),
			sources: [`web:${url}`],
		};
	}

	/** Browser invisible: navega una URL candidata y extrae su texto. */
	private async tryBrowser(): Promise<{ context: string; sources: string[] }> {
		const url = this.candidateUrls.shift();
		if (!url) return { context: "", sources: [] };
		const nav = await this.exec(this.config.browserFetchTool, { url });
		if (!nav?.success || !nav.output) return { context: "", sources: [] };
		return {
			context: this.capChars(nav.output, 1200),
			sources: [`browser:${url}`],
		};
	}

	private async exec(
		name: string,
		params: Record<string, unknown>,
	): Promise<ToolResult | null> {
		try {
			return await this.toolExecutor.execute(name, params);
		} catch (err) {
			logger.warn(`tool '${name}' failed: ${String(err)}`);
			return null;
		}
	}

	private hasBudget(blocks: string[]): boolean {
		const chars = blocks.join("").length;
		return chars < this.config.maxContextTokens * 4;
	}

	/** Recorta a un aproximado de N tokens (~4 chars/token). */
	private capChars(text: string, maxTokens: number): string {
		const max = maxTokens * 4;
		return text.length > max ? `${text.slice(0, max)}…` : text;
	}
}
