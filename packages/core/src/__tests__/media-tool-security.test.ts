import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createMediaTools, mediaContext } from "../tools/media.js";

describe("media tool security", () => {
	it("blocks traversal when resolving media URLs", async () => {
		await expect(
			mediaContext.resolve("/api/media/file/../config.json"),
		).rejects.toThrow("path safety policy");
	});

	it("blocks imports from sibling paths that only share an allowed prefix", async () => {
		const allowedPath = path.join(process.cwd(), "octopus-media-allowed");
		const siblingPath = `${allowedPath}-evil/image.png`;
		const importTool = createMediaTools([allowedPath]).find(
			(tool) => tool.name === "import_media_file",
		);

		expect(importTool).toBeDefined();
		const result = await importTool?.handler({ path: siblingPath });

		expect(result?.success).toBe(false);
		expect(result?.error).toContain("outside allowed paths");
	});
});
