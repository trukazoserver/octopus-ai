import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRealPathInside, expandHome } from "../utils/path-safety.js";

describe("expandHome", () => {
	it("expands ~ and ~/ to the home directory", () => {
		expect(expandHome("~")).toBe(os.homedir());
		expect(expandHome("~/Documents")).toBe(
			path.join(os.homedir(), "Documents"),
		);
		expect(expandHome("/abs/path")).toBe("/abs/path");
		expect(expandHome("relative/path")).toBe("relative/path");
	});
});

describe("assertRealPathInside ~ expansion in allowedRoots", () => {
	it("expands ~/ roots so paths under them are allowed and siblings rejected", async () => {
		const home = os.homedir();
		const root = "~/octopus-tilde-root";
		const inside = path.join(home, "octopus-tilde-root", "file.txt");
		const sibling = path.join(home, "octopus-tilde-other", "file.txt");

		await expect(assertRealPathInside(inside, [root])).resolves.toBeUndefined();
		await expect(assertRealPathInside(sibling, [root])).rejects.toThrow(
			/outside the allowed paths/,
		);
	});
});
