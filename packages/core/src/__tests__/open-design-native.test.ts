import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMRouter } from "../ai/router.js";
import {
	OPEN_DESIGN_COMMIT,
	OpenDesignNativeRegistry,
	createOpenDesignNativeTools,
} from "../tools/open-design-native.js";
import type { ToolContext, ToolDefinition } from "../tools/registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function createFixture(): Promise<{
	sourceDir: string;
	workspaceDir: string;
}> {
	const root = await mkdtemp(
		path.join(tmpdir(), "octopus-open-design-native-"),
	);
	tempDirs.push(root);
	const sourceDir = path.join(root, "source");
	const workspaceDir = path.join(root, "workspace");
	await mkdir(path.join(sourceDir, "skills", "deck-test"), { recursive: true });
	await mkdir(path.join(sourceDir, "design-templates", "editorial-test"), {
		recursive: true,
	});
	await mkdir(path.join(sourceDir, "design-systems", "brand-test"), {
		recursive: true,
	});
	await mkdir(
		path.join(sourceDir, "plugins", "_official", "scenarios", "plugin-test"),
		{ recursive: true },
	);
	await mkdir(path.join(sourceDir, "craft"), { recursive: true });
	await writeFile(
		path.join(sourceDir, "LICENSE"),
		"Apache License 2.0",
		"utf8",
	);
	await writeFile(
		path.join(sourceDir, "skills", "deck-test", "SKILL.md"),
		`---
name: deck-test
description: Editorial deck workflow for native Octopus tests.
od:
  mode: deck
---
# Workflow
Use varied layouts, strong typography, evidence, and visual QA.`,
		"utf8",
	);
	await writeFile(
		path.join(sourceDir, "design-templates", "editorial-test", "index.html"),
		"<main>Editorial template</main>",
		"utf8",
	);
	await writeFile(
		path.join(sourceDir, "design-systems", "brand-test", "DESIGN.md"),
		"# Brand Test\n## Color Palette\nInk and amber.",
		"utf8",
	);
	await writeFile(
		path.join(
			sourceDir,
			"plugins",
			"_official",
			"scenarios",
			"plugin-test",
			"open-design.json",
		),
		JSON.stringify({
			name: "plugin-test",
			description: "Native plugin recipe",
		}),
		"utf8",
	);
	for (const craft of ["typography", "color", "anti-ai-slop"]) {
		await writeFile(
			path.join(sourceDir, "craft", `${craft}.md`),
			`# ${craft}\nNative craft rule.`,
			"utf8",
		);
	}
	return { sourceDir, workspaceDir };
}

function getTool(tools: ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool;
}

const context = {
	media: {
		save: vi.fn(),
		resolve: vi.fn(),
	},
} as unknown as ToolContext;

describe("native Open Design integration", () => {
	it("indexes and loads pinned Open Design packages without a sidecar", async () => {
		const { sourceDir } = await createFixture();
		const registry = new OpenDesignNativeRegistry({ sourceDir });

		const skills = await registry.list("skill", "editorial");
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			id: "deck-test",
			name: "deck-test",
			mode: "deck",
		});

		const loaded = await registry.get("skill", "deck-test");
		expect(loaded.primaryContent).toContain("varied layouts");
		expect(loaded.sourcePath).toBe("skills/deck-test");
		expect(await registry.list("plugin", "plugin-test")).toMatchObject([
			{ id: "_official/scenarios/plugin-test" },
		]);
	});

	it("creates projects and generates HTML with the active Octopus router", async () => {
		const { sourceDir, workspaceDir } = await createFixture();
		const chat = vi.fn().mockResolvedValue({
			content: JSON.stringify({
				entryFile: "index.html",
				files: [
					{
						path: "index.html",
						content:
							"<!doctype html><title>Native Open Design</title><main>Octopus</main>",
					},
				],
			}),
			model: "test-model",
			usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
			finishReason: "stop",
		});
		const tools = createOpenDesignNativeTools(
			{ chat } as unknown as LLMRouter,
			[workspaceDir],
			workspaceDir,
			{ sourceDir },
		);

		const created = await getTool(tools, "open_design_create_project").handler(
			{ name: "Native Test" },
			context,
		);
		expect(created.success).toBe(true);

		const generated = await getTool(tools, "open_design_generate").handler(
			{
				project: "native-test",
				brief: "Create a distinctive proof artifact.",
				artifactType: "html",
				skill: "deck-test",
				designSystem: "brand-test",
			},
			context,
		);
		expect(generated.success).toBe(true);
		expect(chat).toHaveBeenCalledOnce();
		expect(JSON.parse(generated.output)).toMatchObject({
			artifactType: "html",
			provider: "octopus-llm-router",
		});
		expect(
			await readFile(
				path.join(workspaceDir, "open-design", "native-test", "index.html"),
				"utf8",
			),
		).toContain("Native Open Design");
	});

	it("materializes a real PPTX through the native Octopus office tool", async () => {
		const { sourceDir, workspaceDir } = await createFixture();
		const chat = vi.fn().mockResolvedValue({
			content: JSON.stringify({
				title: "Native Open Design",
				designBrief:
					"Editorial proof with ink and amber, projection-safe typography, and varied layouts.",
				stylePreset: "Swiss International Style",
				renderMode: "editable",
				theme: {
					colors: { primary: "#002FA7", background: "#FAFAF8" },
					fonts: { heading: "Helvetica", body: "Arial" },
				},
				slides: [
					{
						layout: "titleSlide",
						title: "Slide 1",
						content: {
							title: "Open Design lives inside Octopus",
							subtitle: "No daemon. No second login.",
						},
						speakerNotes: "Native generation proof.",
					},
					{
						layout: "content",
						content: {
							title: "One native workflow",
							steps: [
								{ title: "Discover", description: "Load the pinned catalog." },
								{
									title: "Design",
									description: "Use the active Octopus model.",
								},
								{ title: "Validate", description: "Run native Office QA." },
							],
						},
					},
					{
						layout: "content",
						content: {
							title: "One product, full design range",
							columns: [
								{ title: "Consistent", description: "One visual system." },
								{ title: "Efficient", description: "No second application." },
								{ title: "Native", description: "Octopus credentials and QA." },
							],
						},
					},
				],
			}),
			model: "test-model",
			usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
			finishReason: "stop",
		});
		const tools = createOpenDesignNativeTools(
			{ chat } as unknown as LLMRouter,
			[workspaceDir],
			workspaceDir,
			{ sourceDir },
		);
		await getTool(tools, "open_design_create_project").handler(
			{ name: "Native PPTX" },
			context,
		);
		const generated = await getTool(tools, "open_design_generate").handler(
			{
				project: "native-pptx",
				brief: "Create a three-slide integration proof.",
				artifactType: "pptx",
				skill: "deck-test",
				outputName: "proof.pptx",
			},
			context,
		);

		expect(generated.success).toBe(true);
		const output = JSON.parse(generated.output) as { outputPath: string };
		expect(output.outputPath).toBe(
			path.join(workspaceDir, "open-design", "native-pptx", "proof.pptx"),
		);
		expect((await readFile(output.outputPath)).subarray(0, 2).toString()).toBe(
			"PK",
		);
		const generatedSpec = JSON.parse(
			await readFile(
				path.join(
					workspaceDir,
					"open-design",
					"native-pptx",
					"generation-spec.json",
				),
				"utf8",
			),
		) as {
			stylePreset: string;
			theme: { headingFont: string; primary: string };
			slides: Array<{
				layout: string;
				title: string;
				steps?: unknown[];
				items?: unknown[];
			}>;
		};
		expect(generatedSpec.stylePreset).toBe("swiss");
		expect(generatedSpec.theme).toMatchObject({
			headingFont: "Arial",
			primary: "#002FA7",
		});
		expect(generatedSpec.slides.map((slide) => slide.layout)).toEqual([
			"cover",
			"process",
			"iconGrid",
		]);
		expect(generatedSpec.slides.map((slide) => slide.title)).toEqual([
			"Open Design lives inside Octopus",
			"One native workflow",
			"One product, full design range",
		]);
		expect(generatedSpec.slides[1]?.steps).toHaveLength(3);
		expect(generatedSpec.slides[2]?.items).toHaveLength(3);
		expect(output.outputPath).not.toContain("Open Design.exe");
		expect(OPEN_DESIGN_COMMIT).toHaveLength(40);
	});
});
