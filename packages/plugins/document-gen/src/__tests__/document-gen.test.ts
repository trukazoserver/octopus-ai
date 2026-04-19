import { beforeEach, describe, expect, it } from "vitest";
import plugin from "../index.js";

function getCommand(name: string) {
	const cmd = plugin.commands?.find((c) => c.name === name);
	if (!cmd) throw new Error(`Command ${name} not found`);
	return cmd;
}

beforeEach(async () => {
	if (plugin.onLoad) await plugin.onLoad();
});

describe("documentGenPlugin", () => {
	describe("/doc-templates", () => {
		it("should list built-in templates", async () => {
			const cmd = getCommand("/doc-templates");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("[readme]");
			expect(String(result)).toContain("[api-doc]");
			expect(String(result)).toContain("[changelog]");
			expect(String(result)).toContain("[meeting-notes]");
			expect(String(result)).toContain("[proposal]");
		});

		it("should include template descriptions", async () => {
			const cmd = getCommand("/doc-templates");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Standard README.md");
			expect(String(result)).toContain("API endpoint documentation");
		});

		it("should include variable info", async () => {
			const cmd = getCommand("/doc-templates");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("project(MyProject)");
			expect(String(result)).toContain("description(A software project)");
		});
	});

	describe("/doc-generate", () => {
		it("should generate a readme document with provided variables", async () => {
			const cmd = getCommand("/doc-generate");
			const result = await cmd.execute([
				"readme",
				"project=MyApp",
				"description=A test app",
			]);
			expect(String(result)).toContain("# MyApp");
			expect(String(result)).toContain("A test app");
			expect(String(result)).toContain("## Installation");
			expect(String(result)).toContain("## Usage");
		});

		it("should leave unresolved variables as placeholders", async () => {
			const cmd = getCommand("/doc-generate");
			const result = await cmd.execute(["readme"]);
			expect(String(result)).toContain("{{project}}");
			expect(String(result)).toContain("{{description}}");
		});

		it("should return error for unknown template", async () => {
			const cmd = getCommand("/doc-generate");
			const result = await cmd.execute(["nonexistent"]);
			expect(String(result)).toContain("not found");
		});

		it("should return usage when no template name", async () => {
			const cmd = getCommand("/doc-generate");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /doc-generate");
		});

		it("should generate an api-doc template", async () => {
			const cmd = getCommand("/doc-generate");
			const result = await cmd.execute([
				"api-doc",
				"title=Users API",
				"endpoint=/api/users",
				"method=GET",
			]);
			expect(String(result)).toContain("# Users API");
			expect(String(result)).toContain("GET /api/users");
		});

		it("should generate a changelog template", async () => {
			const cmd = getCommand("/doc-generate");
			const result = await cmd.execute([
				"changelog",
				"version=2.0.0",
				"date=2025-01-15",
			]);
			expect(String(result)).toContain("[2.0.0]");
			expect(String(result)).toContain("2025-01-15");
		});
	});

	describe("/doc-custom", () => {
		it("should create a custom template", async () => {
			const cmd = getCommand("/doc-custom");
			const result = await cmd.execute([
				"testtpl",
				"--desc",
				"Test template",
				"--content",
				"Hello {{name}}",
			]);
			expect(String(result)).toContain('Custom template "testtpl" created');
			expect(String(result)).toContain("Test template");
		});

		it("should generate document from custom template", async () => {
			const customCmd = getCommand("/doc-custom");
			await customCmd.execute([
				"greeter",
				"--desc",
				"Greeting",
				"--content",
				"Hi {{name}}, welcome to {{place}}!",
			]);

			const cmd = getCommand("/doc-generate");
			const result = await cmd.execute([
				"greeter",
				"name=Alice",
				"place=Wonderland",
			]);
			expect(String(result)).toContain("Hi Alice, welcome to Wonderland!");
		});

		it("should create template with variables list", async () => {
			const cmd = getCommand("/doc-custom");
			const result = await cmd.execute([
				"varsTpl",
				"--desc",
				"With vars",
				"--vars",
				"title,author,date",
				"--content",
				"# {{title}} by {{author}}",
			]);
			expect(String(result)).toContain("Variables: title, author, date");
		});

		it("should require content", async () => {
			const cmd = getCommand("/doc-custom");
			const result = await cmd.execute(["empty", "--desc", "No content"]);
			expect(String(result)).toContain("Content is required");
		});

		it("should return usage when no name provided", async () => {
			const cmd = getCommand("/doc-custom");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /doc-custom");
		});
	});

	describe("/doc-write", () => {
		it("should write markdown content to a file", async () => {
			const cmd = getCommand("/doc-write");
			const result = await cmd.execute(["test-write.md", "# Hello World"]);
			expect(String(result)).toContain("Document written to");
			expect(String(result)).toContain("13 chars");
		});

		it("should return usage when filename or content missing", async () => {
			const cmd = getCommand("/doc-write");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /doc-write");
		});

		it("should return usage when only filename provided", async () => {
			const cmd = getCommand("/doc-write");
			const result = await cmd.execute(["file.md"]);
			expect(String(result)).toContain("Usage: /doc-write");
		});
	});

	describe("/doc-read", () => {
		it("should read a previously written file", async () => {
			const writeCmd = getCommand("/doc-write");
			await writeCmd.execute(["test-read.md", "# Read Test Content"]);

			const cmd = getCommand("/doc-read");
			const result = await cmd.execute(["test-read.md"]);
			expect(String(result)).toContain("# Read Test Content");
		});

		it("should return error for nonexistent file", async () => {
			const cmd = getCommand("/doc-read");
			const result = await cmd.execute(["nonexistent-file.md"]);
			expect(String(result)).toContain("File not found");
		});

		it("should return usage when no filepath provided", async () => {
			const cmd = getCommand("/doc-read");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /doc-read");
		});

		it("should read content matching what was written", async () => {
			const writeCmd = getCommand("/doc-write");
			const longContent =
				"# Title\n\nParagraph with **bold** and *italic*.\n\n- Item 1\n- Item 2";
			await writeCmd.execute(["match-test.md", longContent]);

			const cmd = getCommand("/doc-read");
			const result = await cmd.execute(["match-test.md"]);
			expect(String(result)).toContain("# Title");
			expect(String(result)).toContain("**bold**");
			expect(String(result)).toContain("- Item 1");
		});
	});
});
