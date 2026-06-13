import { describe, expect, it, vi } from "vitest";
import type { LLMRouter } from "../ai/router.js";
import type { EmbeddingFunction } from "../memory/types.js";
import type { Skill, SkillResearchResult, SkillUsage } from "../skills/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillResearcher } from "../skills/researcher.js";
import { SkillImprover } from "../skills/improver.js";

function mockRegistry(): SkillRegistry {
	return {
		save: vi.fn().mockResolvedValue(undefined),
		archiveVersion: vi.fn().mockResolvedValue(undefined),
		db: {
			run: vi.fn().mockResolvedValue(undefined),
			all: vi.fn().mockResolvedValue([]),
		},
		getById: vi.fn().mockResolvedValue(null),
	} as unknown as SkillRegistry;
}
function mockEmbed(): EmbeddingFunction {
	return vi.fn().mockResolvedValue([0.1]) as EmbeddingFunction;
}
function mockRouter(content: string): LLMRouter {
	return { chat: vi.fn().mockResolvedValue({ content, usage: {} }) } as unknown as LLMRouter;
}
function mockResearcher(result: SkillResearchResult): SkillResearcher {
	return { research: vi.fn().mockResolvedValue(result) } as unknown as SkillResearcher;
}

const baseSkill: Skill = {
	id: "s1",
	name: "next-skill",
	version: "1.0.0",
	description: "Next.js app router skill",
	tags: ["nextjs"],
	embedding: [],
	instructions: "## Approach\nold instructions about routing",
	examples: [],
	templates: [],
	triggerConditions: { keywords: ["nextjs"], taskPatterns: [], domains: ["frontend"] },
	contextEstimate: { instructions: 10, perExample: 0, templates: 0 },
	metrics: {
		timesUsed: 5,
		successRate: 0.4,
		avgUserRating: 3,
		lastUsed: "2026-06-12T00:00:00.000Z",
		improvementsCount: 0,
		createdAt: "2026-06-01T00:00:00.000Z",
	},
	quality: { completeness: 0.5, accuracy: 0.5, clarity: 0.5 },
	dependencies: [],
	related: [],
};

const usageHistory: SkillUsage[] = [
	{
		id: "u1",
		skillId: "s1",
		task: "render route",
		success: false,
		failureReason: "wrong route handler",
		timestamp: new Date(),
	},
];

const baseImproverConfig = {
	triggerOnSuccessRate: 0.7,
	triggerOnRating: 3.5,
	reviewEveryNUses: 10,
	abTestMajorChanges: false,
	abTestSampleSize: 20,
};

describe("SkillImprover", () => {
	it("rewrites instructions via LLM grounded in fresh research for technical skills", async () => {
		const router = mockRouter(
			"## Approach\nImproved using App Router `use()` for async data fetching.",
		);
		const researcher = mockResearcher({
			isTechnical: true,
			context: "App Router use() for async data.",
			sources: ["context7:/vercel/next.js"],
			fetchedAt: "2026-06-13T00:00:00.000Z",
			summary: "researched",
		});
		const improver = new SkillImprover(
			mockRegistry(),
			mockEmbed(),
			baseImproverConfig,
			{ router, researcher },
		);

		const improved = await improver.improveSkill(baseSkill, usageHistory);

		expect(router.chat).toHaveBeenCalled();
		expect(improved.instructions).toContain("App Router");
		expect(improved.freshInfo?.sources).toContain("context7:/vercel/next.js");
	});

	it("falls back to heuristic improvement when no router is available", async () => {
		const improver = new SkillImprover(
			mockRegistry(),
			mockEmbed(),
			baseImproverConfig,
		);

		const improved = await improver.improveSkill(baseSkill, usageHistory);

		expect(improved.instructions).toContain("Known Failure Patterns");
	});

	it("does not use the LLM for non-technical skills even with a router", async () => {
		const router = mockRouter("SHOULD NOT BE USED");
		const researcher = mockResearcher({
			isTechnical: false,
			context: "",
			sources: [],
			fetchedAt: "",
			summary: "non-technical",
		});
		const improver = new SkillImprover(
			mockRegistry(),
			mockEmbed(),
			baseImproverConfig,
			{ router, researcher },
		);

		const improved = await improver.improveSkill(baseSkill, usageHistory);

		expect(router.chat).not.toHaveBeenCalled();
		expect(improved.instructions).toContain("Known Failure Patterns");
	});
});
