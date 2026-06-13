import { describe, expect, it } from "vitest";
import { createShellTool } from "../tools/shell.js";

describe("createShellTool", () => {
	it("rejects cwd outside allowed paths before command execution", async () => {
		const shellTool = createShellTool({
			sandboxCommands: false,
			allowedPaths: ["/safe/root"],
		});

		const result = await shellTool.handler(
			{ command: "node --version", cwd: "/safe/root-evil" },
			{ media: {} as never },
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("outside allowed paths");
	});

	it("filters secret environment variables before command execution", async () => {
		const previous = process.env.OCTOPUS_TEST_API_KEY;
		process.env.OCTOPUS_TEST_API_KEY = "secret-value";
		try {
			const shellTool = createShellTool({ sandboxCommands: false });

			const result = await shellTool.handler(
				{
					command:
						"node -e \"process.stdout.write(process.env.OCTOPUS_TEST_API_KEY || 'missing')\"",
				},
				{ media: {} as never },
			);

			expect(result.success).toBe(true);
			expect(result.output).toBe("missing");
		} finally {
			if (previous === undefined) process.env.OCTOPUS_TEST_API_KEY = undefined;
			else process.env.OCTOPUS_TEST_API_KEY = previous;
		}
	});
});
