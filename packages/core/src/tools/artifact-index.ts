import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ArtifactValue =
	| string
	| number
	| boolean
	| null
	| ArtifactValue[]
	| { [key: string]: ArtifactValue };

/** A searchable structural unit, such as a page, slide, paragraph, or cell. */
export interface ArtifactUnit {
	ref: string;
	text: string;
	[key: string]: ArtifactValue;
}

export interface ArtifactIndexOptions {
	cacheDir?: string;
	maxEntries?: number;
	maxUnits?: number;
	maxUnitTextChars?: number;
	maxTotalTextChars?: number;
	maxQueryChars?: number;
	maxQueryTokens?: number;
	maxResults?: number;
	snippetChars?: number;
}

export interface ArtifactIndexStatus {
	artifactRef: string;
	hash: string;
	cacheHit: boolean;
	invalidatedHash?: string;
	unitCount: number;
}

export interface ArtifactIndexSnapshot {
	artifactRef: string;
	hash: string;
	createdAt: string;
	units: ArtifactUnit[];
}

export interface ArtifactSearchOptions {
	limit?: number;
	minScore?: number;
}

export interface ArtifactSearchMatch {
	ref: string;
	score: number;
	snippet: string;
	literalMatch: boolean;
	matchedTokens: string[];
	unit: ArtifactUnit;
}

interface IndexedUnit {
	unit: ArtifactUnit;
	normalizedText: string;
	terms: Record<string, number>;
	length: number;
}

interface StoredIndex {
	version: 1;
	hash: string;
	createdAt: string;
	averageLength: number;
	documentFrequency: Record<string, number>;
	units: IndexedUnit[];
}

interface ArtifactManifest {
	version: 1;
	artifactRef: string;
	hash: string;
	updatedAt: string;
}

const DEFAULT_CACHE_DIR = join(
	homedir(),
	".octopus",
	"cache",
	"artifact-index",
);
const INDEX_VERSION = 1;

const DEFAULTS = {
	maxEntries: 128,
	maxUnits: 10_000,
	maxUnitTextChars: 1_000_000,
	maxTotalTextChars: 20_000_000,
	maxQueryChars: 1_000,
	maxQueryTokens: 32,
	maxResults: 100,
	snippetChars: 240,
} as const;

interface ArtifactIndexLimits {
	maxEntries: number;
	maxUnits: number;
	maxUnitTextChars: number;
	maxTotalTextChars: number;
	maxQueryChars: number;
	maxQueryTokens: number;
	maxResults: number;
	snippetChars: number;
}

/** Stable SHA-256 over the ordered units, including their structured metadata. */
export function hashArtifactUnits(units: readonly ArtifactUnit[]): string {
	return createHash("sha256").update(canonicalJson(units)).digest("hex");
}

/**
 * Persistent, dependency-free index for extracted artifact structures.
 * Content objects are addressed by SHA-256 while per-artifact manifests point
 * at the currently valid hash.
 */
export class ArtifactIndex {
	readonly cacheDir: string;
	private readonly limits: ArtifactIndexLimits;

	constructor(options: ArtifactIndexOptions = {}) {
		this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
		this.limits = {
			maxEntries: positiveInteger(
				options.maxEntries,
				DEFAULTS.maxEntries,
				"maxEntries",
			),
			maxUnits: positiveInteger(
				options.maxUnits,
				DEFAULTS.maxUnits,
				"maxUnits",
			),
			maxUnitTextChars: positiveInteger(
				options.maxUnitTextChars,
				DEFAULTS.maxUnitTextChars,
				"maxUnitTextChars",
			),
			maxTotalTextChars: positiveInteger(
				options.maxTotalTextChars,
				DEFAULTS.maxTotalTextChars,
				"maxTotalTextChars",
			),
			maxQueryChars: positiveInteger(
				options.maxQueryChars,
				DEFAULTS.maxQueryChars,
				"maxQueryChars",
			),
			maxQueryTokens: positiveInteger(
				options.maxQueryTokens,
				DEFAULTS.maxQueryTokens,
				"maxQueryTokens",
			),
			maxResults: positiveInteger(
				options.maxResults,
				DEFAULTS.maxResults,
				"maxResults",
			),
			snippetChars: positiveInteger(
				options.snippetChars,
				DEFAULTS.snippetChars,
				"snippetChars",
			),
		};
	}

	async index(
		artifactRef: string,
		units: readonly ArtifactUnit[],
	): Promise<ArtifactIndexStatus> {
		validateArtifactRef(artifactRef);
		const safeUnits = this.validateAndCloneUnits(units);
		const hash = hashArtifactUnits(safeUnits);
		await this.ensureDirectories();

		const previous = await this.readManifest(artifactRef);
		let stored = await this.readStoredIndex(hash);
		const cacheHit = stored !== undefined;
		if (!stored) {
			stored = buildIndex(hash, safeUnits);
			await atomicWrite(this.objectPath(hash), JSON.stringify(stored));
		}

		const manifest: ArtifactManifest = {
			version: INDEX_VERSION,
			artifactRef,
			hash,
			updatedAt: new Date().toISOString(),
		};
		await atomicWrite(this.manifestPath(artifactRef), JSON.stringify(manifest));

		const invalidatedHash =
			previous?.hash !== hash ? previous?.hash : undefined;
		if (invalidatedHash) await this.removeObjectIfUnreferenced(invalidatedHash);
		await this.prune();
		return {
			artifactRef,
			hash,
			cacheHit,
			invalidatedHash,
			unitCount: stored.units.length,
		};
	}

	async get(artifactRef: string): Promise<ArtifactIndexSnapshot | undefined> {
		validateArtifactRef(artifactRef);
		const manifest = await this.readManifest(artifactRef);
		if (!manifest) return undefined;
		const stored = await this.readStoredIndex(manifest.hash);
		if (!stored) return undefined;
		return {
			artifactRef,
			hash: stored.hash,
			createdAt: stored.createdAt,
			units: stored.units.map(({ unit }) => unit),
		};
	}

	async search(
		artifactRef: string,
		query: string,
		options: ArtifactSearchOptions = {},
	): Promise<ArtifactSearchMatch[]> {
		validateArtifactRef(artifactRef);
		if (query.length > this.limits.maxQueryChars) {
			throw new RangeError(
				`query exceeds ${this.limits.maxQueryChars} characters`,
			);
		}
		const normalizedQuery = normalizeText(query);
		if (!normalizedQuery) return [];

		const manifest = await this.readManifest(artifactRef);
		if (!manifest) return [];
		const stored = await this.readStoredIndex(manifest.hash);
		if (!stored) return [];

		const baseTokens = basicTokens(query).slice(0, this.limits.maxQueryTokens);
		const queryTerms = [...new Set(baseTokens.flatMap(expandToken))];
		const limit = Math.min(
			Math.max(0, Math.floor(options.limit ?? 20)),
			this.limits.maxResults,
		);
		if (limit === 0) return [];
		const minimum = Number.isFinite(options.minScore)
			? (options.minScore ?? 0)
			: 0;

		return stored.units
			.map((indexed) =>
				scoreUnit(
					indexed,
					stored,
					normalizedQuery,
					baseTokens,
					queryTerms,
					this.limits.snippetChars,
				),
			)
			.filter(
				(match): match is ArtifactSearchMatch =>
					match !== undefined && match.score >= minimum,
			)
			.sort(
				(left, right) =>
					right.score - left.score || left.ref.localeCompare(right.ref),
			)
			.slice(0, limit);
	}

	/** Remove an artifact only if its current hash matches `expectedHash`, when supplied. */
	async invalidate(
		artifactRef: string,
		expectedHash?: string,
	): Promise<boolean> {
		validateArtifactRef(artifactRef);
		const manifest = await this.readManifest(artifactRef);
		if (
			!manifest ||
			(expectedHash !== undefined && manifest.hash !== expectedHash)
		)
			return false;
		await rm(this.manifestPath(artifactRef), { force: true });
		await this.removeObjectIfUnreferenced(manifest.hash);
		return true;
	}

	private validateAndCloneUnits(
		units: readonly ArtifactUnit[],
	): ArtifactUnit[] {
		if (!Array.isArray(units)) throw new TypeError("units must be an array");
		if (units.length > this.limits.maxUnits) {
			throw new RangeError(
				`units exceeds the limit of ${this.limits.maxUnits}`,
			);
		}
		let totalTextChars = 0;
		const refs = new Set<string>();
		for (const unit of units) {
			if (!unit || typeof unit !== "object")
				throw new TypeError("each unit must be an object");
			if (typeof unit.ref !== "string" || unit.ref.length === 0) {
				throw new TypeError("each unit requires a non-empty ref");
			}
			if (refs.has(unit.ref))
				throw new TypeError(`duplicate unit ref: ${unit.ref}`);
			refs.add(unit.ref);
			if (typeof unit.text !== "string")
				throw new TypeError(`unit ${unit.ref} requires text`);
			if (unit.text.length > this.limits.maxUnitTextChars) {
				throw new RangeError(
					`unit ${unit.ref} exceeds ${this.limits.maxUnitTextChars} text characters`,
				);
			}
			totalTextChars += unit.text.length;
			if (totalTextChars > this.limits.maxTotalTextChars) {
				throw new RangeError(
					`unit text exceeds ${this.limits.maxTotalTextChars} total characters`,
				);
			}
		}
		return JSON.parse(canonicalJson(units)) as ArtifactUnit[];
	}

	private objectPath(hash: string): string {
		return join(this.cacheDir, "objects", `${hash}.json`);
	}

	private manifestPath(artifactRef: string): string {
		const key = createHash("sha256").update(artifactRef).digest("hex");
		return join(this.cacheDir, "refs", `${key}.json`);
	}

	private async ensureDirectories(): Promise<void> {
		await Promise.all([
			mkdir(join(this.cacheDir, "objects"), { recursive: true }),
			mkdir(join(this.cacheDir, "refs"), { recursive: true }),
		]);
	}

	private async readManifest(
		artifactRef: string,
	): Promise<ArtifactManifest | undefined> {
		const parsed = await readJson(this.manifestPath(artifactRef));
		if (!isRecord(parsed)) return undefined;
		if (
			parsed.version !== INDEX_VERSION ||
			parsed.artifactRef !== artifactRef ||
			typeof parsed.hash !== "string" ||
			typeof parsed.updatedAt !== "string"
		) {
			return undefined;
		}
		return parsed as unknown as ArtifactManifest;
	}

	private async readStoredIndex(
		hash: string,
	): Promise<StoredIndex | undefined> {
		const parsed = await readJson(this.objectPath(hash));
		if (!isStoredIndex(parsed, hash)) return undefined;
		return parsed;
	}

	private async removeObjectIfUnreferenced(hash: string): Promise<void> {
		const manifests = await this.readAllManifests();
		if (!manifests.some((manifest) => manifest.hash === hash)) {
			await rm(this.objectPath(hash), { force: true });
		}
	}

	private async readAllManifests(): Promise<ArtifactManifest[]> {
		const files = await readdir(join(this.cacheDir, "refs")).catch(
			() => [] as string[],
		);
		const values = await Promise.all(
			files
				.filter((file) => file.endsWith(".json"))
				.map(async (file) => readJson(join(this.cacheDir, "refs", file))),
		);
		return values.filter((value): value is ArtifactManifest => {
			return (
				isRecord(value) &&
				value.version === INDEX_VERSION &&
				typeof value.artifactRef === "string" &&
				typeof value.hash === "string" &&
				typeof value.updatedAt === "string"
			);
		});
	}

	private async prune(): Promise<void> {
		const refsDir = join(this.cacheDir, "refs");
		const files = (await readdir(refsDir).catch(() => [] as string[])).filter(
			(file) => file.endsWith(".json"),
		);
		if (files.length <= this.limits.maxEntries) return;
		const dated = await Promise.all(
			files.map(async (file) => ({
				file,
				mtimeMs: (await stat(join(refsDir, file))).mtimeMs,
			})),
		);
		dated.sort((left, right) => right.mtimeMs - left.mtimeMs);
		for (const { file } of dated.slice(this.limits.maxEntries)) {
			await rm(join(refsDir, file), { force: true });
		}
		const referenced = new Set(
			(await this.readAllManifests()).map((manifest) => manifest.hash),
		);
		const objectsDir = join(this.cacheDir, "objects");
		const objects = await readdir(objectsDir).catch(() => [] as string[]);
		await Promise.all(
			objects
				.filter(
					(file) =>
						file.endsWith(".json") && !referenced.has(file.slice(0, -5)),
				)
				.map((file) => rm(join(objectsDir, file), { force: true })),
		);
	}
}

function buildIndex(hash: string, units: ArtifactUnit[]): StoredIndex {
	const documentFrequency: Record<string, number> = {};
	let totalLength = 0;
	const indexedUnits = units.map((unit) => {
		const searchText = searchableText(unit);
		const normalizedText = normalizeText(searchText);
		const tokens = basicTokens(searchText).flatMap(expandToken);
		const terms: Record<string, number> = {};
		for (const token of tokens) terms[token] = (terms[token] ?? 0) + 1;
		for (const token of Object.keys(terms)) {
			documentFrequency[token] = (documentFrequency[token] ?? 0) + 1;
		}
		totalLength += tokens.length;
		return { unit, normalizedText, terms, length: tokens.length };
	});
	return {
		version: INDEX_VERSION,
		hash,
		createdAt: new Date().toISOString(),
		averageLength:
			indexedUnits.length === 0 ? 0 : totalLength / indexedUnits.length,
		documentFrequency,
		units: indexedUnits,
	};
}

function scoreUnit(
	indexed: IndexedUnit,
	stored: StoredIndex,
	normalizedQuery: string,
	baseTokens: string[],
	queryTerms: string[],
	snippetChars: number,
): ArtifactSearchMatch | undefined {
	const documentCount = stored.units.length;
	const averageLength = Math.max(1, stored.averageLength);
	let bm25 = 0;
	const matchedTerms: string[] = [];
	for (const term of queryTerms) {
		const frequency = indexed.terms[term] ?? 0;
		if (frequency === 0) continue;
		matchedTerms.push(term);
		const documentsWithTerm = stored.documentFrequency[term] ?? 0;
		const idf = Math.log(
			1 + (documentCount - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5),
		);
		const denominator =
			frequency + 1.2 * (0.25 + 0.75 * (indexed.length / averageLength));
		bm25 += idf * ((frequency * 2.2) / denominator);
	}

	const literalCount = countOccurrences(
		indexed.normalizedText,
		normalizedQuery,
	);
	const literalMatch = literalCount > 0;
	const matchedBase = baseTokens.filter((token) =>
		expandToken(token).some((term) => (indexed.terms[term] ?? 0) > 0),
	);
	const coverage =
		baseTokens.length === 0
			? 0
			: new Set(matchedBase).size / new Set(baseTokens).size;
	const refMatch = normalizeText(indexed.unit.ref).includes(normalizedQuery);
	const score =
		bm25 + coverage * 2 + Math.min(literalCount, 4) * 6 + (refMatch ? 2 : 0);
	if (score <= 0) return undefined;
	return {
		ref: indexed.unit.ref,
		score: Number(score.toFixed(6)),
		snippet: makeSnippet(
			indexed.unit.text,
			normalizedQuery,
			baseTokens,
			snippetChars,
		),
		literalMatch,
		matchedTokens: [...new Set(matchedTerms)],
		unit: indexed.unit,
	};
}

function basicTokens(value: string): string[] {
	return normalizeText(value).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

function expandToken(token: string): string[] {
	const variants = new Set([token]);
	if (token.length > 4 && token.endsWith("s")) variants.add(token.slice(0, -1));
	if (token.length > 5 && token.endsWith("es"))
		variants.add(token.slice(0, -2));
	if (token.length > 6 && token.endsWith("ies"))
		variants.add(`${token.slice(0, -3)}y`);
	for (const suffix of ["mente", "tion", "ciones", "ing", "ed"] as const) {
		if (token.length > suffix.length + 3 && token.endsWith(suffix)) {
			variants.add(token.slice(0, -suffix.length));
		}
	}
	return [...variants];
}

function normalizeText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLocaleLowerCase("und")
		.replace(/\s+/g, " ")
		.trim();
}

function searchableText(unit: ArtifactUnit): string {
	const metadata: string[] = [];
	for (const [key, value] of Object.entries(unit)) {
		if (key !== "ref" && key !== "text") collectScalarText(value, metadata);
	}
	return [unit.ref, unit.text, ...metadata].join("\n");
}

function collectScalarText(value: ArtifactValue, output: string[]): void {
	if (typeof value === "string" || typeof value === "number")
		output.push(String(value));
	else if (Array.isArray(value))
		for (const item of value) collectScalarText(item, output);
	else if (value && typeof value === "object") {
		for (const nested of Object.values(value))
			collectScalarText(nested, output);
	}
}

function makeSnippet(
	text: string,
	query: string,
	tokens: string[],
	limit: number,
): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	const normalized = normalizeText(compact);
	let matchAt = normalized.indexOf(query);
	if (matchAt < 0) {
		matchAt =
			tokens
				.map((token) => normalized.indexOf(token))
				.find((position) => position >= 0) ?? 0;
	}
	const start = Math.max(
		0,
		Math.min(compact.length - limit, matchAt - Math.floor(limit / 3)),
	);
	let snippet = compact.slice(start, start + limit);
	if (start > 0) snippet = `...${snippet.slice(3)}`;
	if (start + limit < compact.length) snippet = `${snippet.slice(0, -3)}...`;
	return snippet;
}

function countOccurrences(text: string, query: string): number {
	let count = 0;
	let from = 0;
	let position = query ? text.indexOf(query, from) : -1;
	while (position >= 0) {
		count += 1;
		from = position + query.length;
		position = text.indexOf(query, from);
	}
	return count;
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new TypeError("artifact values must contain finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new TypeError("artifact values must be JSON-compatible");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(contents, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function isStoredIndex(
	value: unknown,
	expectedHash: string,
): value is StoredIndex {
	if (!isRecord(value)) return false;
	return (
		value.version === INDEX_VERSION &&
		value.hash === expectedHash &&
		typeof value.createdAt === "string" &&
		typeof value.averageLength === "number" &&
		isRecord(value.documentFrequency) &&
		Array.isArray(value.units)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateArtifactRef(value: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("artifactRef must be a non-empty string");
	}
}

function positiveInteger(
	value: number | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new RangeError(`${name} must be a positive integer`);
	return value;
}
