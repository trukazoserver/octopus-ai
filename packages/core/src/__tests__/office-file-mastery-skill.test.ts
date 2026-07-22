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
});
