import type {
	MemoryCoverageSnapshot,
	MemoryUncertaintyEstimate,
	ScoredMemory,
} from "./types.js";

export interface UncertaintyEstimatorConfig {
	highConfidenceScore: number;
	highMemoryConfidence: number;
	lowCoverageScore: number;
}

const DEFAULT_CONFIG: UncertaintyEstimatorConfig = {
	highConfidenceScore: 0.72,
	highMemoryConfidence: 0.8,
	lowCoverageScore: 0.18,
};

export class UncertaintyEstimator {
	private config: UncertaintyEstimatorConfig;

	constructor(config: Partial<UncertaintyEstimatorConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	estimate(
		memories: ScoredMemory[],
		coverage?: MemoryCoverageSnapshot,
	): MemoryUncertaintyEstimate {
		if (memories.length === 0 && !coverage) {
			return {
				level: "NO_COVERAGE",
				coverageScore: 0,
				reason:
					"No retrieved memories and no meta-memory coverage for this topic.",
				knownGaps: ["No reliable prior memory for this topic."],
			};
		}

		const best = memories[0];
		const memoryConfidence = best
			? Number(best.item.metadata.confidence ?? 0.5)
			: 0;
		const coverageScore = Math.max(
			coverage?.coverageScore ?? 0,
			best ? best.score * memoryConfidence : 0,
		);

		if (
			best &&
			best.score >= this.config.highConfidenceScore &&
			memoryConfidence >= this.config.highMemoryConfidence &&
			coverageScore >= this.config.lowCoverageScore
		) {
			return {
				level: "HIGH_CONFIDENCE",
				coverageScore,
				reason: "Relevant high-confidence memory and adequate topic coverage.",
				knownGaps: coverage?.knownGaps ?? [],
			};
		}

		if (memories.length > 0 || coverageScore >= this.config.lowCoverageScore) {
			return {
				level: "LOW_CONFIDENCE",
				coverageScore,
				reason:
					"Some memory exists, but relevance, confidence, or coverage is weak.",
				knownGaps: coverage?.knownGaps ?? [
					"Memory exists but should not be treated as definitive.",
				],
			};
		}

		return {
			level: "NO_COVERAGE",
			coverageScore,
			reason: "Meta-memory coverage is below the reliability threshold.",
			knownGaps: coverage?.knownGaps?.length
				? coverage.knownGaps
				: ["No reliable prior memory for this topic."],
		};
	}
}
