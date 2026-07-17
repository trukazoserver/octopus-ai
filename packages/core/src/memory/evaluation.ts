export interface MemoryEvaluationCase {
	id: string;
	query: string;
	expectedIds: string[];
	forbiddenIds?: string[];
	k?: number;
}

export interface MemoryEvaluationCondition {
	name: string;
	retrieve: (testCase: MemoryEvaluationCase) => Promise<string[]>;
}

export interface MemoryEvaluationResult {
	name: string;
	cases: number;
	recall: number;
	precision: number;
	staleRetrievalRate: number;
	hitRate: number;
	mrr: number;
	forbiddenRetrievalRate: number;
	recallAllRate: number;
	ndcg: number;
	abstentionSuccessRate: number;
	averageLatencyMs: number;
	errors: number;
	caseResults: Array<{
		caseId: string;
		retrievedIds: string[];
		recall: number;
		precision: number;
		stale: boolean;
		hit: boolean;
		reciprocalRank: number;
		recallAll: boolean;
		ndcg: number;
		abstentionSuccess: boolean | null;
		latencyMs: number;
		error?: string;
	}>;
}

export async function evaluateMemoryConditions(
	testCases: MemoryEvaluationCase[],
	conditions: MemoryEvaluationCondition[],
): Promise<MemoryEvaluationResult[]> {
	return Promise.all(
		conditions.map(async (condition) => {
			const caseResults: MemoryEvaluationResult["caseResults"] = [];
			for (const testCase of testCases) {
				const startedAt = performance.now();
				let rawRetrievedIds: string[] = [];
				let error: string | undefined;
				try {
					rawRetrievedIds = await condition.retrieve(testCase);
				} catch (cause) {
					error = cause instanceof Error ? cause.message : String(cause);
				}
				const retrievedIds = [...new Set(rawRetrievedIds)].slice(
					0,
					testCase.k ?? Number.POSITIVE_INFINITY,
				);
				const expected = new Set(testCase.expectedIds);
				const relevant = retrievedIds.filter((id) => expected.has(id)).length;
				const stale = retrievedIds.some((id) =>
					(testCase.forbiddenIds ?? []).includes(id),
				);
				const firstRelevant = retrievedIds.findIndex((id) => expected.has(id));
				const metrics = scoreMemoryBenchmarkCase(
					testCase.expectedIds,
					testCase.forbiddenIds ?? [],
					retrievedIds,
					testCase.k ?? Math.max(1, retrievedIds.length),
				);
				caseResults.push({
					caseId: testCase.id,
					retrievedIds,
					recall:
						expected.size > 0 ? relevant / expected.size : retrievedIds.length === 0 ? 1 : 0,
					precision:
						retrievedIds.length > 0
							? relevant / retrievedIds.length
							: expected.size === 0
								? 1
								: 0,
					stale,
					hit: firstRelevant >= 0,
					reciprocalRank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
					recallAll: metrics.recallAllAtK === 1,
					ndcg: metrics.ndcgAtK ?? 0,
					abstentionSuccess:
						metrics.abstentionSuccess === null
							? null
							: metrics.abstentionSuccess === 1,
					latencyMs: performance.now() - startedAt,
					error,
				});
			}
			const cases = Math.max(1, caseResults.length);
			return {
				name: condition.name,
				cases: testCases.length,
				recall: caseResults.reduce((sum, result) => sum + result.recall, 0) / cases,
				precision:
					caseResults.reduce((sum, result) => sum + result.precision, 0) / cases,
				staleRetrievalRate:
					caseResults.filter((result) => result.stale).length / cases,
				hitRate: caseResults.filter((result) => result.hit).length / cases,
				mrr:
					caseResults.reduce((sum, result) => sum + result.reciprocalRank, 0) /
					cases,
				forbiddenRetrievalRate:
					caseResults.filter((result) => result.stale).length / cases,
				recallAllRate:
					caseResults.filter((result) => result.recallAll).length / cases,
				ndcg: caseResults.reduce((sum, result) => sum + result.ndcg, 0) / cases,
				abstentionSuccessRate:
					caseResults.filter((result) => result.abstentionSuccess === true).length /
					Math.max(
						1,
						caseResults.filter((result) => result.abstentionSuccess !== null).length,
					),
				averageLatencyMs:
					caseResults.reduce((sum, result) => sum + result.latencyMs, 0) / cases,
				errors: caseResults.filter((result) => result.error).length,
				caseResults,
			};
		}),
	);
}
import { scoreMemoryBenchmarkCase } from "./benchmark.js";
