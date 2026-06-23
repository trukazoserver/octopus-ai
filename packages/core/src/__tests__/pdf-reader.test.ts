import { describe, expect, it } from "vitest";
import { PdfReader } from "../tools/pdf-reader.js";

describe("PdfReader", () => {
	it("exposes a pdf_read tool definition", () => {
		const reader = new PdfReader();
		const tools = reader.createTools();
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("pdf_read");
		expect(tools[0].parameters.source.required).toBe(true);
	});

	it("requires a source parameter", async () => {
		const reader = new PdfReader();
		const tool = reader.createTools()[0];
		const result = await tool.handler({ source: "" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/source/i);
	});

	it("rejects local paths outside the allowed roots", async () => {
		const reader = new PdfReader({
			allowedLocalRoots: ["/definitely-not-a-real-root"],
		});
		await expect(reader.loadSource("some/local/file.pdf")).rejects.toThrow(
			/outside the allowed roots/i,
		);
	});

	it("rejects non-http(s) remote-looking sources via the URL policy", async () => {
		const reader = new PdfReader();
		// "file:" is not an allowed protocol for the download path.
		await expect(reader.loadSource("file:///etc/passwd")).rejects.toThrow();
	});
});
