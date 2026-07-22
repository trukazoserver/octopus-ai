import { describe, expect, it } from "vitest";
import {
	OFFICE_FILE_MASTERY_SKILL_IDS,
	buildOfficeFileMasterySkills,
	officeFileMasteryEmbeddingTexts,
} from "../skills/builtin/office-file-mastery.js";

describe("office file mastery builtin skills", () => {
	it("builds one high-quality skill per supported file workflow", () => {
		const embeddings = Object.fromEntries(
			officeFileMasteryEmbeddingTexts().map(({ id }) => [id, [1, 0, 0]]),
		);
		const skills = buildOfficeFileMasterySkills(embeddings);

		expect(skills.map((skill) => skill.id)).toEqual([
			...OFFICE_FILE_MASTERY_SKILL_IDS,
		]);
		expect(skills).toHaveLength(5);
		for (const skill of skills) {
			expect(skill.instructions.length).toBeGreaterThan(1000);
			expect(skill.description).toMatch(/Use whenever/i);
			expect(skill.quality).toEqual({ completeness: 1, accuracy: 1, clarity: 1 });
			expect(skill.dependencies.length).toBeGreaterThan(0);
		}
	});

	it("requires research, visual direction, layout diversity, and rendered QA", () => {
		const embeddings = Object.fromEntries(
			officeFileMasteryEmbeddingTexts().map(({ id }) => [id, [1, 0, 0]]),
		);
		const skills = buildOfficeFileMasterySkills(embeddings);
		const presentation = skills.find(
			(skill) => skill.id === "builtin:presentation-mastery",
		);

		expect(presentation?.instructions).toMatch(/source mode/i);
		expect(presentation?.instructions).toMatch(/source manifest/i);
		expect(presentation?.instructions).toMatch(/visual system/i);
		expect(presentation?.instructions).toMatch(/palette roles with HEX/i);
		expect(presentation?.instructions).toMatch(/at least three reusable layout families/i);
		expect(presentation?.instructions).toContain("designBrief");
		expect(presentation?.instructions).toContain("office_inspect");
		expect(presentation?.instructions).toMatch(/render every slide/i);
		expect(presentation?.instructions).toMatch(/text-only/i);
		expect(presentation?.instructions).toMatch(/traceable sources/i);
	});
});
