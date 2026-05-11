import { afterEach, describe, expect, it } from "vitest";
import { LearningEngine } from "../learning/engine.js";
import { createDatabaseAdapter, type DatabaseAdapter } from "../storage/database.js";

const embedFn = async (text: string): Promise<number[]> => {
	const vec = new Array(16).fill(0);
	for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
		let hash = 0;
		for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
		vec[Math.abs(hash) % vec.length] += 1;
	}
	const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
	return norm > 0 ? vec.map((value) => value / norm) : vec;
};

describe("LearningEngine", () => {
	let db: DatabaseAdapter | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
	});

	async function createEngine(config = {}) {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const engine = new LearningEngine(db, embedFn, {
			config: { autoReflect: false, ...config },
		});
		await engine.initialize();
		return engine;
	}

	it("stores successful experiences and actionable insights", async () => {
		const engine = await createEngine();

		const experience = await engine.recordExperience({
			userRequest: "Extract product images from Etsy page",
			finalResponse: "Completed successfully. Used browser_extract_images and returned the product image URLs.",
			toolsUsed: [
				{ name: "browser_extract_images", success: true, summary: "found 5 image URLs" },
			],
		});

		expect(experience.status).toBe("succeeded");
		const insights = await engine.listInsights({ limit: 10 });
		expect(insights.length).toBeGreaterThan(0);
		expect(insights.some((insight) => insight.type === "procedure")).toBe(true);
		expect(insights.some((insight) => insight.type === "tool_strategy")).toBe(true);
	});

	it("does not store insights below the confidence threshold", async () => {
		const engine = await createEngine({ minConfidenceToStore: 0.9 });

		await engine.recordExperience({
			userRequest: "Do something vague",
			finalResponse: "Maybe done.",
			confidence: 0.4,
		});

		const insights = await engine.listInsights({ limit: 10 });
		expect(insights).toHaveLength(0);
	});

	it("retrieves relevant learning guidance", async () => {
		const engine = await createEngine();
		await engine.recordExperience({
			userRequest: "Extract product images from Etsy page",
			finalResponse: "Completed successfully using browser_extract_images before clicking thumbnails.",
			confidence: 0.9,
			toolsUsed: [{ name: "browser_extract_images", success: true }],
		});

		const relevant = await engine.retrieveRelevant("Need Etsy product images");
		expect(relevant.length).toBeGreaterThan(0);
		expect(relevant.map((item) => item.content).join("\n")).toContain("browser_extract_images");
	});

	it("records feedback against the latest conversation experience", async () => {
		const engine = await createEngine();
		const experience = await engine.recordExperience({
			conversationId: "conv-1",
			userRequest: "Summarize this",
			finalResponse: "Completed successfully with a concise summary.",
		});

		await engine.addFeedback({ conversationId: "conv-1", rating: "negative", comment: "Wrong focus" });
		const row = await db?.get<{ status: string; metadata: string }>("SELECT status, metadata FROM experiences WHERE id = ?", [experience.id]);
		expect(row?.status).toBe("failed");
		expect(row?.metadata).toContain("Wrong focus");
	});
});
