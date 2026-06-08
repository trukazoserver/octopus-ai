import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileSystemTools } from "../tools/filesystem.js";

describe("filesystem tools", () => {
	it("blocks sibling paths that only share an allowed path prefix", async () => {
		const allowedPath = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-fs-allowed-${Date.now()}`,
		);
		const siblingPath = `${allowedPath}-evil`;
		const tools = createFileSystemTools([allowedPath]);
		const listTool = tools.find((tool) => tool.name === "list_directory");

		expect(listTool).toBeDefined();
		const result = await listTool?.handler({ path: siblingPath });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Access denied");
	});
});
