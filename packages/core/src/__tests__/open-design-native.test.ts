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
					{
						layout: "content",
						title: "Native metrics",
						metrics: [
							{ value: "162", label: "Skills" },
							{ value: "460", label: "Plugin recipes" },
						],
					},
					{
						layout: "content",
						title: "Native comparison",
						headers: ["Layer", "Owner"],
						rows: [
							["Design", "Open Design catalog"],
							["Execution", "Octopus"],
						],
					},
					{
						layout: "content",
						title: "Native composition",
						leftColumn: {
							heading: "Reference first",
							body: "Design direction from Open Design.",
						},
						rightColumn: {
							heading: "Native output",
							body: "Editable Office artifact from Octopus.",
						},
					},
					{
						layout: "statement",
						title: "Cierre",
						statement: "Open Design knowledge, Octopus execution.",
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
				brief: "Create a three-slide Swiss integration proof.",
				artifactType: "pptx",
				outputName: "proof.pptx",
			},
			context,
		);

		expect(generated.success).toBe(true);
		const output = JSON.parse(generated.output) as {
			outputPath: string;
			project: { packages: Array<{ type: string; id: string }> };
		};
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
			"metrics",
			"table",
			"twoColumn",
			"closing",
		]);
		expect(
			generatedSpec.slides.slice(0, 3).map((slide) => slide.title),
		).toEqual([
			"Open Design lives inside Octopus",
			"One native workflow",
			"One product, full design range",
		]);
		expect(generatedSpec.slides[1]?.steps).toHaveLength(3);
		expect(generatedSpec.slides[2]?.items).toHaveLength(3);
		expect(output.outputPath).not.toContain("Open Design.exe");
		expect(output.project.packages).toContainEqual({
			type: "skill",
			id: "deck-test",
			path: "source-cache",
		});
		expect(OPEN_DESIGN_COMMIT).toHaveLength(40);
	});

	it("repairs rich Open Design table, chart, and layout dialects before rendering", async () => {
		const { sourceDir, workspaceDir } = await createFixture();
		const chat = vi.fn().mockResolvedValue({
			content: JSON.stringify({
				title: "El Ciclo Menstrual",
				designBrief:
					"Estilo editorial cálido. Terracota #C77B6A dominante, rosado empolvado #E8B4A8 de apoyo, verde salvia #8B9D83 de acento, marfil #F8F1EB de fondo y gris carbón #4A4A4A para texto. Playfair Display para títulos e Inter para cuerpo; prohibido Arial.",
				stylePreset: "swiss",
				renderMode: "hybrid",
				theme: { headingFont: "Arial", bodyFont: "Arial" },
				slides: [
					{
						layout: "cover",
						title: "El Ciclo Menstrual",
						subtitle: "Entender tu cuerpo es cuidarlo",
					},
					{
						layout: "content",
						title: "¿Qué es el ciclo?",
						metrics: [
							{
								value: "28",
								unit: "días",
								label: "Promedio",
								note: "Un valor orientativo.",
							},
							{ value: "21–35", unit: "días", label: "Rango normal" },
						],
						sources: ["ACOG"],
					},
					{
						layout: "content",
						title: "Las cuatro fases",
						segments: [
							{ name: "Menstrual", days: "Días 1–5", summary: "Sangrado." },
							{ name: "Folicular", days: "Días 1–13", summary: "Maduración." },
							{ name: "Ovulación", days: "Día 14", summary: "Liberación." },
							{ name: "Lútea", days: "Días 15–28", summary: "Preparación." },
						],
					},
					{
						layout: "content",
						title: "Fase menstrual",
						leftColumn: {
							heading: "Lo que ocurre",
							paragraphs: ["Caen las hormonas.", "El endometrio se desprende."],
							symptomList: { items: ["Cólicos", "Fatiga"] },
						},
						rightColumn: {
							heading: "Cuidados",
							careItems: [
								{ name: "Reposo", description: "Dormir lo suficiente." },
								{ name: "Calor", description: "Aplicar calor local." },
							],
						},
					},
					{
						layout: "content",
						title: "Fase folicular",
						visualBlock: {
							label: "Folículo dominante",
							description: "Crecimiento progresivo.",
						},
						textContent: {
							heading: "El cuerpo se prepara",
							paragraphs: [
								"La FSH estimula los folículos.",
								"Aumenta el estrógeno.",
							],
							highlightCallout: "Más energía y concentración.",
						},
					},
					{
						layout: "content",
						title: "Ovulación",
						leadStatement: "El óvulo vive solo 12–24 horas",
						details: [
							{ label: "Pico de LH", text: "Libera el óvulo." },
							{ label: "Ventana fértil", text: "Aproximadamente seis días." },
						],
					},
					{
						layout: "content",
						title: "Fase lútea",
						leftColumn: {
							heading: "Progesterona",
							paragraphs: ["Mantiene el endometrio."],
						},
						rightColumn: {
							heading: "SPM",
							items: ["Hinchazón", "Sensibilidad"],
						},
					},
					{
						layout: "content",
						title: "Hormonas protagonistas",
						table: {
							columns: ["Hormona", "Función", "Pico"],
							rows: [
								{
									hormone: "Estrógeno",
									function: "Construye el endometrio",
									peak: "Folicular",
									color: "#C77B6A",
								},
								{
									hormone: "LH",
									function: "Dispara la ovulación",
									peak: "Día 14",
									color: "#8B9D83",
								},
							],
						},
						chart: {
							type: "line",
							series: [{ name: "LH", trend: "Pico en el día 14" }],
						},
						sources: ["ACOG", "Endocrine Society"],
					},
					{
						layout: "content",
						title: "Escucha tu cuerpo",
						cards: [
							{
								label: "Mito 01",
								myth: "La menstruación es sucia",
								reality: "Es un proceso biológico natural.",
							},
							{
								label: "Mito 02",
								myth: "No se puede hacer ejercicio",
								reality: "El ejercicio suave puede aliviar los cólicos.",
							},
							{
								label: "Mito 03",
								myth: "Siempre dura 28 días",
								reality: "Entre 21 y 35 días puede ser normal.",
							},
						],
					},
					{
						layout: "closing",
						title: "Slide 10",
						headline: "Tu ciclo no es una carga:",
						headlineAccent: "es información.",
						cta: { text: "Haz seguimiento de tu ciclo" },
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
			{ name: "Dialect Repair" },
			context,
		);

		const generated = await getTool(tools, "open_design_generate").handler(
			{
				project: "dialect-repair",
				brief:
					"Presentación editorial de salud con la paleta indicada y sin Arial.",
				artifactType: "pptx",
				outputName: "repaired.pptx",
			},
			context,
		);

		expect(generated.success).toBe(true);
		const spec = JSON.parse(
			await readFile(
				path.join(
					workspaceDir,
					"open-design",
					"dialect-repair",
					"generation-spec.json",
				),
				"utf8",
			),
		) as {
			nativeAdapterVersion: string;
			renderMode: string;
			stylePreset: string;
			theme: Record<string, string>;
			slides: Array<Record<string, unknown>>;
		};
		expect(spec.stylePreset).toBe("editorial");
		expect(spec.nativeAdapterVersion).toBe("octopus-open-design-v2");
		expect(spec.renderMode).toBe("editable");
		expect(spec.theme).toMatchObject({
			background: "#F8F1EB",
			primary: "#C77B6A",
			secondary: "#E8B4A8",
			accent: "#8B9D83",
			text: "#4A4A4A",
			headingFont: "Cambria",
			bodyFont: "Calibri",
		});
		expect(spec.slides.map((slide) => slide.layout)).toEqual([
			"cover",
			"metrics",
			"process",
			"twoColumn",
			"twoColumn",
			"statement",
			"twoColumn",
			"table",
			"iconGrid",
			"closing",
		]);
		expect(spec.slides[7]?.chart).toBeUndefined();
		expect(spec.slides[7]?.table).toMatchObject({
			headers: ["Hormona", "Función", "Pico"],
			rows: [
				["Estrógeno", "Construye el endometrio", "Folicular"],
				["LH", "Dispara la ovulación", "Día 14"],
			],
		});
		expect(spec.slides[7]?.speaker).toMatchObject({
			sources: ["ACOG", "Endocrine Society"],
		});
		expect(
			(spec.slides[8]?.items as Record<string, unknown>[])[0],
		).toMatchObject({
			title: "Mito: La menstruación es sucia",
			description: "Realidad: Es un proceso biológico natural.",
		});
		expect(spec.slides[9]?.title).toBe(
			"Tu ciclo no es una carga: es información.",
		);
	});
});
