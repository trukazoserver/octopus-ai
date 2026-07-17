/**
 * EmbeddingProvider — Embeddings reales para memoria semántica.
 *
 * Soporta TODOS los proveedores:
 * - OpenAI-compatible (zhipu, openai, deepseek, mistral, xai) → /embeddings
 * - Google/Gemini → /models/{model}:embedContent
 * - Cohere → /embed
 * - Ollama → /api/embeddings
 * - Hash fallback → offline, siempre disponible
 *
 * Features:
 * - Cache LRU por hash del texto
 * - Batch embedding para consolidación masiva
 * - Normalización automática a unit vectors
 * - Auto-detección del proveedor por config
 */

import { createHash, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "../utils/logger.js";
import type {
	EmbeddingDescriptor,
	EmbeddingFunction,
	EmbeddingTask,
	VersionedEmbedding,
} from "./types.js";

const logger = createLogger("embedding-provider");

export type EmbeddingApiType = "openai" | "google" | "cohere" | "ollama";
export type EmbeddingAuthMode = "api-key" | "vertex";

export interface EmbeddingProviderConfig {
	/** Dimensiones del embedding */
	dimensions: number;
	/** Modelo de embeddings a usar */
	model: string;
	/** API key para el proveedor */
	apiKey: string;
	/** Base URL del proveedor */
	baseUrl: string;
	/** Tipo de API del proveedor */
	apiType: EmbeddingApiType;
	/** Modo de autenticacion para APIs que soportan varios modos */
	authMode: EmbeddingAuthMode;
	/** OAuth/Vertex access token directo */
	accessToken: string;
	/** Variable de entorno para OAuth/Vertex access token */
	accessTokenEnv: string;
	/** Service account JSON para Vertex AI */
	credentialsFile: string;
	/** Service account JSON inline para Vertex AI */
	credentialsJson: string;
	/** Google Cloud project para Vertex AI */
	projectId: string;
	/** Google Cloud location para Vertex AI */
	location: string;
	/** Rol del texto para proveedores con prompts de retrieval */
	task: EmbeddingTask;
	/** Máximo de textos por batch */
	maxBatchSize: number;
	/** Máximo de caracteres por texto antes de truncar */
	maxTextLength: number;
	/** Tamaño del cache LRU */
	cacheSize: number;
	/** Tiempo antes de reintentar la API tras una falla */
	failureRetryMs: number;
}

const DEFAULT_CONFIG: EmbeddingProviderConfig = {
	dimensions: 1024,
	model: "",
	apiKey: "",
	baseUrl: "",
	apiType: "openai",
	authMode: "api-key",
	accessToken: "",
	accessTokenEnv: "",
	credentialsFile: "",
	credentialsJson: "",
	projectId: "",
	location: "us-central1",
	task: "document",
	maxBatchSize: 32,
	maxTextLength: 8000,
	cacheSize: 500,
	failureRetryMs: 60_000,
};

/** Resultado de un embedding con metadata */
export interface EmbeddingResult {
	embedding: number[];
	descriptor: EmbeddingDescriptor;
	model: string;
	cached: boolean;
	tokensUsed: number;
}

export class EmbeddingProvider {
	private config: EmbeddingProviderConfig;
	private cache: Map<string, number[]> = new Map();
	private cacheOrder: string[] = [];
	private apiAvailable: boolean | null = null;
	private lastApiFailureAt = 0;
	private totalApiCalls = 0;
	private totalCacheHits = 0;
	private totalFallbacks = 0;
	private vertexTokenCache?: { token: string; expiresAt: number };

	constructor(config: Partial<EmbeddingProviderConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Generar embedding para un texto.
	 * Usa cache → API → fallback hash.
	 */
	async embed(
		text: string,
		task: EmbeddingTask = this.config.task,
	): Promise<number[]> {
		return (await this.embedVersioned(text, task)).values;
	}

	async embedVersioned(
		text: string,
		task: EmbeddingTask = this.config.task,
	): Promise<VersionedEmbedding> {
		if (!text || text.trim().length === 0) {
			return {
				values: new Array(this.config.dimensions).fill(0),
				descriptor: this.fallbackDescriptor(),
			};
		}

		const cleanText = text.trim().slice(0, this.config.maxTextLength);
		const cacheKey = this.cacheKey(task, cleanText);

		// Check cache
		const cached = this.cache.get(cacheKey);
		if (cached) {
			this.totalCacheHits++;
			return { values: cached, descriptor: this.providerDescriptor() };
		}

		// Try API
		if (this.hasApiCredentials() && this.shouldTryApi()) {
			try {
				const result = this.validateApiBatch(
					await this.embedViaAPI([cleanText], task),
					1,
				);
				if (result.length > 0) {
					this.apiAvailable = true;
					this.lastApiFailureAt = 0;
					const embedding = result[0];
					this.cacheSet(cacheKey, embedding);
					return { values: embedding, descriptor: this.providerDescriptor() };
				}
			} catch (err) {
				this.lastApiFailureAt = Date.now();
				if (this.apiAvailable !== false) {
					logger.warn(
						`Embedding API not available, using hash fallback until retry window expires: ${String(err)}`,
					);
				}
				this.apiAvailable = false;
			}
		}

		// Fallback: hash-based bag-of-words
		this.totalFallbacks++;
		const fallback = this.hashEmbedding(cleanText);
		return { values: fallback, descriptor: this.fallbackDescriptor() };
	}

	/**
	 * Batch embedding — más eficiente para consolidación.
	 */
	async embedBatch(
		texts: string[],
		task: EmbeddingTask = this.config.task,
	): Promise<number[][]> {
		if (texts.length === 0) return [];

		const results: number[][] = new Array(texts.length);
		const uncachedIndices: number[] = [];
		const uncachedTexts: string[] = [];

		// Check cache first
		for (let i = 0; i < texts.length; i++) {
			const clean = (texts[i] || "").trim().slice(0, this.config.maxTextLength);
			const key = this.cacheKey(task, clean);
			const cached = this.cache.get(key);
			if (cached) {
				results[i] = cached;
				this.totalCacheHits++;
			} else {
				uncachedIndices.push(i);
				uncachedTexts.push(clean);
			}
		}

		if (uncachedTexts.length === 0) return results;

		// Try API for uncached
		if (this.hasApiCredentials() && this.shouldTryApi()) {
			try {
				for (
					let batch = 0;
					batch < uncachedTexts.length;
					batch += this.config.maxBatchSize
				) {
					const batchTexts = uncachedTexts.slice(
						batch,
						batch + this.config.maxBatchSize,
					);
					const batchIndices = uncachedIndices.slice(
						batch,
						batch + this.config.maxBatchSize,
					);
					const embeddings = this.validateApiBatch(
						await this.embedViaAPI(batchTexts, task),
						batchTexts.length,
					);

					for (let j = 0; j < embeddings.length; j++) {
						const idx = batchIndices[j];
						results[idx] = embeddings[j];
						this.cacheSet(
							this.cacheKey(task, batchTexts[j]),
							embeddings[j],
						);
					}
				}
				this.apiAvailable = true;
				this.lastApiFailureAt = 0;
				return results;
			} catch (err) {
				this.lastApiFailureAt = Date.now();
				if (this.apiAvailable !== false) {
					logger.warn(
						`Batch embedding API failed, using hash fallback until retry window expires: ${String(err)}`,
					);
				}
				this.apiAvailable = false;
			}
		}

		// Fallback for remaining
		for (const i of uncachedIndices) {
			if (!results[i]) {
				const clean = (texts[i] || "")
					.trim()
					.slice(0, this.config.maxTextLength);
				results[i] = this.hashEmbedding(clean);
				this.totalFallbacks++;
			}
		}

		return results;
	}

	/**
	 * Obtener la función de embedding compatible con EmbeddingFunction type.
	 */
	getEmbedFunction(): EmbeddingFunction {
		const embed: EmbeddingFunction = (text, task) => this.embed(text, task);
		embed.embedVersioned = (text, task) => this.embedVersioned(text, task);
		embed.getDescriptor = () => this.getDescriptor();
		return embed;
	}

	getDescriptor(): EmbeddingDescriptor {
		const quality =
			this.hasApiCredentials() && this.apiAvailable !== false
				? "provider"
				: "fallback";
		return {
			provider: quality === "provider" ? this.config.apiType : "hash-bow",
			model:
				quality === "provider" ? this.config.model || "unspecified" : "hash-bow-v1",
			dimensions: this.config.dimensions,
			version:
				quality === "provider"
					? this.providerVersion()
					: `hash-bow-v1:${this.config.dimensions}`,
			quality,
		};
	}

	private providerDescriptor(): EmbeddingDescriptor {
		return {
			provider: this.config.apiType,
			model: this.config.model || "unspecified",
			dimensions: this.config.dimensions,
			version: this.providerVersion(),
			quality: "provider",
		};
	}

	private fallbackDescriptor(): EmbeddingDescriptor {
		return {
			provider: "hash-bow",
			model: "hash-bow-v1",
			dimensions: this.config.dimensions,
			version: `hash-bow-v1:${this.config.dimensions}`,
			quality: "fallback",
		};
	}

	/**
	 * Estadísticas del provider.
	 */
	getStats(): {
		apiAvailable: boolean;
		totalApiCalls: number;
		totalCacheHits: number;
		totalFallbacks: number;
		cacheSize: number;
		model: string;
		dimensions: number;
		apiType: EmbeddingApiType;
		version: string;
		quality: EmbeddingDescriptor["quality"];
	} {
		const descriptor = this.getDescriptor();
		return {
			apiAvailable: this.apiAvailable ?? false,
			totalApiCalls: this.totalApiCalls,
			totalCacheHits: this.totalCacheHits,
			totalFallbacks: this.totalFallbacks,
			cacheSize: this.cache.size,
			model: this.config.model,
			dimensions: this.config.dimensions,
			apiType: this.config.apiType,
			version: descriptor.version,
			quality: descriptor.quality,
		};
	}

	// ==========================================================
	// API Adapters — one per provider type
	// ==========================================================

	private async embedViaAPI(
		texts: string[],
		task: EmbeddingTask,
	): Promise<number[][]> {
		switch (this.config.apiType) {
			case "google":
				return this.embedViaGoogle(texts, task);
			case "cohere":
				return this.embedViaCohere(texts);
			case "ollama":
				return this.embedViaOllama(texts);
			default:
				return this.embedViaOpenAI(texts);
		}
	}

	private shouldTryApi(): boolean {
		if (this.apiAvailable !== false) return true;
		if (this.config.failureRetryMs <= 0) return true;
		return Date.now() - this.lastApiFailureAt >= this.config.failureRetryMs;
	}

	private validateApiBatch(
		embeddings: number[][],
		expectedCount: number,
	): number[][] {
		if (embeddings.length !== expectedCount) {
			throw new Error(
				`Embedding API cardinality mismatch: expected ${expectedCount}, received ${embeddings.length}`,
			);
		}
		for (let index = 0; index < embeddings.length; index++) {
			const embedding = embeddings[index];
			if (embedding.length !== this.config.dimensions) {
				throw new Error(
					`Embedding API dimension mismatch at index ${index}: expected ${this.config.dimensions}, received ${embedding.length}`,
				);
			}
			if (!embedding.every(Number.isFinite)) {
				throw new Error(
					`Embedding API returned non-finite values at index ${index}`,
				);
			}
		}
		return embeddings;
	}

	private cacheKey(task: EmbeddingTask, text: string): string {
		return this.hashText(`${this.providerVersion()}:${task}:${text}`);
	}

	private providerVersion(): string {
		const identity = JSON.stringify({
			apiType: this.config.apiType,
			baseUrl: this.trimTrailingSlash(this.config.baseUrl),
			model: this.config.model,
			dimensions: this.config.dimensions,
			task: this.config.task,
		});
		return `${this.config.apiType}:${this.config.model || "unspecified"}:${this.config.dimensions}:${this.hashText(identity).slice(0, 12)}`;
	}

	private hasApiCredentials(): boolean {
		if (this.config.apiType === "ollama") return true;
		if (this.config.apiType === "google" && this.config.authMode === "vertex") {
			return Boolean(
				this.config.accessToken ||
					(this.config.accessTokenEnv &&
						process.env[this.config.accessTokenEnv]) ||
					process.env.GOOGLE_VERTEX_ACCESS_TOKEN ||
					process.env.GOOGLE_ACCESS_TOKEN ||
					this.config.credentialsFile ||
					this.config.credentialsJson ||
					process.env.GOOGLE_APPLICATION_CREDENTIALS,
			);
		}
		return Boolean(this.config.apiKey);
	}

	/**
	 * OpenAI-compatible API (zhipu, openai, deepseek, mistral, xai, openrouter)
	 * POST /embeddings
	 */
	private async embedViaOpenAI(texts: string[]): Promise<number[][]> {
		const body: Record<string, unknown> = {
			model: this.config.model,
			input: texts.length === 1 ? texts[0] : texts,
		};

		if (this.config.dimensions && this.config.dimensions !== 1024) {
			body.dimensions = this.config.dimensions;
		}

		this.totalApiCalls++;

		const response = await fetch(
			`${this.trimTrailingSlash(this.config.baseUrl)}/embeddings`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			},
		);

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`OpenAI Embedding API error: ${response.status} ${errorText.slice(0, 200)}`,
			);
		}

		const data = (await response.json()) as {
			data: Array<{ embedding: number[]; index: number }>;
		};

		if (!data.data || data.data.length === 0) {
			throw new Error("OpenAI Embedding API returned empty data");
		}

		const sorted = data.data.sort((a, b) => a.index - b.index);
		return sorted.map((d) => this.normalize(d.embedding));
	}

	/**
	 * Google/Gemini API key and Vertex AI native embedding APIs.
	 */
	private async embedViaGoogle(
		texts: string[],
		task: EmbeddingTask,
	): Promise<number[][]> {
		const formattedTexts = texts.map((text) =>
			this.formatGoogleText(text, task),
		);
		const embeddings: number[][] = [];

		for (const text of formattedTexts) {
			embeddings.push(
				this.config.authMode === "vertex"
					? await this.embedViaGoogleVertex(text)
					: await this.embedViaGoogleApiKey(text),
			);
		}

		return embeddings;
	}

	private async embedViaGoogleApiKey(text: string): Promise<number[]> {
		this.totalApiCalls++;
		const response = await fetch(
			`${this.googleGenerativeBaseUrl()}/models/${this.config.model}:embedContent`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-goog-api-key": this.config.apiKey,
				},
				body: JSON.stringify({
					content: { parts: [{ text }] },
					output_dimensionality: this.config.dimensions,
				}),
				signal: AbortSignal.timeout(30_000),
			},
		);

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`Google Embedding API error: ${response.status} ${errorText.slice(0, 200)}`,
			);
		}

		const data = (await response.json()) as {
			embedding?: { values?: number[] };
		};
		const values = data.embedding?.values;
		if (!values) throw new Error("Google Embedding API returned empty data");
		return this.normalize(values);
	}

	private async embedViaGoogleVertex(text: string): Promise<number[]> {
		this.totalApiCalls++;
		const response = await fetch(this.googleVertexEndpoint(), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${await this.vertexAccessToken()}`,
			},
			body: JSON.stringify({
				content: { parts: [{ text }] },
				embedContentConfig: {
					outputDimensionality: this.config.dimensions,
				},
			}),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`Google Vertex Embedding API error: ${response.status} ${errorText.slice(0, 200)}`,
			);
		}

		const data = (await response.json()) as {
			embedding?: { values?: number[] };
		};
		const values = data.embedding?.values;
		if (!values)
			throw new Error("Google Vertex Embedding API returned empty data");
		return this.normalize(values);
	}

	/**
	 * Cohere API
	 * POST /v2/embed
	 */
	private async embedViaCohere(texts: string[]): Promise<number[][]> {
		this.totalApiCalls++;

		const response = await fetch(`${this.config.baseUrl}/v2/embed`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify({
				model: this.config.model,
				texts,
				input_type: "search_document",
				embedding_types: ["float"],
			}),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`Cohere Embedding API error: ${response.status} ${errorText.slice(0, 200)}`,
			);
		}

		const data = (await response.json()) as {
			embeddings: { float: number[][] };
		};

		if (!data.embeddings?.float || data.embeddings.float.length === 0) {
			throw new Error("Cohere Embedding API returned empty data");
		}

		return data.embeddings.float.map((e) => this.normalize(e));
	}

	/**
	 * Ollama API (local)
	 * POST /api/embed
	 */
	private async embedViaOllama(texts: string[]): Promise<number[][]> {
		this.totalApiCalls++;

		// Ollama supports batch via /api/embed
		const response = await fetch(`${this.config.baseUrl}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.config.model,
				input: texts,
			}),
			signal: AbortSignal.timeout(60_000), // Ollama can be slower
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`Ollama Embedding API error: ${response.status} ${errorText.slice(0, 200)}`,
			);
		}

		const data = (await response.json()) as {
			embeddings: number[][];
		};

		if (!data.embeddings || data.embeddings.length === 0) {
			throw new Error("Ollama Embedding API returned empty data");
		}

		return data.embeddings.map((e) => this.normalize(e));
	}

	private formatGoogleText(text: string, task: EmbeddingTask): string {
		if (this.config.model !== "gemini-embedding-2") return text;
		switch (task) {
			case "query":
				return `task: search result | query: ${text}`;
			case "document":
				return `title: none | text: ${text}`;
			default:
				return text;
		}
	}

	private googleGenerativeBaseUrl(): string {
		const base = this.trimTrailingSlash(
			this.config.baseUrl || "https://generativelanguage.googleapis.com/v1beta",
		);
		return /\/v\d+(beta)?$/.test(base) ? base : `${base}/v1beta`;
	}

	private googleVertexEndpoint(): string {
		const baseUrl = this.config.baseUrl.trim();
		if (baseUrl) return this.trimTrailingSlash(baseUrl);
		const projectId = this.googleProjectId();
		const location = this.googleLocation();
		const host =
			location === "global"
				? "aiplatform.googleapis.com"
				: `${location}-aiplatform.googleapis.com`;
		return `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${this.config.model}:embedContent`;
	}

	private googleProjectId(): string {
		return (
			this.config.projectId ||
			this.serviceAccountCredentials()?.project_id ||
			process.env.GOOGLE_CLOUD_PROJECT ||
			process.env.GCLOUD_PROJECT ||
			""
		);
	}

	private googleLocation(): string {
		return (
			this.config.location ||
			process.env.GOOGLE_CLOUD_LOCATION ||
			process.env.GOOGLE_CLOUD_REGION ||
			"us-central1"
		);
	}

	private async vertexAccessToken(): Promise<string> {
		const configured =
			this.config.accessToken ||
			(this.config.accessTokenEnv
				? process.env[this.config.accessTokenEnv]
				: "") ||
			process.env.GOOGLE_VERTEX_ACCESS_TOKEN ||
			process.env.GOOGLE_ACCESS_TOKEN ||
			"";
		if (configured.trim()) return configured.trim();
		if (
			this.vertexTokenCache &&
			this.vertexTokenCache.expiresAt > Date.now() + 60_000
		) {
			return this.vertexTokenCache.token;
		}

		const credentials = this.serviceAccountCredentials();
		if (!credentials) {
			throw new Error(
				"Google Vertex embeddings require GOOGLE_VERTEX_ACCESS_TOKEN, GOOGLE_ACCESS_TOKEN, or GOOGLE_APPLICATION_CREDENTIALS",
			);
		}
		if (!credentials.client_email || !credentials.private_key) {
			throw new Error("Google service account credentials are incomplete");
		}

		const now = Math.floor(Date.now() / 1000);
		const assertion = signJwt(
			{ alg: "RS256", typ: "JWT" },
			{
				iss: credentials.client_email,
				scope: "https://www.googleapis.com/auth/cloud-platform",
				aud: credentials.token_uri ?? "https://oauth2.googleapis.com/token",
				exp: now + 3600,
				iat: now,
			},
			credentials.private_key,
		);
		const response = await fetch(
			credentials.token_uri ?? "https://oauth2.googleapis.com/token",
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion,
				}),
			},
		);
		if (!response.ok) {
			throw new Error(
				`Google Vertex token request failed: ${response.status} ${await response.text()}`,
			);
		}
		const token = (await response.json()) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!token.access_token) throw new Error("Google Vertex token missing");
		this.vertexTokenCache = {
			token: token.access_token,
			expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
		};
		return token.access_token;
	}

	private trimTrailingSlash(value: string): string {
		return value.replace(/\/+$/, "");
	}

	private serviceAccountCredentials():
		| {
				client_email?: string;
				private_key?: string;
				project_id?: string;
				token_uri?: string;
		  }
		| undefined {
		const inline = this.config.credentialsJson?.trim();
		if (inline) return JSON.parse(inline);
		const credentialsFile =
			this.config.credentialsFile ||
			process.env.GOOGLE_APPLICATION_CREDENTIALS ||
			"";
		if (!credentialsFile || !existsSync(credentialsFile)) return undefined;
		return JSON.parse(readFileSync(credentialsFile, "utf8"));
	}

	// ==========================================================
	// Hash fallback + utils
	// ==========================================================

	/**
	 * Hash-based bag-of-words embedding — offline fallback.
	 * Better than zeros, but much lower quality than real embeddings.
	 */
	private hashEmbedding(text: string): number[] {
		const dim = this.config.dimensions;
		const vec = new Array(dim).fill(0);
		const cleanText = text.toLowerCase().replace(/[^\w\s]/g, "");
		const words = cleanText.split(/\s+/).filter((w) => w.length > 0);

		if (words.length === 0) return vec;

		// Multi-hash for better distribution
		for (let i = 0; i < words.length; i++) {
			const word = words[i];

			// Primary hash
			let hash1 = 0;
			for (let j = 0; j < word.length; j++) {
				hash1 = (hash1 << 5) - hash1 + word.charCodeAt(j);
				hash1 |= 0;
			}

			// Secondary hash (different seed)
			let hash2 = 5381;
			for (let j = 0; j < word.length; j++) {
				hash2 = (hash2 << 5) + hash2 + word.charCodeAt(j);
				hash2 |= 0;
			}

			// Spread word signal across multiple dims
			const idx1 = Math.abs(hash1) % dim;
			const idx2 = Math.abs(hash2) % dim;
			vec[idx1] += 1;
			vec[idx2] += 0.5;

			// Bigrams for context
			if (i > 0) {
				const bigram = `${words[i - 1]} ${word}`;
				let biHash = 0;
				for (let j = 0; j < bigram.length; j++) {
					biHash = (biHash << 5) - biHash + bigram.charCodeAt(j);
					biHash |= 0;
				}
				vec[Math.abs(biHash) % dim] += 0.3;
			}
		}

		return this.normalize(vec);
	}

	private normalize(vec: number[]): number[] {
		const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
		if (norm === 0) return vec;
		return vec.map((v) => v / norm);
	}

	private hashText(text: string): string {
		return createHash("sha256").update(text).digest("hex").slice(0, 16);
	}

	private cacheSet(key: string, value: number[]): void {
		if (this.cache.size >= this.config.cacheSize) {
			const oldest = this.cacheOrder.shift();
			if (oldest) this.cache.delete(oldest);
		}
		this.cache.set(key, value);
		this.cacheOrder.push(key);
	}
}

function base64url(input: string): string {
	return Buffer.from(input)
		.toString("base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function signJwt(
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
	privateKey: string,
): string {
	const encodedHeader = base64url(JSON.stringify(header));
	const encodedPayload = base64url(JSON.stringify(payload));
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const signer = createSign("RSA-SHA256");
	signer.update(signingInput);
	signer.end();
	const signature = signer
		.sign(privateKey)
		.toString("base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
	return `${signingInput}.${signature}`;
}
