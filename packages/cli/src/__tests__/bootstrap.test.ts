import { describe, expect, it } from "vitest";

describe("CLI Bootstrap", () => {
	it("should export bootstrap function", async () => {
		const mod = await import("../bootstrap.js");
		expect(mod.bootstrap).toBeDefined();
		expect(typeof mod.bootstrap).toBe("function");
	}, 15000);

	it("should export OctopusSystem type", async () => {
		const mod = await import("../bootstrap.js");
		expect(mod.bootstrap).toBeDefined();
	}, 15000);
});
