import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactIndex } from "../tools/artifact-index.js";

describe("ArtifactIndex", () => {
	let cacheDir: string;

	beforeEach(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), "octopus-artifact-index-"));
	});

	afterEach(async () => {
		await rm(cacheDir, { recursive: true, force: true });
	});

	it("reuses a persistent SHA-256 index across instances", async () => {
		const units = [
			{ ref: "docx:paragraph:1", text: "Informe financiero anual", page: 1 },
			{ ref: "docx:paragraph:2", text: "Ingresos y costes", page: 1 },
		];
		const first = await new ArtifactIndex({ cacheDir }).index(
			"report.docx",
			units,
		);
		const second = await new ArtifactIndex({ cacheDir }).index(
			"report.docx",
			units,
		);

		expect(first.cacheHit).toBe(false);
		expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(second).toMatchObject({
			cacheHit: true,
			hash: first.hash,
			unitCount: 2,
		});
		expect(
			(await new ArtifactIndex({ cacheDir }).get("report.docx"))?.units,
		).toEqual(units);
	});

	it("invalidates the active index when the structured content hash changes", async () => {
		const index = new ArtifactIndex({ cacheDir });
		const first = await index.index("deck.pptx", [
			{ ref: "pptx:slide:1", text: "Plan confidencial para Marte", slide: 1 },
		]);
		const changed = await index.index("deck.pptx", [
			{ ref: "pptx:slide:1", text: "Plan publico para Venus", slide: 1 },
		]);

		expect(changed.cacheHit).toBe(false);
		expect(changed.hash).not.toBe(first.hash);
		expect(changed.invalidatedHash).toBe(first.hash);
		expect(await index.search("deck.pptx", "Marte")).toEqual([]);
		expect((await index.search("deck.pptx", "Venus"))[0]?.ref).toBe(
			"pptx:slide:1",
		);
	});

	it("combines literal ranking with approximate lexical normalization", async () => {
		const index = new ArtifactIndex({ cacheDir, snippetChars: 80 });
		await index.index("energy.xlsx", [
			{
				ref: "xlsx:sheet:Resumen/row:1",
				text: "La fuente solar renovable alimenta baterias con energia limpia.",
				section: "tecnologia limpia",
			},
			{
				ref: "xlsx:sheet:Resumen/row:2",
				text: "Las baterias industriales almacenan energia de varias fuentes, incluida la solar.",
			},
			{
				ref: "xlsx:sheet:Resumen/row:3",
				text: "La energia solar aparece como frase exacta en este resumen.",
			},
		]);

		const literal = await index.search("energy.xlsx", "energia solar");
		expect(literal[0]).toMatchObject({
			ref: "xlsx:sheet:Resumen/row:3",
			literalMatch: true,
		});
		expect(literal[0]?.score).toBeGreaterThan(literal[1]?.score ?? 0);

		const normalized = await index.search("energy.xlsx", "bateria renovables");
		expect(normalized[0]?.ref).toBe("xlsx:sheet:Resumen/row:1");
		expect(normalized[0]?.matchedTokens.length).toBeGreaterThan(0);
		expect(normalized[0]?.snippet.length).toBeLessThanOrEqual(80);
	});
});
