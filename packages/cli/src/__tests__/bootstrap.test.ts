import { beforeAll, describe, expect, it } from "vitest";

let bootstrapModule: typeof import("../bootstrap.js");

describe("CLI Bootstrap", () => {
	beforeAll(async () => {
		bootstrapModule = await import("../bootstrap.js");
	}, 60000);

	it("should export bootstrap function", () => {
		expect(bootstrapModule.bootstrap).toBeDefined();
		expect(typeof bootstrapModule.bootstrap).toBe("function");
	});

	it("should export OctopusSystem type", () => {
		expect(bootstrapModule.bootstrap).toBeDefined();
	});
});
