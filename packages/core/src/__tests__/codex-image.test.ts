import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub ConfigLoader so the tool believes it has a valid Codex login without
// touching the real config file.
vi.mock("../config/loader.js", () => ({
	ConfigLoader: class {
		load() {
			return {
				ai: {
					providers: {
						openai: {
							accessToken: "test-token",
							accountId: "acct-1",
							authMode: "codex",
						},
					},
				},
			};
		}
	},
}));

const WORKSPACE = join(homedir(), ".octopus", "workspace");
const TEST_SUB = "__codex_image_test__";

describe("codex_generate_image workspace-path save", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		// Mock the Codex image endpoint to return one tiny base64 image.
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers(),
			text: async () => "",
			json: async () => ({
				data: [{ b64_json: Buffer.from("fake-png-bytes").toString("base64") }],
			}),
		})) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(join(WORKSPACE, TEST_SUB), { recursive: true, force: true });
	});

	it("saves the image into the workspace and returns a relative path (no base64)", async () => {
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const res = await tool.handler({
			prompt: "hero image",
			path: `${TEST_SUB}/hero.png`,
		});

		expect(res.success).toBe(true);
		// Returned a workspace-relative path with forward slashes...
		expect(res.output).toContain(`${TEST_SUB}/hero.png`);
		// ...and never leaked the base64 payload.
		expect(res.output).not.toContain("base64");
		// The file actually landed next to where an HTML would be written.
		expect(existsSync(join(WORKSPACE, TEST_SUB, "hero.png"))).toBe(true);
	});

	it("rejects a destination path that escapes the workspace", async () => {
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const res = await tool.handler({
			prompt: "x",
			path: "../../etc/evil.png",
		});

		expect(res.success).toBe(false);
		expect(res.error ?? "").toMatch(/escapes the Octopus workspace/i);
		expect(existsSync(join(WORKSPACE, "..", "etc", "evil.png"))).toBe(false);
	});
});
