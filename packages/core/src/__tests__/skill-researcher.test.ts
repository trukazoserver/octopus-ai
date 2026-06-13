import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolResult } from "../tools/registry.js";
import { SkillResearcher } from "../skills/researcher.js";

function makeExecutor(impl?: (...args: unknown[]) => unknown): ToolExecutor {
	const exec = (impl ?? vi.fn()) as never;
	return { execute: exec } as unknown as ToolExecutor;
}

function ok(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
	} as Response;
}
function notOk(): Response {
	return { ok: false, status: 500, json: async () => ({}) } as Response;
}

describe("SkillResearcher", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	describe("classifyTechnical", () => {
		it("flags technical/documentable tasks", async () => {
			const r = new SkillResearcher(makeExecutor(), undefined);
			expect(
				await r.classifyTechnical({
					description: "Crear skill para usar React 19 use() hook",
					keywords: ["react", "hook"],
					domains: ["frontend"],
				}),
			).toBe(true);
			expect(
				await r.classifyTechnical({
					description: "Integrar la API de Stripe para pagos v2024-06-20",
					keywords: ["stripe", "api"],
					domains: ["backend"],
				}),
			).toBe(true);
		});

		it("does not flag purely experiential tasks", async () => {
			const r = new SkillResearcher(makeExecutor(), undefined);
			expect(
				await r.classifyTechnical({
					description: "Recordar que Edwin prefiere respuestas cortas en español",
					keywords: ["edwin"],
					domains: [],
				}),
			).toBe(false);
		});
	});

	it("skips research for non-technical skills when onlyTechnical is set", async () => {
		const exec = vi.fn();
		const r = new SkillResearcher(makeExecutor(exec), undefined, {
			onlyTechnical: true,
		});
		const res = await r.research({
			description: "Preferencia de formato del usuario",
			keywords: [],
			domains: ["personal"],
		});
		expect(res.isTechnical).toBe(false);
		expect(res.context).toBe("");
		expect(exec).not.toHaveBeenCalled();
	});

	it("uses Context7 MCP tools when they are registered", async () => {
		const exec = vi.fn().mockImplementation((name: string): ToolResult => {
			if (name === "context7_resolve-library-id")
				return { success: true, output: "library /vercel/next.js — Next.js" };
			if (name === "context7_query-docs")
				return { success: true, output: "Use the App Router with async server components." };
			return { success: false, output: "", error: "Tool not found" };
		});
		const r = new SkillResearcher(makeExecutor(exec), undefined);
		const res = await r.research({
			description: "Skill de Next.js 15 app router",
			keywords: ["nextjs"],
			domains: ["frontend"],
		});
		expect(res.isTechnical).toBe(true);
		expect(res.sources.some((s) => s.startsWith("context7:"))).toBe(true);
		expect(res.context).toContain("App Router");
	});

	it("falls back to Context7 HTTP when MCP tools are not registered", () => {
		const exec = vi.fn().mockResolvedValue({
			success: false,
			output: "",
			error: "Tool not found",
		} satisfies ToolResult);
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url.includes("/api/v2/libs/search"))
				return Promise.resolve(ok({ libraries: [{ id: "/vercel/next.js", name: "Next.js" }] }));
			if (url.includes("/api/v2/context"))
				return Promise.resolve(ok({ context: "fresh docs from http fallback" }));
			return Promise.resolve(notOk());
		});
		vi.stubGlobal("fetch", fetchMock);

		const r = new SkillResearcher(makeExecutor(exec), undefined);
		return r
			.research({
				description: "Next.js routing",
				keywords: ["nextjs"],
				domains: ["web"],
			})
			.then((res) => {
				expect(res.sources.some((s) => s.startsWith("context7:"))).toBe(true);
				expect(res.context).toContain("fresh docs from http fallback");
			});
	});

	it("uses web search + reader when Context7 is unavailable", () => {
		const exec = vi.fn().mockImplementation((name: string): ToolResult => {
			if (name === "zai-web-search")
				return {
					success: true,
					output: "Top result: https://example.com/docs/react-hooks React 19 hooks",
				};
			if (name === "zai-web-reader")
				return { success: true, output: "React 19 introduces the use() API." };
			return { success: false, output: "", error: "Tool not found" };
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notOk()));

		const r = new SkillResearcher(makeExecutor(exec), undefined);
		return r
			.research({
				description: "React 19 use hook",
				keywords: ["react"],
				domains: ["frontend"],
			})
			.then((res) => {
				expect(res.sources.some((s) => s.startsWith("web:"))).toBe(true);
				expect(res.context).toContain("use()");
			});
	});

	it("degrades gracefully when no source is available", () => {
		const exec = vi.fn().mockResolvedValue({
			success: false,
			output: "",
			error: "Tool not found",
		} satisfies ToolResult);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notOk()));

		const r = new SkillResearcher(makeExecutor(exec), undefined);
		return r
			.research({
				description: "PostgreSQL indexes",
				keywords: ["postgres"],
				domains: ["database"],
			})
			.then((res) => {
				expect(res.isTechnical).toBe(true);
				expect(res.context).toBe("");
				expect(res.sources).toEqual([]);
			});
	});

	it("respects the maxSources and token budget caps", async () => {
		const exec = vi.fn().mockImplementation((name: string): ToolResult => {
			if (name === "context7_resolve-library-id")
				return { success: true, output: "/vercel/next.js" };
			if (name === "context7_query-docs")
				return { success: true, output: "A".repeat(100_000) };
			return { success: false, output: "", error: "Tool not found" };
		});
		const r = new SkillResearcher(makeExecutor(exec), undefined, {
			maxSources: 1,
			maxContextTokens: 100,
		});
		const res = await r.research({
			description: "Next.js app router",
			keywords: ["nextjs"],
			domains: ["frontend"],
		});
		expect(res.sources.length).toBeLessThanOrEqual(1);
		expect(res.context.length).toBeLessThanOrEqual(100 * 4 + 1);
	});
});
