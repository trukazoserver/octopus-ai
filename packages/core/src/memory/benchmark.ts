import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";

export type MemoryBenchmarkFormat = "memops" | "longmemeval" | "beam";
export type MemoryBenchmarkCondition =
	| "no-memory"
	| "lexical-baseline"
	| "octopus-isolated";

export interface MemoryBenchmarkHit {
	id: string;
	score: number;
}

export interface MemoryBenchmarkIsolatedRuntime {
	metadata?: Record<string, unknown>;
	retrieve(query: string, k: number): Promise<MemoryBenchmarkHit[]>;
	close(): Promise<void>;
}

export type MemoryBenchmarkRuntimeFactory = (input: {
	runId: string;
	datasetId: string;
	corpusId: string;
	documents: Array<{
		id: string;
		externalId: string;
		ordinal: number;
		role?: string;
		content: string;
		occurredAt?: string;
	}>;
}) => Promise<MemoryBenchmarkIsolatedRuntime>;

export interface MemoryBenchmarkDocument {
	corpusId: string;
	externalId: string;
	ordinal: number;
	role?: string;
	content: string;
	occurredAt?: string;
	metadata: Record<string, unknown>;
}

export interface MemoryBenchmarkCase {
	corpusId: string;
	externalId: string;
	category: string;
	query: string;
	expectedDocumentIds: string[];
	forbiddenDocumentIds: string[];
	expectedAnswer?: string;
	rubric?: unknown;
	k?: number;
	metadata: Record<string, unknown>;
}

export interface NormalizedMemoryBenchmark {
	documents: MemoryBenchmarkDocument[];
	cases: MemoryBenchmarkCase[];
	metadata: Record<string, unknown>;
}

export interface MemoryBenchmarkCaseMetrics {
	recallAtK: number | null;
	precisionAtK: number | null;
	hitAtK: number | null;
	recallAllAtK: number | null;
	reciprocalRank: number | null;
	ndcgAtK: number | null;
	forbiddenCaseHit: number | null;
	forbiddenItemRate: number | null;
	abstentionSuccess: number | null;
}

export function scoreMemoryBenchmarkCase(
	expectedIds: string[],
	forbiddenIds: string[],
	retrievedIds: string[],
	k = 10,
): MemoryBenchmarkCaseMetrics {
	const retrieved = [...new Set(retrievedIds)].slice(0, Math.max(1, k));
	const expected = new Set(expectedIds);
	const forbidden = new Set(forbiddenIds);
	const relevant = retrieved.filter((id) => expected.has(id)).length;
	const forbiddenHits = retrieved.filter((id) => forbidden.has(id)).length;
	if (expected.size === 0) {
		return {
			recallAtK: null,
			precisionAtK: null,
			hitAtK: null,
			recallAllAtK: null,
			reciprocalRank: null,
			ndcgAtK: null,
			forbiddenCaseHit: forbidden.size > 0 ? Number(forbiddenHits > 0) : null,
			forbiddenItemRate:
				forbidden.size > 0 && retrieved.length > 0 ? forbiddenHits / retrieved.length : null,
			abstentionSuccess: Number(retrieved.length === 0),
		};
	}
	const firstRelevant = retrieved.findIndex((id) => expected.has(id));
	const dcg = retrieved.reduce(
		(sum, id, index) => sum + (expected.has(id) ? 1 / Math.log2(index + 2) : 0),
		0,
	);
	const idealCount = Math.min(expected.size, retrieved.length || k);
	let idealDcg = 0;
	for (let index = 0; index < idealCount; index++) idealDcg += 1 / Math.log2(index + 2);
	return {
		recallAtK: relevant / expected.size,
		precisionAtK: retrieved.length > 0 ? relevant / retrieved.length : 0,
		hitAtK: Number(relevant > 0),
		recallAllAtK: Number(relevant === expected.size),
		reciprocalRank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
		ndcgAtK: idealDcg > 0 ? dcg / idealDcg : 0,
		forbiddenCaseHit: forbidden.size > 0 ? Number(forbiddenHits > 0) : null,
		forbiddenItemRate:
			forbidden.size > 0 && retrieved.length > 0 ? forbiddenHits / retrieved.length : null,
		abstentionSuccess: null,
	};
}

export function normalizeMemoryBenchmarkSource(
	format: MemoryBenchmarkFormat,
	source: unknown,
): NormalizedMemoryBenchmark {
	if (format === "longmemeval") return normalizeLongMemEval(source);
	if (format === "memops") return normalizeMemOps(source);
	return normalizeBeam(source);
}

export class MemoryBenchmarkStore {
	constructor(private readonly db: DatabaseAdapter) {}

	async importDataset(input: {
		name: string;
		format: MemoryBenchmarkFormat;
		sourceName: string;
		sourceSha256: string;
		source: unknown;
		options?: Record<string, unknown>;
	}): Promise<{ id: string; documentCount: number; caseCount: number }> {
		const normalized = normalizeMemoryBenchmarkSource(input.format, input.source);
		const id = nanoid();
		const now = (await this.db.currentTime()).toISOString();
		await this.db.transaction(async () => {
			await this.db.run(
				"INSERT INTO memory_benchmark_datasets (id, name, format, status, source_name, source_sha256, options, metadata, document_count, case_count, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)",
				[id, input.name, input.format, input.sourceName, input.sourceSha256, JSON.stringify(input.options ?? {}), JSON.stringify(normalized.metadata), normalized.documents.length, normalized.cases.length, now, now],
			);
			const documentIds = new Map<string, string>();
			for (const document of normalized.documents) {
				const documentId = nanoid();
				documentIds.set(`${document.corpusId}\0${document.externalId}`, documentId);
				await this.db.run(
					"INSERT INTO memory_benchmark_documents (id, dataset_id, corpus_id, external_id, ordinal, role, content, occurred_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[documentId, id, document.corpusId, document.externalId, document.ordinal, document.role ?? null, document.content, document.occurredAt ?? null, JSON.stringify(document.metadata)],
				);
			}
			for (const testCase of normalized.cases) {
				const resolve = (externalId: string) => {
					const resolved = documentIds.get(`${testCase.corpusId}\0${externalId}`);
					if (!resolved) {
						throw new Error(
							`MEMORY_BENCHMARK_DOCUMENT_ID_UNRESOLVED:${testCase.corpusId}:${externalId}`,
						);
					}
					return resolved;
				};
				await this.db.run(
					"INSERT INTO memory_benchmark_cases (id, dataset_id, corpus_id, external_id, category, query, expected_document_ids, forbidden_document_ids, expected_answer, rubric, k, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[nanoid(), id, testCase.corpusId, testCase.externalId, testCase.category, testCase.query, JSON.stringify(testCase.expectedDocumentIds.map(resolve)), JSON.stringify(testCase.forbiddenDocumentIds.map(resolve)), testCase.expectedAnswer ?? null, testCase.rubric === undefined ? null : JSON.stringify(testCase.rubric), testCase.k ?? null, JSON.stringify(testCase.metadata)],
				);
			}
		});
		return { id, documentCount: normalized.documents.length, caseCount: normalized.cases.length };
	}

	async listDatasets(): Promise<Array<Record<string, unknown>>> {
		return this.db.all("SELECT id, name, format, status, source_name, source_sha256, metadata, document_count, case_count, last_error, created_at, updated_at FROM memory_benchmark_datasets ORDER BY created_at DESC");
	}

	async createRun(datasetId: string, options: Record<string, unknown> = {}): Promise<string> {
		const dataset = await this.db.get("SELECT id FROM memory_benchmark_datasets WHERE id = ?", [datasetId]);
		if (!dataset) throw new Error("MEMORY_BENCHMARK_DATASET_NOT_FOUND");
		const id = nanoid();
		const now = (await this.db.currentTime()).toISOString();
		await this.db.run("INSERT INTO memory_benchmark_runs (id, dataset_id, status, options, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)", [id, datasetId, JSON.stringify(options), now, now]);
		return id;
	}

	async listRuns(): Promise<Array<Record<string, unknown>>> {
		return this.db.all("SELECT id, dataset_id, status, options, progress, metrics, last_error, created_at, updated_at, completed_at FROM memory_benchmark_runs ORDER BY created_at DESC");
	}

	async executeRun(
		runId: string,
		deps: { createIsolatedRuntime?: MemoryBenchmarkRuntimeFactory } = {},
	): Promise<Record<string, unknown>> {
		const run = await this.db.get<{ dataset_id: string; options: string }>(
			"SELECT dataset_id, options FROM memory_benchmark_runs WHERE id = ?",
			[runId],
		);
		if (!run) throw new Error("MEMORY_BENCHMARK_RUN_NOT_FOUND");
		const options = JSON.parse(run.options) as {
			k?: number;
			condition?: MemoryBenchmarkCondition;
		};
		const k = Math.max(1, Math.min(options.k ?? 10, 100));
		const condition: MemoryBenchmarkCondition =
			options.condition === "no-memory" || options.condition === "octopus-isolated"
				? options.condition
				: "lexical-baseline";
		if (condition === "octopus-isolated" && !deps.createIsolatedRuntime) {
			throw new Error("MEMORY_BENCHMARK_ISOLATED_RUNTIME_UNAVAILABLE");
		}
		const now = (await this.db.currentTime()).toISOString();
		await this.db.run("UPDATE memory_benchmark_runs SET status = 'running', updated_at = ? WHERE id = ?", [now, runId]);
		const cases = await this.db.all<{ id: string; corpus_id: string; category: string; query: string; expected_document_ids: string; forbidden_document_ids: string; k: number | null }>("SELECT id, corpus_id, category, query, expected_document_ids, forbidden_document_ids, k FROM memory_benchmark_cases WHERE dataset_id = ? AND status = 'ready' ORDER BY id", [run.dataset_id]);
		const metricRows: MemoryBenchmarkCaseMetrics[] = [];
		const metricsByCategory = new Map<string, MemoryBenchmarkCaseMetrics[]>();
		const runtimes = new Map<string, MemoryBenchmarkIsolatedRuntime>();
		let failedCases = 0;
		try {
		for (const [index, testCase] of cases.entries()) {
			const startedAt = performance.now();
			const documents = await this.db.all<{ id: string; external_id: string; ordinal: number; role: string | null; content: string; occurred_at: string | null }>("SELECT id, external_id, ordinal, role, content, occurred_at FROM memory_benchmark_documents WHERE dataset_id = ? AND corpus_id = ? ORDER BY ordinal", [run.dataset_id, testCase.corpus_id]);
			let retrieved: MemoryBenchmarkHit[];
			if (condition === "no-memory") retrieved = [];
			else if (condition === "lexical-baseline") {
				retrieved = rankLexically(testCase.query, documents).slice(0, testCase.k ?? k);
			} else {
				let runtime = runtimes.get(testCase.corpus_id);
				if (!runtime) {
					runtime = await deps.createIsolatedRuntime?.({
						runId,
						datasetId: run.dataset_id,
						corpusId: testCase.corpus_id,
						documents: documents.map((document) => ({
							id: document.id,
							externalId: document.external_id,
							ordinal: document.ordinal,
							role: document.role ?? undefined,
							content: document.content,
							occurredAt: document.occurred_at ?? undefined,
						})),
					});
					if (!runtime) throw new Error("MEMORY_BENCHMARK_ISOLATED_RUNTIME_UNAVAILABLE");
					runtimes.set(testCase.corpus_id, runtime);
				}
				try {
					retrieved = await runtime.retrieve(testCase.query, testCase.k ?? k);
				} catch (error) {
					failedCases++;
					await this.db.run(
						"INSERT INTO memory_benchmark_case_results (run_id, case_id, status, error, latency_ms, created_at) VALUES (?, ?, 'failed', ?, ?, ?) ON CONFLICT(run_id, case_id) DO UPDATE SET status = excluded.status, error = excluded.error, latency_ms = excluded.latency_ms",
						[runId, testCase.id, error instanceof Error ? error.message.slice(0, 2000) : String(error), performance.now() - startedAt, now],
					);
					continue;
				}
			}
			const metrics = scoreMemoryBenchmarkCase(JSON.parse(testCase.expected_document_ids), JSON.parse(testCase.forbidden_document_ids), retrieved.map((hit) => hit.id), testCase.k ?? k);
			metricRows.push(metrics);
			const categoryRows = metricsByCategory.get(testCase.category) ?? [];
			categoryRows.push(metrics);
			metricsByCategory.set(testCase.category, categoryRows);
			await this.db.run("INSERT INTO memory_benchmark_case_results (run_id, case_id, status, retrieved_document_ids, scores, metrics, latency_ms, created_at) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?) ON CONFLICT(run_id, case_id) DO UPDATE SET status = excluded.status, retrieved_document_ids = excluded.retrieved_document_ids, scores = excluded.scores, metrics = excluded.metrics, latency_ms = excluded.latency_ms", [runId, testCase.id, JSON.stringify(retrieved.map((hit) => hit.id)), JSON.stringify(retrieved.map((hit) => hit.score)), JSON.stringify(metrics), performance.now() - startedAt, now]);
			await this.db.run("UPDATE memory_benchmark_runs SET progress = ?, updated_at = ? WHERE id = ?", [JSON.stringify({ completed: index + 1, total: cases.length }), now, runId]);
		}
		const metrics: Record<string, unknown> = {
			...aggregateMetrics(metricRows),
			condition,
			failedCases,
			runtimeMetadata: Object.fromEntries(
				[...runtimes.entries()].map(([corpusId, runtime]) => [
					corpusId,
					runtime.metadata ?? {},
				]),
			),
			categories: Object.fromEntries(
				[...metricsByCategory.entries()].map(([category, rows]) => [
					category,
					aggregateMetrics(rows),
				]),
			),
		};
		const completedAt = (await this.db.currentTime()).toISOString();
		await this.db.run("UPDATE memory_benchmark_runs SET status = 'completed', metrics = ?, progress = ?, updated_at = ?, completed_at = ? WHERE id = ?", [JSON.stringify(metrics), JSON.stringify({ completed: cases.length, total: cases.length }), completedAt, completedAt, runId]);
		return metrics;
		} catch (error) {
			const failedAt = (await this.db.currentTime()).toISOString();
			await this.db.run("UPDATE memory_benchmark_runs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [error instanceof Error ? error.message.slice(0, 2000) : String(error), failedAt, runId]);
			throw error;
		} finally {
			await Promise.all([...runtimes.values()].map((runtime) => runtime.close().catch(() => {})));
		}
	}
}

function rankLexically(query: string, documents: Array<{ id: string; content: string }>): Array<{ id: string; score: number }> {
	const queryTokens = new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
	return documents
		.map((document) => {
			const tokens = new Set(document.content.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
			let overlap = 0;
			for (const token of queryTokens) if (tokens.has(token)) overlap++;
			return { id: document.id, score: queryTokens.size > 0 ? overlap / queryTokens.size : 0 };
		})
		.filter((hit) => hit.score > 0)
		.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function aggregateMetrics(rows: MemoryBenchmarkCaseMetrics[]): Record<string, number> {
	const average = (key: keyof MemoryBenchmarkCaseMetrics) => {
		const values = rows.map((row) => row[key]).filter((value): value is number => typeof value === "number");
		return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
	};
	return {
		cases: rows.length,
		recallAtK: average("recallAtK"),
		precisionAtK: average("precisionAtK"),
		hitAtK: average("hitAtK"),
		recallAllAtK: average("recallAllAtK"),
		mrr: average("reciprocalRank"),
		ndcgAtK: average("ndcgAtK"),
		forbiddenCaseRate: average("forbiddenCaseHit"),
		abstentionSuccessRate: average("abstentionSuccess"),
	};
}

function normalizeLongMemEval(source: unknown): NormalizedMemoryBenchmark {
	const rows = requireArray(source, "LongMemEval must be a JSON array");
	const documents: MemoryBenchmarkDocument[] = [];
	const cases: MemoryBenchmarkCase[] = [];
	for (const [index, raw] of rows.entries()) {
		const row = record(raw);
		const corpusId = stringValue(row.question_id) ?? `longmemeval-${index}`;
		const sessions = requireArray(row.haystack_sessions ?? [], "haystack_sessions must be an array");
		const sessionIds = requireArray(row.haystack_session_ids ?? [], "haystack_session_ids must be an array");
		if (sessions.length !== sessionIds.length) throw new Error(`LongMemEval parallel arrays differ for ${corpusId}`);
		for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
			const externalId = String(sessionIds[sessionIndex]);
			const turns = requireArray(sessions[sessionIndex], "LongMemEval session must be an array");
			documents.push({ corpusId, externalId, ordinal: sessionIndex, content: turns.map((turn) => { const value = record(turn); return `${stringValue(value.role) ?? "unknown"}: ${stringValue(value.content) ?? ""}`; }).join("\n"), metadata: {} });
		}
		cases.push({ corpusId, externalId: corpusId, category: stringValue(row.question_type) ?? "unknown", query: stringValue(row.question) ?? "", expectedDocumentIds: requireArray(row.answer_session_ids ?? [], "answer_session_ids must be an array").map(String), forbiddenDocumentIds: [], expectedAnswer: stringValue(row.answer), metadata: { questionDate: row.question_date } });
	}
	return { documents, cases, metadata: { format: "longmemeval" } };
}

function normalizeMemOps(source: unknown): NormalizedMemoryBenchmark {
	const scenarios = Array.isArray(source) ? source : [source];
	const documents: MemoryBenchmarkDocument[] = [];
	const cases: MemoryBenchmarkCase[] = [];
	for (const [scenarioIndex, raw] of scenarios.entries()) {
		const scenario = record(raw);
		const corpusId = stringValue(scenario.target_fact) ?? `memops-${scenarioIndex}`;
		for (const segmentRaw of requireArray(scenario.conversations ?? [], "conversations must be an array")) {
			const segment = record(segmentRaw);
			const segmentIndex = Number(segment.segment_index ?? documents.length);
			for (const [turnIndex, turnRaw] of requireArray(segment.dialogue ?? [], "dialogue must be an array").entries()) {
				const turn = record(turnRaw);
				documents.push({ corpusId, externalId: `${segmentIndex}:${turnIndex}`, ordinal: documents.length, role: stringValue(turn.role), content: stringValue(turn.content) ?? "", metadata: { segmentIndex, turnIndex } });
			}
		}
		for (const [answerIndex, answerRaw] of requireArray(scenario.answer ?? [], "answer must be an array").entries()) {
			const answer = record(answerRaw);
			const provenance = flattenProvenance(answer.gold_provenance).map((value) => provenanceId(value)).filter((value): value is string => Boolean(value));
			cases.push({ corpusId, externalId: stringValue(answer.question_pair_id) ?? `${corpusId}:${answerIndex}`, category: stringValue(answer.evaluation_category) ?? stringValue(answer.evaluation_type) ?? "unknown", query: stringValue(answer.question) ?? "", expectedDocumentIds: provenance, forbiddenDocumentIds: [], expectedAnswer: stringValue(answer.expected_answer), rubric: answer.judge_rubric, metadata: { setting: answer.evaluation_setting, goldMemoryState: answer.gold_memory_state } });
		}
	}
	return { documents, cases, metadata: { format: "memops" } };
}

function normalizeBeam(source: unknown): NormalizedMemoryBenchmark {
	const root = record(source);
	if (typeof root.probing_questions === "string") throw new Error("BEAM Python repr is unsupported; provide parsed chat and probingQuestions JSON");
	const documents: MemoryBenchmarkDocument[] = [];
	for (const batchRaw of flattenRecords(root.chat ?? [])) {
		const batch = record(batchRaw);
		for (const turnGroup of flattenRecords(batch.turns ?? [])) {
			const message = record(turnGroup);
			const externalId = stringValue(message.id) ?? `beam-doc-${documents.length}`;
			documents.push({ corpusId: "beam", externalId, ordinal: documents.length, role: stringValue(message.role), content: stringValue(message.content) ?? "", occurredAt: stringValue(message.time_anchor), metadata: { batchNumber: batch.batch_number } });
		}
	}
	const cases: MemoryBenchmarkCase[] = [];
	const questions = record(root.probingQuestions ?? root.probing_questions ?? {});
	for (const [category, values] of Object.entries(questions)) {
		for (const [index, raw] of flattenRecords(values).entries()) {
			const question = record(raw);
			cases.push({ corpusId: "beam", externalId: stringValue(question.id) ?? `${category}-${index}`, category, query: stringValue(question.question) ?? stringValue(question.prompt) ?? "", expectedDocumentIds: flattenValues(question.source_chat_ids).map(String), forbiddenDocumentIds: [], expectedAnswer: stringValue(question.answer) ?? stringValue(question.ideal_answer) ?? stringValue(question.ideal_response) ?? stringValue(question.ideal_summary) ?? stringValue(question.expected_compliance), rubric: question.rubric, metadata: {} });
		}
	}
	return { documents, cases, metadata: { format: "beam" } };
}

function provenanceId(value: unknown): string | undefined {
	if (typeof value === "string" || typeof value === "number") return String(value);
	const item = record(value);
	const segment = item.segment_index;
	const turn = item.turn_index;
	return segment !== undefined && turn !== undefined ? `${String(segment)}:${String(turn)}` : stringValue(item.id);
}

function flattenProvenance(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(flattenProvenance);
	if (!value || typeof value !== "object") return value == null ? [] : [value];
	const item = value as Record<string, unknown>;
	if ("segment_index" in item || "turn_index" in item || "id" in item) return [item];
	return Object.values(item).flatMap(flattenProvenance);
}

function flattenValues(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(flattenValues);
	if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(flattenValues);
	return value === undefined || value === null ? [] : [value];
}

function flattenRecords(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(flattenRecords);
	if (!value || typeof value !== "object") return [];
	const item = value as Record<string, unknown>;
	if (
		"content" in item ||
		"question" in item ||
		"prompt" in item ||
		"turns" in item ||
		"batch_number" in item
	) {
		return [item];
	}
	return Object.values(item).flatMap(flattenRecords);
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireArray(value: unknown, message: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(message);
	return value;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
