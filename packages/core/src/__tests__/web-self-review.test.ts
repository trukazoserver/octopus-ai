import { describe, expect, it } from "vitest";
import {
	WEB_SELF_REVIEW_SKILL_ID,
	buildWebSelfReviewSkill,
} from "../skills/builtin/web-self-review.js";
import { SkillRegistry } from "../skills/registry.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

const embedFn = async (text: string): Promise<number[]> => {
	const vec = new Array(16).fill(0);
	for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
		let hash = 0;
		for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
		vec[Math.abs(hash) % vec.length] += 1;
	}
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
	return norm > 0 ? vec.map((v) => v / norm) : vec;
};

describe("web-self-review built-in skill", () => {
	it("builds a valid skill with the visual-QA loop + web triggers", () => {
		const skill = buildWebSelfReviewSkill(new Array(16).fill(0));
		expect(skill.id).toBe(WEB_SELF_REVIEW_SKILL_ID);
		expect(skill.name).toBe("web-self-review");
		expect(skill.instructions).toMatch(/browser_open_file/);
		expect(skill.instructions).toMatch(/browser_screenshot/);
		expect(skill.instructions).toMatch(/analyze_image/);
		// The "don't claim done until seen" rule is present.
		expect(skill.instructions).toMatch(/SEEN it render|seen it render/i);
		// Triggers on web terms (EN + ES).
		expect(skill.triggerConditions.keywords).toEqual(
			expect.arrayContaining(["website", "html", "boda", "invitacion"]),
		);
	});

	it("seeds into the registry and is retrievable (idempotent upsert)", async () => {
		const db: DatabaseAdapter = createDatabaseAdapter("sqlite", {
			path: ":memory:",
		});
		await db.initialize();
		const registry = new SkillRegistry(db, embedFn);

		await registry.save(
			buildWebSelfReviewSkill(
				await embedFn("web self-review screenshot vision"),
			),
		);
		// Re-saving (idempotent) must not duplicate.
		await registry.save(
			buildWebSelfReviewSkill(
				await embedFn("web self-review screenshot vision"),
			),
		);

		const byId = await registry.getById(WEB_SELF_REVIEW_SKILL_ID);
		expect(byId?.id).toBe(WEB_SELF_REVIEW_SKILL_ID);
		expect(byId?.instructions).toMatch(/browser_screenshot/);

		await db.close();
	});
});
