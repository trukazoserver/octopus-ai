import { describe, expect, it, vi } from "vitest";
import type { LLMRouter } from "../ai/router.js";
import type { TaskDescription, TaskResult } from "../agent/types.js";
import type { EmbeddingFunction } from "../memory/types.js";
import type { SkillResearchResult } from "../skills/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillResearcher } from "../skills/researcher.js";
import { SkillForge } from "../skills/forge.js";

function mockRegistry(): SkillRegistry {
	return { save: vi.fn().mockResolvedValue(undefined) } as unknown as SkillRegistry;
}
function mockEmbed(): EmbeddingFunction {
	return vi.fn().mockResolvedValue([0.1, 0.2]) as EmbeddingFunction;
}
function mockRouter(content: string): LLMRouter {
	return { chat: vi.fn().mockResolvedValue({ content, usage: {} }) } as unknown as LLMRouter;
}
function mockResearcher(result: SkillResearchResult): SkillResearcher {
	return { research: vi.fn().mockResolvedValue(result) } as unknown as SkillResearcher;
}

const task: TaskDescription = {
	description: "Crear skill para Next.js 15 app router",
	complexity: 0.7,
	domains: ["frontend"],
	keywords: ["nextjs", "app-router"],
};
const result: TaskResult = {
	summary: "Configuramos el app router",
	whatWorked: "usar async components con use()",
	whatCouldImprove: "manejar errores de carga",
	patterns: ["layout.tsx", "loading.tsx"],
};

const baseForgeConfig = {
	complexityThreshold: 0.6,
	selfCritique: false,
	minQualityScore: 7,
	includeExamples: true,
	includeTemplates: false,
	includeAntiPatterns: false,
};

describe("SkillForge", () => {
	it("generates instructions via LLM grounded in fresh research for technical skills", async () => {
		const router = mockRouter(
			"## Overview\nSkill para Next.js 15 con App Router: usar `use()` para async.",
		);
		const researcher = mockResearcher({
			isTechnical: true,
			context: "App Router supports async components via use().",
			sources: ["context7:/vercel/next.js"],
			fetchedAt: "2026-06-13T00:00:00.000Z",
			summary: "researched",
		});
		const forge = new SkillForge(mockRegistry(), mockEmbed(), baseForgeConfig, {
			router,
			researcher,
		});

		const skill = await forge.createSkill(task, result);

		expect(router.chat).toHaveBeenCalled();
		expect(skill.instructions).toContain("App Router");
		expect(skill.freshInfo?.sources).toContain("context7:/vercel/next.js");
	});

	it("passes the fresh context into the LLM prompt", async () => {
		const chat = vi.fn().mockResolvedValue({ content: "## Overview\nok", usage: {} });
		const router = { chat } as unknown as LLMRouter;
		const researcher = mockResearcher({
			isTechnical: true,
			context: "AUTHORITY-DOC-MARKER",
			sources: ["context7:/x/y"],
			fetchedAt: "t",
			summary: "s",
		});
		const forge = new SkillForge(mockRegistry(), mockEmbed(), baseForgeConfig, {
			router,
			researcher,
		});
		await forge.createSkill(task, result);
		const userContent = chat.mock.calls[0]?.[0]?.messages?.find(
			(m: { role: string }) => m.role === "user",
		)?.content;
		expect(userContent).toContain("AUTHORITY-DOC-MARKER");
	});

	it("falls back to heuristic instructions when no router is available", async () => {
		const researcher = mockResearcher({
			isTechnical: false,
			context: "",
			sources: [],
			fetchedAt: "",
			summary: "non-technical",
		});
		const forge = new SkillForge(mockRegistry(), mockEmbed(), baseForgeConfig, {
			researcher,
		});

		const skill = await forge.createSkill(task, result);

		expect(skill.instructions).toContain("## Overview");
		expect(skill.freshInfo).toBeUndefined();
	});

	it("does not use the LLM for non-technical skills even when a router is present", async () => {
		const router = mockRouter("SHOULD NOT BE USED");
		const researcher = mockResearcher({
			isTechnical: false,
			context: "",
			sources: [],
			fetchedAt: "",
			summary: "non-technical",
		});
		const forge = new SkillForge(mockRegistry(), mockEmbed(), baseForgeConfig, {
			router,
			researcher,
		});

		const skill = await forge.createSkill(task, result);

		expect(router.chat).not.toHaveBeenCalled();
		expect(skill.instructions).toContain("## Overview");
	});
});
