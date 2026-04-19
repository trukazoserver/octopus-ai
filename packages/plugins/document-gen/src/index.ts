import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@octopus-ai/core";

const DOCS_DIR = join(process.cwd(), ".docs");

interface TemplateVar {
	key: string;
	description: string;
	default: string;
}

interface DocTemplate {
	name: string;
	description: string;
	content: string;
	variables: TemplateVar[];
}

async function ensureDir(): Promise<void> {
	try {
		await mkdir(DOCS_DIR, { recursive: true });
	} catch {}
}

function resolveVars(content: string, varArgs: string[]): string {
	const varMap: Record<string, string> = {};
	for (const v of varArgs) {
		const eqIdx = v.indexOf("=");
		if (eqIdx !== -1) {
			const key = v.slice(0, eqIdx);
			const value = v.slice(eqIdx + 1);
			varMap[key] = value;
		}
	}
	return content.replace(
		/\{\{(\w+)\}\}/g,
		(_, key) => varMap[key] ?? `{{${key}}}`,
	);
}

const templates: Map<string, DocTemplate> = new Map();

function registerBuiltInTemplates(): void {
	templates.set("readme", {
		name: "readme",
		description: "Standard README.md for a software project",
		variables: [
			{ key: "project", description: "Project name", default: "MyProject" },
			{
				key: "description",
				description: "Short description",
				default: "A software project",
			},
			{
				key: "install",
				description: "Install command",
				default: "npm install",
			},
			{ key: "usage", description: "Usage instructions", default: "npm start" },
		],
		content: `# {{project}}

{{description}}

## Installation

\`\`\`bash
{{install}}
\`\`\`

## Usage

\`\`\`bash
{{usage}}
\`\`\`

## Features

- Feature 1
- Feature 2
- Feature 3

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## License

MIT
`,
	});

	templates.set("api-doc", {
		name: "api-doc",
		description: "API endpoint documentation",
		variables: [
			{
				key: "title",
				description: "API section title",
				default: "API Reference",
			},
			{
				key: "endpoint",
				description: "API endpoint",
				default: "/api/resource",
			},
			{ key: "method", description: "HTTP method", default: "GET" },
			{
				key: "description",
				description: "Endpoint description",
				default: "Retrieve resources",
			},
		],
		content: `# {{title}}

## {{method}} {{endpoint}}

{{description}}

### Request

\`\`\`
{{method}} {{endpoint}}
Content-Type: application/json
\`\`\`

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id    | string | Yes | Resource ID |
| name  | string | Yes | Resource name |

### Response

\`\`\`json
{
  "success": true,
  "data": {}
}
\`\`\`

### Status Codes

| Code | Description |
|------|-------------|
| 200  | Success |
| 400  | Bad Request |
| 401  | Unauthorized |
| 404  | Not Found |
| 500  | Internal Server Error |
`,
	});

	templates.set("changelog", {
		name: "changelog",
		description: "Changelog document following Keep a Changelog format",
		variables: [
			{ key: "version", description: "Version number", default: "1.0.0" },
			{
				key: "date",
				description: "Release date",
				default: new Date().toISOString().split("T")[0],
			},
		],
		content: `# Changelog

## [{{version}}] - {{date}}

### Added
- Initial release

### Changed
-

### Deprecated
-

### Removed
-

### Fixed
-

### Security
-
`,
	});

	templates.set("meeting-notes", {
		name: "meeting-notes",
		description: "Meeting notes template",
		variables: [
			{ key: "title", description: "Meeting title", default: "Team Meeting" },
			{
				key: "date",
				description: "Meeting date",
				default: new Date().toISOString().split("T")[0],
			},
			{
				key: "attendees",
				description: "Attendee names",
				default: "Team members",
			},
		],
		content: `# Meeting Notes: {{title}}

**Date:** {{date}}
**Attendees:** {{attendees}}

## Agenda

1. Topic 1
2. Topic 2
3. Topic 3

## Discussion

### Topic 1

-

### Topic 2

-

### Topic 3

-

## Action Items

- [ ] Action item 1 (@assignee)
- [ ] Action item 2 (@assignee)
- [ ] Action item 3 (@assignee)

## Next Meeting

Date:
Topics:
`,
	});

	templates.set("proposal", {
		name: "proposal",
		description: "Project proposal template",
		variables: [
			{
				key: "title",
				description: "Project title",
				default: "Project Proposal",
			},
			{ key: "author", description: "Author name", default: "Author" },
			{
				key: "date",
				description: "Proposal date",
				default: new Date().toISOString().split("T")[0],
			},
		],
		content: `# {{title}}

**Author:** {{author}}
**Date:** {{date}}

## Summary

Brief summary of the proposal.

## Problem Statement

What problem are we solving?

## Proposed Solution

How will we solve it?

## Implementation Plan

### Phase 1
- Duration:
- Deliverables:

### Phase 2
- Duration:
- Deliverables:

### Phase 3
- Duration:
- Deliverables:

## Resource Requirements

- Personnel:
- Budget:
- Tools/Infrastructure:

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Risk 1 | Low | High | Mitigation strategy |

## Success Criteria

- Criterion 1
- Criterion 2
- Criterion 3

## Timeline

| Milestone | Target Date | Status |
|-----------|------------|--------|
| Start | - | Pending |
| Phase 1 Complete | - | Pending |
| Final Delivery | - | Pending |
`,
	});
}

function markdownToHtml(markdown: string): string {
	let html = markdown;
	html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
	html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
	html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
	html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(
		/^- \[x\] (.+)$/gm,
		'<li><input type="checkbox" checked disabled> $1</li>',
	);
	html = html.replace(
		/^- \[ \] (.+)$/gm,
		'<li><input type="checkbox" disabled> $1</li>',
	);
	html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
	html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
	html = html.replace(/^---$/gm, "<hr>");
	html = html.replace(/\n{2,}/g, "\n<br><br>\n");
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Document</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
    h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
    h2 { border-bottom: 1px solid #eee; padding-bottom: 8px; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }
    li { margin: 4px 0; }
    hr { border: none; border-top: 1px solid #eee; margin: 24px 0; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f8f8f8; }
  </style>
</head>
<body>
${html}
</body>
</html>`;
}

const plugin: Plugin = {
	manifest: {
		name: "document-gen",
		version: "1.0.0",
		description:
			"Document generation with templates, Markdown/HTML export, and custom template creation",
		author: "OctopusTeam",
	},
	commands: [
		{
			name: "/doc-templates",
			description: "List available document templates. Usage: /doc-templates",
			execute: async () => {
				if (templates.size === 0) return "No templates available.";
				return Array.from(templates.values())
					.map(
						(t) =>
							`[${t.name}] ${t.description}\n  Variables: ${t.variables.map((v) => `${v.key}(${v.default})`).join(", ")}`,
					)
					.join("\n\n");
			},
		},
		{
			name: "/doc-generate",
			description:
				"Generate a document from a template. Usage: /doc-generate <template> key1=val1 key2=val2 [--save <filename>]",
			execute: async (args: string[]) => {
				const templateName = args[0];
				if (!templateName)
					return "Usage: /doc-generate <template> key1=val1 key2=val2 [--save <filename>]";

				const template = templates.get(templateName);
				if (!template)
					return `Template "${templateName}" not found. Use /doc-templates to list available templates.`;

				const rest = args.slice(1);
				const saveIdx = rest.indexOf("--save");
				const varArgs = saveIdx === -1 ? rest : rest.slice(0, saveIdx);

				const content = resolveVars(template.content, varArgs);

				if (saveIdx !== -1 && rest[saveIdx + 1]) {
					await ensureDir();
					const filename = rest[saveIdx + 1];
					const fullPath =
						filename.includes(":") || filename.startsWith("/")
							? filename
							: join(DOCS_DIR, filename);
					await writeFile(fullPath, content, "utf-8");
					return `Document generated from "${templateName}" template and saved to ${fullPath}`;
				}

				const truncated = content.length > 3000;
				return `Generated Document (${templateName}):\n\n${truncated ? content.slice(0, 3000) : content}${truncated ? "\n\n... truncated. Use --save <filename> to save full document." : ""}`;
			},
		},
		{
			name: "/doc-html",
			description:
				"Convert markdown to HTML. Usage: /doc-html <markdown-file-or-text> [--save <filename>]",
			execute: async (args: string[]) => {
				const input = args[0];
				if (!input)
					return "Usage: /doc-html <markdown-file-or-text> [--save <filename>]";

				const rest = args.slice(1);
				const saveIdx = rest.indexOf("--save");
				let fullInput = args.join(" ");

				try {
					const content = await readFile(input, "utf-8");
					fullInput = content;
				} catch {
					fullInput = args
						.filter((a) => a !== "--save" && a !== rest[saveIdx + 1])
						.join(" ");
				}

				const html = markdownToHtml(fullInput);

				if (saveIdx !== -1 && rest[saveIdx + 1]) {
					await ensureDir();
					const filename = rest[saveIdx + 1];
					const fullPath =
						filename.includes(":") || filename.startsWith("/")
							? filename
							: join(DOCS_DIR, filename);
					await writeFile(fullPath, html, "utf-8");
					return `HTML document saved to ${fullPath}`;
				}

				return html.length > 3000
					? `${html.slice(0, 3000)}\n\n... truncated. Use --save <filename> to save full HTML.`
					: html;
			},
		},
		{
			name: "/doc-custom",
			description:
				"Create a custom template. Usage: /doc-custom <name> --desc <description> --vars key1,key2 --content <markdown-content>",
			execute: async (args: string[]) => {
				const name = args[0];
				if (!name)
					return "Usage: /doc-custom <name> --desc <description> --vars key1,key2 --content <markdown-content>";

				const descIdx = args.indexOf("--desc");
				const varsIdx = args.indexOf("--vars");
				const contentIdx = args.indexOf("--content");

				const description =
					descIdx !== -1 && args[descIdx + 1]
						? args[descIdx + 1]
						: "Custom template";
				const varKeys =
					varsIdx !== -1 && args[varsIdx + 1]
						? args[varsIdx + 1].split(",")
						: [];
				const content =
					contentIdx !== -1 && args[contentIdx + 1]
						? args.slice(contentIdx + 1).join(" ")
						: "";

				if (!content)
					return "Content is required. Use --content <markdown-with-{{variables}}>";

				const variables: TemplateVar[] = varKeys.map((key) => ({
					key: key.trim(),
					description: `Variable: ${key.trim()}`,
					default: `{{${key.trim()}}}`,
				}));

				templates.set(name, { name, description, content, variables });

				return `Custom template "${name}" created.\nDescription: ${description}\nVariables: ${variables.map((v) => v.key).join(", ") || "none"}\nUse: /doc-generate ${name} ${variables.map((v) => `${v.key}=value`).join(" ")}`;
			},
		},
		{
			name: "/doc-write",
			description:
				"Write raw markdown content to a file. Usage: /doc-write <filename> <markdown-content>",
			execute: async (args: string[]) => {
				const filename = args[0];
				const content = args.slice(1).join(" ").trim();
				if (!filename || !content)
					return "Usage: /doc-write <filename> <markdown-content>";
				await ensureDir();
				const fullPath =
					filename.includes(":") || filename.startsWith("/")
						? filename
						: join(DOCS_DIR, filename);
				await writeFile(fullPath, content, "utf-8");
				return `Document written to ${fullPath} (${content.length} chars)`;
			},
		},
		{
			name: "/doc-read",
			description: "Read a document file. Usage: /doc-read <filepath>",
			execute: async (args: string[]) => {
				const filepath = args[0];
				if (!filepath) return "Usage: /doc-read <filepath>";
				try {
					const fullPath =
						filepath.includes(":") || filepath.startsWith("/")
							? filepath
							: join(DOCS_DIR, filepath);
					const content = await readFile(fullPath, "utf-8");
					return content.length > 3000
						? `${content.slice(0, 3000)}\n\n... truncated (${content.length} total chars)`
						: content;
				} catch {
					return `File not found: ${filepath}`;
				}
			},
		},
	],
	onLoad: async () => {
		await ensureDir();
		registerBuiltInTemplates();
	},
};

export default plugin;
