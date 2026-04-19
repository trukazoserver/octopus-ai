import { describe, expect, it } from "vitest";
import { SecurityAuditor } from "../utils/security-audit.js";

describe("SecurityAuditor", () => {
	it("should run full audit and return results", async () => {
		const auditor = new SecurityAuditor();
		const result = await auditor.runAudit();

		expect(result).toHaveProperty("passed");
		expect(result).toHaveProperty("checks");
		expect(result).toHaveProperty("summary");
		expect(result.checks.length).toBeGreaterThan(0);
	});

	it("should include password hashing check", async () => {
		const auditor = new SecurityAuditor();
		const result = await auditor.runAudit();
		const hashCheck = result.checks.find((c) => c.name === "Password Hashing");
		expect(hashCheck).toBeDefined();
		expect(hashCheck?.status).toBe("pass");
	});

	it("should include encryption round-trip check", async () => {
		const auditor = new SecurityAuditor();
		const result = await auditor.runAudit();
		const encCheck = result.checks.find(
			(c) => c.name === "Encryption Round-Trip",
		);
		expect(encCheck).toBeDefined();
		expect(encCheck?.status).toBe("pass");
	});

	it("should include encryption key check", async () => {
		const auditor = new SecurityAuditor();
		const result = await auditor.runAudit();
		const keyCheck = result.checks.find((c) => c.name === "Encryption Key");
		expect(keyCheck).toBeDefined();
		expect(keyCheck?.status).toBe("pass");
	});
});
