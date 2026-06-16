import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserTool } from "../tools/browser.js";

describe("BrowserTool local file preview", () => {
	let tempDir: string;
	let htmlPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "octopus-browser-"));
		htmlPath = path.join(tempDir, "preview page.html");
		fs.writeFileSync(htmlPath, "<html><title>Preview</title><body>Hero</body></html>");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function createOpenFileTool(pageUrlAfterGoto?: string) {
		let currentUrl = "about:blank";
		const page = {
			goto: vi.fn(async (url: string) => {
				currentUrl = pageUrlAfterGoto ?? url;
			}),
			title: vi.fn(async () => "Preview"),
			url: vi.fn(() => currentUrl),
		};
		const browser = new BrowserTool({ humanBehavior: false });
		const browserInternals = browser as unknown as {
			init: () => Promise<void>;
			page: typeof page;
			buildSnapshotWithUidMap: () => Promise<{ output: string }>;
		};
		browserInternals.init = vi.fn(async () => {});
		browserInternals.page = page;
		browserInternals.buildSnapshotWithUidMap = vi.fn(async () => ({
			output: "Hero",
		}));
		const tool = browser
			.createTools()
			.find((candidate) => candidate.name === "browser_open_file");
		expect(tool).toBeDefined();
		return { tool: tool!, page };
	}

	it("opens an existing local file with a file URL", async () => {
		const { tool, page } = createOpenFileTool();

		const result = await tool.handler({ path: htmlPath }, {} as never);

		expect(result.success).toBe(true);
		expect(page.goto).toHaveBeenCalledWith(pathToFileURL(htmlPath).href, {
			waitUntil: "load",
			timeout: 30000,
		});
		expect(result.output).toContain("Current URL: file:///");
		expect(result.output).toContain("Hero");
	});

	it("does not report success when local file navigation stays at about:blank", async () => {
		const { tool } = createOpenFileTool("about:blank");

		const result = await tool.handler({ path: htmlPath }, {} as never);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Local file did not load");
	});

	it("rejects file URLs passed instead of file paths", async () => {
		const { tool, page } = createOpenFileTool();

		const result = await tool.handler(
			{ path: pathToFileURL(htmlPath).href },
			{} as never,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Pass the local file path as-is");
		expect(page.goto).not.toHaveBeenCalled();
	});

	it("rejects file URLs in browser_navigate before initializing the browser", async () => {
		const browser = new BrowserTool({ humanBehavior: false });
		const browserInternals = browser as unknown as {
			init: () => Promise<void>;
		};
		browserInternals.init = vi.fn(async () => {});
		const tool = browser
			.createTools()
			.find((candidate) => candidate.name === "browser_navigate");
		expect(tool).toBeDefined();

		const result = await tool!.handler(
			{ url: pathToFileURL(htmlPath).href },
			{} as never,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("browser_open_file");
		expect(browserInternals.init).not.toHaveBeenCalled();
	});
});
