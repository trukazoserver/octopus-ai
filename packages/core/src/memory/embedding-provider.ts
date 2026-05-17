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

import { createHash } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("embedding-provider");

export type EmbeddingApiType = "openai" | "google" | "cohere" | "ollama";

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
	/** Máximo de textos por batch */
	maxBatchSize: number;
	/** Máximo de caracteres por texto antes de truncar */
	maxTextLength: number;
	/** Tamaño del cache LRU */
	cacheSize: number;
}

const DEFAULT_CONFIG: EmbeddingProviderConfig = {
	dimensions: 1024,
	model: "embedding-3",
	apiKey: "",
	baseUrl: "https://api.z.ai/api/paas/v4",
	apiType: "openai",
	maxBatchSize: 32,
	maxTextLength: 8000,
	cacheSize: 500,
};

/** Resultado de un embedding con metadata */
export interface EmbeddingResult {
	embedding: number[];
	model: string;
	cached: boolean;
	tokensUsed: number;
}

export class EmbeddingProvider {
	private config: EmbeddingProviderConfig;
	private cache: Map<string, number[]> = new Map();
	private cacheOrder: string[] = [];
	private apiAvailable: boolean | null = null;
	private totalApiCalls = 0;
	private totalCacheHits = 0;

	constructor(config: Partial<EmbeddingProviderConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Generar embedding para un texto.
	 * Usa cache → API → fallback hash.
	 */
	async embed(text: string): Promise<number[]> {
		if (!text || text.trim().length === 0) {
			return new Array(this.config.dimensions).fill(0);
		}

		const cleanText = text.trim().slice(0, this.config.maxTextLength);
		const cacheKey = this.hashText(cleanText);

		// Check cache
		const cached = this.cache.get(cacheKey);
		if (cached) {
			this.totalCacheHits++;
			return cached;
		}

		// Try API
		if (this.config.apiKey && this.apiAvailable !== false) {
			try {
				const result = await this.embedViaAPI([cleanText]);
				if (result.length > 0) {
					this.apiAvailable = true;
					const embedding = result[0];
					this.cacheSet(cacheKey, embedding);
					return embedding;
				}
			} catch (err) {
				if (this.apiAvailable === null) {
					logger.warn(
						`Embedding API not available, using hash fallback: ${String(err)}`,
					);
					this.apiAvailable = false;
				}
			}
		}

		// Fallback: hash-based bag-of-words
		const fallback = this.hashEmbedding(cleanText);
		this.cacheSet(cacheKey, fallback);
		return fallback;
	}

	/**
	 * Batch embedding — más eficiente para consolidación.
	 */
	async embedBatch(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];

		const results: number[][] = new Array(texts.length);
		const uncachedIndices: number[] = [];
		const uncachedTexts: string[] = [];

		// Check cache first
		for (let i = 0; i < texts.length; i++) {
			const clean = (texts[i] || "").trim().slice(0, this.config.maxTextLength);
			const key = this.hashText(clean);
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
		if (this.config.apiKey && this.apiAvailable !== false) {
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
					const embeddings = await this.embedViaAPI(batchTexts);

					for (let j = 0; j < embeddings.length; j++) {
						const idx = batchIndices[j];
						results[idx] = embeddings[j];
						this.cacheSet(this.hashText(batchTexts[j]), embeddings[j]);
					}
				}
				this.apiAvailable = true;
				return results;
			} catch (err) {
				if (this.apiAvailable === null) {
					logger.warn(
						`Batch embedding API failed, using hash fallback: ${String(err)}`,
					);
					this.apiAvailable = false;
				}
			}
		}

		// Fallback for remaining
		for (const i of uncachedIndices) {
			if (!results[i]) {
				const clean = (texts[i] || "")
					.trim()
					.slice(0, this.config.maxTextLength);
				results[i] = this.hashEmbedding(clean);
				this.cacheSet(this.hashText(clean), results[i]);
			}
		}

		return results;
	}

	/**
	 * Obtener la función de embedding compatible con EmbeddingFunction type.
	 */
	getEmbedFunction(): (text: string) => Promise<number[]> {
		return (text: string) => this.embed(text);
	}

	/**
	 * Estadísticas del provider.
	 */
	getStats(): {
		apiAvailable: boolean;
		totalApiCalls: number;
		totalCacheHits: number;
		cacheSize: number;
		model: string;
		dimensions: number;
		apiType: EmbeddingApiType;
	} {
		return {
			apiAvailable: this.apiAvailable ?? false,
			totalApiCalls: this.totalApiCalls,
			totalCacheHits: this.totalCacheHits,
			cacheSize: this.cache.size,
			model: this.config.model,
			dimensions: this.config.dimensions,
			apiType: this.config.apiType,
		};
	}

	// ==========================================================
	// API Adapters — one per provider type
	// ==========================================================

	private async embedViaAPI(texts: string[]): Promise<number[][]> {
		switch (this.config.apiType) {
			case "google":
				return this.embedViaGoogle(texts);
			case "cohere":
				return this.embedViaCohere(texts);
			case "ollama":
				return this.embedViaOllama(texts);
			default:
				return this.embedViaOpenAI(texts);
		}
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

		const response = await fetch(`${this.config.baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});

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
	 * Google/Gemini API
	 * POST /v1beta/models/{model}:embedContent (single)
	 * POST /v1beta/models/{model}:batchEmbedContents (batch)
	 */
	private async embedViaGoogle(texts: string[]): Promise<number[][]> {
		this.totalApiCalls++;

		if (texts.length === 1) {
			// Single embedding
			const response = await fetch(
				`${this.config.baseUrl}/v1beta/models/${this.config.model}:embedContent?key=${this.config.apiKey}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: `models/${this.config.model}`,
						content: { parts: [{ text: texts[0] }] },
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
				embedding: { values: number[] };
			};

			if (!data.embedding?.values) {
				throw new Error("Google Embedding API returned empty data");
			}

			return [this.normalize(data.embedding.values)];
		}

		// Batch embedding
		const requests = texts.map((text) => ({
			model: `models/${this.config.model}`,
			content: { parts: [{ text }] },
		}));

		const response = await fetch(
			`${this.config.baseUrl}/v1beta/models/${this.config.model}:batchEmbedContents?key=${this.config.apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requests }),
				signal: AbortSignal.timeout(30_000),
			},
		);

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`Google Batch Embedding API error: ${response.status} ${errorText.slice(0, 200)}`,
			);
		}

		const data = (await response.json()) as {
			embeddings: Array<{ values: number[] }>;
		};

		if (!data.embeddings || data.embeddings.length === 0) {
			throw new Error("Google Batch Embedding API returned empty data");
		}

		return data.embeddings.map((e) => this.normalize(e.values));
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
