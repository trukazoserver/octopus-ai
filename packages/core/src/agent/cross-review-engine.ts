/**
 * CrossReviewEngine — Peer review, correction and verification between agents.
 *
 * After workers complete their tasks, this engine:
 * 1. Publishes their results as artifacts on the coordination bus
 * 2. Assigns peer reviewers (each arm is reviewed by a complementary arm)
 * 3. Runs reviews using the LLM with reviewer-specific expertise
 * 4. Applies corrections when issues are found
 * 5. Runs final QA verification (Crabby)
 * 6. Returns verified results for synthesis
 */

import type { LLMRouter } from "../ai/router.js";
import { getOctopusArmProfile } from "./arm-profiles.js";
import {
	AgentCoordinationBus,
	type AgentArtifact,
	type ArtifactReview,
} from "./agent-coordination-bus.js";

export interface CrossReviewConfig {
	enabled: boolean;
	reviewersPerArtifact: number;
	correctionRounds: number;
	requireFinalVerification: boolean;
	timeoutMs: number;
}

export interface ReviewAssignment {
	taskId: string;
	taskRole: string;
	reviewerArmKey: string;
	reviewerAgentId: string;
	reviewerName: string;
	priority: "normal" | "high";
}

export interface CrossReviewResult {
	totalReviews: number;
	approved: number;
	needsCorrection: number;
	rejected: number;
	correctionsApplied: number;
	corrections: Array<{
		taskId: string;
		originalAgent: string;
		correctorAgent: string;
		reason: string;
	}>;
	verifiedArtifacts: string[];
	unverifiedArtifacts: string[];
}

const DEFAULT_CROSS_REVIEW_CONFIG: CrossReviewConfig = {
	enabled: true,
	reviewersPerArtifact: 1,
	correctionRounds: 1,
	requireFinalVerification: true,
	timeoutMs: 15_000,
};

/**
 * Mapping of which arm should review which other arm's work.
 * Designed so complementary expertise provides the best review:
 * - Planner (bibi) → QA checks the plan
 * - Memory (anita) → Researcher fact-checks sources
 * - Engineer (ari) → QA reviews code quality
 * - Creative (cali) → Vision checks visual quality
 * - QA (crabby) → Engineer validates technical accuracy
 * - Writer (estelita) → Memory verifies facts
 * - Researcher (langi) → Memory checks source reliability
 * - Vision (medi) → QA validates data accuracy
 */
const PEER_REVIEW_MAP: Record<string, string[]> = {
	bibi: ["crabby"],
	anita: ["langi"],
	ari: ["crabby"],
	cali: ["medi"],
	crabby: ["ari"],
	estelita: ["anita"],
	langi: ["anita"],
	medi: ["crabby"],
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(
				() => reject(new Error(`Review timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		}),
	]);
}

export class CrossReviewEngine {
	private config: CrossReviewConfig;

	constructor(
		private llmRouter: LLMRouter,
		private bus: AgentCoordinationBus,
		config: Partial<CrossReviewConfig> = {},
	) {
		this.config = { ...DEFAULT_CROSS_REVIEW_CONFIG, ...config };
	}

	/**
	 * Assign peer reviewers for each completed artifact.
	 * Never assigns self-review.
	 */
	assignReviewers(artifacts: AgentArtifact[]): ReviewAssignment[] {
		const assignments: ReviewAssignment[] = [];

		for (const artifact of artifacts) {
			const preferredReviewers =
				PEER_REVIEW_MAP[artifact.armKey] ?? ["crabby"];

			for (const reviewerKey of preferredReviewers.slice(
				0,
				this.config.reviewersPerArtifact,
			)) {
				const profile = getOctopusArmProfile(reviewerKey);
				if (!profile || profile.key === artifact.armKey) continue;

				assignments.push({
					taskId: artifact.taskId,
					taskRole: artifact.taskRole,
					reviewerArmKey: profile.key,
					reviewerAgentId: profile.agentId,
					reviewerName: profile.name,
					priority:
						artifact.status === "needs_correction" ? "high" : "normal",
				});
			}
		}

		return assignments;
	}

	/**
	 * Review a single artifact using the LLM with the reviewer's expertise.
	 */
	async reviewArtifact(
		artifact: AgentArtifact,
		reviewerArmKey: string,
		originalGoal: string,
	): Promise<ArtifactReview> {
		const reviewerProfile = getOctopusArmProfile(reviewerArmKey);
		if (!reviewerProfile) {
			return {
				reviewerId: `arm-${reviewerArmKey}`,
				reviewerName: reviewerArmKey,
				verdict: "approved",
				issues: [],
				suggestions: [],
				timestamp: Date.now(),
			};
		}

		const reviewPrompt = this.buildReviewPrompt(
			artifact,
			reviewerProfile,
			originalGoal,
		);

		try {
			const response = await withTimeout(
				this.llmRouter.chat({
					model: "default",
					messages: [
						{ role: "system", content: reviewPrompt },
						{
							role: "user",
							content: `Revisa el siguiente resultado de ${artifact.agentName} (${artifact.taskRole}):\n\n${artifact.content.slice(0, 3000)}`,
						},
					],
					maxTokens: 800,
					temperature: 0.2,
				}),
				this.config.timeoutMs,
			);

			return this.parseReviewResponse(response.content, reviewerProfile);
		} catch {
			return {
				reviewerId: reviewerProfile.agentId,
				reviewerName: reviewerProfile.name,
				verdict: "approved",
				issues: [],
				suggestions: [
					"Revision automatica omitida por timeout — resultado aceptado por defecto.",
				],
				timestamp: Date.now(),
			};
		}
	}

	/**
	 * Run the full cross-review cycle for all artifacts.
	 *
	 * Flow:
	 * 1. Assign peer reviewers
	 * 2. Run all reviews in parallel
	 * 3. Apply corrections for issues found
	 * 4. Final QA verification by Crabby
	 */
	async runCrossReview(
		artifacts: AgentArtifact[],
		originalGoal: string,
		signal?: AbortSignal,
	): Promise<CrossReviewResult> {
		if (!this.config.enabled || artifacts.length === 0) {
			return {
				totalReviews: 0,
				approved: artifacts.length,
				needsCorrection: 0,
				rejected: 0,
				correctionsApplied: 0,
				corrections: [],
				verifiedArtifacts: artifacts.map((a) => a.taskId),
				unverifiedArtifacts: [],
			};
		}

		const assignments = this.assignReviewers(artifacts);
		let approved = 0;
		let needsCorrection = 0;
		let rejected = 0;
		let correctionsApplied = 0;
		const corrections: CrossReviewResult["corrections"] = [];
		const verifiedArtifacts: string[] = [];
		const unverifiedArtifacts: string[] = [];

		// Phase 1: Run peer reviews in parallel
		const reviewPromises = assignments.map(async (assignment) => {
			if (signal?.aborted) return null;

			const artifact = this.bus.getArtifact(assignment.taskId);
			if (!artifact) return null;

			// Notify that review is starting
			this.bus.send({
				from: assignment.reviewerAgentId,
				fromName: assignment.reviewerName,
				to: artifact.agentId,
				type: "review_request",
				priority: "normal",
				content: `Iniciando revisión de tu trabajo en "${assignment.taskId}".`,
				relatedTaskId: assignment.taskId,
			});

			const review = await this.reviewArtifact(
				artifact,
				assignment.reviewerArmKey,
				originalGoal,
			);

			this.bus.addReview(assignment.taskId, review);

			return { assignment, review };
		});

		const reviewResults = await Promise.allSettled(reviewPromises);

		// Phase 2: Process review results and apply corrections
		for (const result of reviewResults) {
			if (result.status !== "fulfilled" || !result.value) continue;
			const { assignment, review } = result.value;

			if (review.verdict === "approved") {
				approved++;
				verifiedArtifacts.push(assignment.taskId);
			} else if (review.verdict === "rejected") {
				rejected++;
				unverifiedArtifacts.push(assignment.taskId);
			} else {
				needsCorrection++;
				unverifiedArtifacts.push(assignment.taskId);

				if (review.issues.length > 0) {
					const artifact = this.bus.getArtifact(assignment.taskId);
					corrections.push({
						taskId: assignment.taskId,
						originalAgent:
							artifact?.agentName ?? "unknown",
						correctorAgent: assignment.reviewerName,
						reason: review.issues.join("; "),
					});

					// Attempt LLM-powered correction
					if (artifact && this.config.correctionRounds > 0) {
						const corrected = await this.attemptCorrection(
							artifact,
							assignment,
							review,
							originalGoal,
							signal,
						);
						if (corrected) correctionsApplied++;
					}
				}
			}
		}

		// Phase 3: Final verification by Crabby (QA) for anything still unverified
		if (this.config.requireFinalVerification) {
			const stillUnverified = this.bus
				.getAllArtifacts()
				.filter(
					(a) =>
						a.status !== "verified" && a.status !== "rejected",
				);

			for (const artifact of stillUnverified) {
				if (signal?.aborted) break;

				const finalReview = await this.reviewArtifact(
					artifact,
					"crabby",
					originalGoal,
				);

				this.bus.addReview(artifact.taskId, finalReview);

				if (finalReview.verdict === "approved") {
					if (!verifiedArtifacts.includes(artifact.taskId)) {
						verifiedArtifacts.push(artifact.taskId);
					}
					const idx = unverifiedArtifacts.indexOf(artifact.taskId);
					if (idx >= 0) unverifiedArtifacts.splice(idx, 1);
				}
			}
		}

		return {
			totalReviews: assignments.length,
			approved,
			needsCorrection,
			rejected,
			correctionsApplied,
			corrections,
			verifiedArtifacts,
			unverifiedArtifacts,
		};
	}

	/**
	 * Attempt to correct an artifact using the reviewer's feedback.
	 * The corrector agent uses the LLM to generate a corrected version.
	 */
	private async attemptCorrection(
		artifact: AgentArtifact,
		assignment: ReviewAssignment,
		review: ArtifactReview,
		originalGoal: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (signal?.aborted) return false;

		const correctorProfile = getOctopusArmProfile(assignment.reviewerArmKey);
		if (!correctorProfile) return false;

		try {
			const response = await withTimeout(
				this.llmRouter.chat({
					model: "default",
					messages: [
						{
							role: "system",
							content: [
								`Eres ${correctorProfile.name}, un agente de corrección.`,
								`Tu rol: ${correctorProfile.role}.`,
								`Especialidad: ${correctorProfile.description}.`,
								"Corrige el resultado del agente basandote en los problemas identificados.",
								"Devuelve SOLO el resultado corregido, sin explicaciones adicionales.",
							].join("\n"),
						},
						{
							role: "user",
							content: [
								`Objetivo original: ${originalGoal}`,
								`Resultado de ${artifact.agentName}:`,
								artifact.content.slice(0, 2000),
								"",
								"Problemas identificados:",
								...review.issues.map((i) => `- ${i}`),
								"",
								"Sugerencias:",
								...review.suggestions.map((s) => `- ${s}`),
								"",
								"Proporciona el resultado corregido:",
							].join("\n"),
						},
					],
					maxTokens: 1500,
					temperature: 0.2,
				}),
				this.config.timeoutMs,
			);

			if (response.content?.trim()) {
				this.bus.addCorrection(artifact.taskId, {
					correctorId: correctorProfile.agentId,
					correctorName: correctorProfile.name,
					originalContent: artifact.content,
					correctedContent: response.content,
					reason: review.issues.join("; "),
				});
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	private buildReviewPrompt(
		artifact: AgentArtifact,
		reviewer: {
			name: string;
			role: string;
			description: string;
			capabilities: string[];
		},
		originalGoal: string,
	): string {
		return [
			`Eres ${reviewer.name}, un agente revisor independiente.`,
			`Tu rol: ${reviewer.role}. Especialidad: ${reviewer.description}.`,
			`Tus capacidades: ${reviewer.capabilities.join(", ")}.`,
			"",
			`Estas revisando el trabajo de ${artifact.agentName} (${artifact.taskRole}).`,
			`Objetivo original del usuario: ${originalGoal}`,
			"",
			"Responde SOLO con un JSON valido (sin markdown, sin ```):",
			"{",
			'  "verdict": "approved" | "needs_work" | "rejected",',
			'  "issues": ["problema 1", "problema 2"],',
			'  "suggestions": ["sugerencia 1", "sugerencia 2"]',
			"}",
			"",
			"Criterios de revision:",
			"- approved: El resultado es correcto, completo y cumple el objetivo.",
			"- needs_work: Hay problemas menores que pueden corregirse.",
			"- rejected: El resultado es fundamentalmente incorrecto o peligroso.",
			"- Solo marca rejected si hay errores criticos de seguridad o logica.",
			"- No seas excesivamente estricto; prioriza completar la tarea.",
		].join("\n");
	}

	private parseReviewResponse(
		content: string | undefined,
		reviewer: { agentId: string; name: string },
	): ArtifactReview {
		const fallback: ArtifactReview = {
			reviewerId: reviewer.agentId,
			reviewerName: reviewer.name,
			verdict: "approved",
			issues: [],
			suggestions: [],
			timestamp: Date.now(),
		};

		if (!content) return fallback;

		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (!jsonMatch) return fallback;

			const parsed = JSON.parse(jsonMatch[0]);
			const validVerdicts = ["approved", "needs_work", "rejected"];
			const verdict = validVerdicts.includes(parsed.verdict)
				? parsed.verdict
				: "approved";

			return {
				reviewerId: reviewer.agentId,
				reviewerName: reviewer.name,
				verdict,
				issues: Array.isArray(parsed.issues)
					? parsed.issues.filter((i: unknown) => typeof i === "string")
					: [],
				suggestions: Array.isArray(parsed.suggestions)
					? parsed.suggestions.filter(
							(s: unknown) => typeof s === "string",
						)
					: [],
				timestamp: Date.now(),
			};
		} catch {
			return fallback;
		}
	}
}
