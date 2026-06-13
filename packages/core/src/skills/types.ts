export interface Skill {
	id: string;
	name: string;
	version: string;
	description: string;
	tags: string[];
	embedding: number[];
	instructions: string;
	examples: string[];
	templates: string[];
	triggerConditions: {
		keywords: string[];
		taskPatterns: string[];
		domains: string[];
	};
	contextEstimate: {
		instructions: number;
		perExample: number;
		templates: number;
	};
	metrics: {
		timesUsed: number;
		successRate: number;
		avgUserRating: number;
		lastUsed: string;
		improvementsCount: number;
		createdAt: string;
	};
	quality: {
		completeness: number;
		accuracy: number;
		clarity: number;
	};
	dependencies: string[];
	related: string[];
	/** Trazabilidad de la información actualizada usada al generar/mejorar la skill. */
	freshInfo?: {
		sources: string[];
		fetchedAt: string;
		summary: string;
	};
}

export interface SkillUsage {
	id: string;
	skillId: string;
	task: string;
	success: boolean;
	failureReason?: string;
	userFeedback?: string;
	successReason?: string;
	timestamp: Date;
}

export interface SkillMatch {
	skill: Skill;
	similarity: number;
	rankScore: number;
}

export interface LoadedSkill {
	skill: Skill;
	content: string;
	level: 1 | 2 | 3 | 4;
}

export interface TaskNeeds {
	domains: string[];
	complexity: number;
	needsSkill: boolean;
	keywords: string[];
	description: string;
	embedding: number[];
}

export interface ABTest {
	id: string;
	skillId: string;
	versionA: string;
	versionB: string;
	startDate: Date;
	sampleSize: number;
	results: {
		a: { successes: number; total: number };
		b: { successes: number; total: number };
	};
	status: "running" | "completed" | "cancelled";
}

export interface SkillForgeConfig {
	complexityThreshold: number;
	selfCritique: boolean;
	minQualityScore: number;
	includeExamples: boolean;
	includeTemplates: boolean;
	includeAntiPatterns: boolean;
	/** Generar instrucciones con LLM (en vez de heurístico). Default: true. */
	llmGeneration?: boolean;
}

/** Configuración del cliente HTTP de Context7 (fallback cuando no hay MCP). */
export interface Context7Config {
	enabled: boolean;
	/** Nombre del MCP server de Context7 (las tools se exponen como `${mcpServer}_*`). */
	mcpServer: string;
	/** Endpoint HTTP público base (fallback cuando el MCP no está registrado). */
	httpEndpoint: string;
	/** API key opcional (Bearer) para mayor límite de tasa. */
	apiKey?: string;
	/** Timeout por request HTTP, en ms. */
	timeoutMs: number;
}

/** Configuración del research de información actualizada para skills. */
export interface SkillResearchConfig {
	enabled: boolean;
	/** Si true, solo se investigan skills técnicas/documentables. */
	onlyTechnical: boolean;
	/** Usar el LLM para clasificar (más preciso, más costoso). Si false, heurístico. */
	useLlmClassifier: boolean;
	context7: Context7Config;
	/** Nombre de la tool de búsqueda web (ej. "zai-web-search"). */
	webSearchTool: string;
	/** Nombre de la tool de lectura de URL (ej. "zai-web-reader"). */
	webReaderTool: string;
	/** Nombre de la tool de navegación browser headless (ej. "browser_navigate"). */
	browserFetchTool: string;
	/** Presupuesto máx. de tokens para el contexto de research inyectado. */
	maxContextTokens: number;
	/** Máximo número de fuentes a acumular. */
	maxSources: number;
}

export interface SkillResearchInput {
	description: string;
	keywords: string[];
	domains: string[];
}

export interface SkillResearchResult {
	/** Si la skill es técnica/documentable (merece research). */
	isTechnical: boolean;
	/** Texto de información actualizada para inyectar en el prompt del LLM. */
	context: string;
	/** Fuentes consultadas (ej. "context7:/vercel/next.js", "web:...", "browser:..."). */
	sources: string[];
	/** ISO timestamp de la consulta. */
	fetchedAt: string;
	/** Resumen breve de lo encontrado. */
	summary: string;
}
