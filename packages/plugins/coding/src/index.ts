import type { Plugin } from "@octopus-ai/core";

const plugin: Plugin = {
	manifest: {
		name: "coding",
		version: "1.0.0",
		description: "Code analysis, refactoring, generation, and debugging tools",
		author: "OctopusTeam",
	},
	commands: [
		{
			name: "/refactor",
			description:
				"Analyze code and suggest refactoring improvements. Usage: /refactor <code or file path>",
			execute: async (args: string[]) => {
				const input = args.join(" ").trim();
				if (!input) {
					return "Please provide code or a file path to refactor.\nUsage: /refactor <code>";
				}

				const analysis = analyzeCode(input);
				const suggestions = generateRefactorSuggestions(input, analysis);

				let output = "# Code Analysis\n\n";
				output += `**Lines:** ${analysis.lines} | **Functions:** ${analysis.functions} | **Complexity:** ${analysis.complexity}\n\n`;

				if (suggestions.length > 0) {
					output += "## Refactoring Suggestions\n\n";
					for (const s of suggestions) {
						output += `- **${s.type}**: ${s.description}\n`;
					}
				} else {
					output += "Code looks clean! No major refactoring suggestions.";
				}

				return output;
			},
		},
		{
			name: "/analyze",
			description:
				"Analyze code for bugs, style issues, and improvements. Usage: /analyze <code>",
			execute: async (args: string[]) => {
				const code = args.join(" ").trim();
				if (!code) {
					return "Please provide code to analyze.\nUsage: /analyze <code>";
				}

				const issues = findIssues(code);
				const metrics = calculateMetrics(code);

				let output = "# Code Analysis Report\n\n";
				output += "## Metrics\n";
				output += `- Lines: ${metrics.lines}\n`;
				output += `- Characters: ${metrics.characters}\n`;
				output += `- Functions: ${metrics.functions}\n`;
				output += `- Classes: ${metrics.classes}\n`;
				output += `- Comments: ${metrics.comments}\n\n`;

				if (issues.length > 0) {
					output += `## Issues Found (${issues.length})\n\n`;
					for (const issue of issues) {
						output += `- [${issue.severity}] **Line ${issue.line}**: ${issue.message}\n`;
					}
				} else {
					output += "No issues found! Code looks good.";
				}

				return output;
			},
		},
		{
			name: "/debug",
			description:
				"Analyze code for common bugs and errors. Usage: /debug <code>",
			execute: async (args: string[]) => {
				const code = args.join(" ").trim();
				if (!code) {
					return "Please provide code to debug.\nUsage: /debug <code>";
				}

				const bugs = findBugs(code);

				if (bugs.length === 0) {
					return "# Debug Report\n\nNo obvious bugs found. The code appears correct.";
				}

				let output = `# Debug Report\n\n${bugs.length} potential issue(s) found:\n\n`;
				for (const bug of bugs) {
					output += `## ${bug.type}\n`;
					output += `**Severity:** ${bug.severity}\n`;
					output += `**Location:** ${bug.location}\n`;
					output += `**Description:** ${bug.description}\n`;
					output += `**Fix:** ${bug.fix}\n\n`;
				}

				return output;
			},
		},
		{
			name: "/explain",
			description: "Explain what a piece of code does. Usage: /explain <code>",
			execute: async (args: string[]) => {
				const code = args.join(" ").trim();
				if (!code) {
					return "Please provide code to explain.\nUsage: /explain <code>";
				}

				const analysis = analyzeCode(code);
				const parts = extractCodeParts(code);

				let output = "# Code Explanation\n\n";
				output += "## Overview\n";
				output += `This code contains ${parts.length} main part(s) with ${analysis.functions} function(s) and ${analysis.complexity} control structure(s).\n\n`;

				for (const part of parts) {
					output += `## \`${part.name}\` (${part.type})\n`;
					output += `${part.description}\n\n`;
				}

				return output;
			},
		},
	],
	onLoad: async () => {},
};

interface CodeAnalysis {
	lines: number;
	functions: number;
	classes: number;
	complexity: number;
	imports: string[];
}

function analyzeCode(code: string): CodeAnalysis {
	const lines = code.split("\n");
	const functionMatches =
		code.match(
			/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(?:async\s+)?(?:\w+)\s*\([^)]*\)\s*{)/g,
		) ?? [];
	const classMatches = code.match(/class\s+\w+/g) ?? [];
	const importMatches =
		code.match(/(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g) ?? [];
	const complexityMarkers =
		code.match(/(?:if|else|for|while|switch|case|try|catch|&&|\|\||\.?\?)/g) ??
		[];

	return {
		lines: lines.length,
		functions: functionMatches.length,
		classes: classMatches.length,
		complexity: complexityMarkers.length,
		imports: importMatches,
	};
}

function generateRefactorSuggestions(
	code: string,
	analysis: CodeAnalysis,
): Array<{ type: string; description: string }> {
	const suggestions: Array<{ type: string; description: string }> = [];

	if (analysis.lines > 50 && analysis.functions <= 1) {
		suggestions.push({
			type: "Extract Function",
			description:
				"This code block is long. Consider breaking it into smaller, focused functions.",
		});
	}

	if (analysis.complexity > 10) {
		suggestions.push({
			type: "Reduce Complexity",
			description:
				"High cyclomatic complexity detected. Consider simplifying conditional logic or using early returns.",
		});
	}

	const magicNumbers = code.match(/(?<![a-zA-Z_])\d{2,}(?![a-zA-Z_])/g);
	if (magicNumbers && magicNumbers.length > 2) {
		suggestions.push({
			type: "Magic Numbers",
			description: `Found ${magicNumbers.length} numeric literals. Consider extracting them into named constants.`,
		});
	}

	const duplicateStrings = findDuplicateStrings(code);
	if (duplicateStrings.length > 0) {
		suggestions.push({
			type: "DRY Violation",
			description: `Repeated string literals found: "${duplicateStrings.slice(0, 3).join('", "')}". Extract to constants.`,
		});
	}

	const deepNesting = countMaxNesting(code);
	if (deepNesting > 3) {
		suggestions.push({
			type: "Deep Nesting",
			description: `Maximum nesting depth is ${deepNesting}. Consider using guard clauses or extracting logic.`,
		});
	}

	if (code.includes("console.log") && !code.includes("test")) {
		suggestions.push({
			type: "Console Statements",
			description:
				"Remove console.log statements from production code. Use a proper logging library.",
		});
	}

	return suggestions;
}

function findIssues(
	code: string,
): Array<{ severity: string; line: number; message: string }> {
	const issues: Array<{ severity: string; line: number; message: string }> = [];
	const lines = code.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		if (line?.includes("==") && !line.includes("===")) {
			issues.push({
				severity: "warning",
				line: lineNum,
				message: "Use strict equality (===) instead of loose equality (==)",
			});
		}

		if (line?.includes("var ")) {
			issues.push({
				severity: "info",
				line: lineNum,
				message: "Use 'const' or 'let' instead of 'var'",
			});
		}

		if (line?.includes("eval(")) {
			issues.push({
				severity: "error",
				line: lineNum,
				message: "Avoid eval() - it's a security risk and performance issue",
			});
		}

		if (line?.match(/catch\s*\(\s*\w*\s*\)\s*{\s*(\/\/|\/\*)?\s*}/)) {
			issues.push({
				severity: "warning",
				line: lineNum,
				message: "Empty catch block - at least log the error",
			});
		}

		if (line?.length > 120) {
			issues.push({
				severity: "info",
				line: lineNum,
				message: `Line is ${line.length} characters (max recommended: 120)`,
			});
		}
	}

	return issues;
}

function findBugs(
	code: string,
): Array<{
	type: string;
	severity: string;
	location: string;
	description: string;
	fix: string;
}> {
	const bugs: Array<{
		type: string;
		severity: string;
		location: string;
		description: string;
		fix: string;
	}> = [];

	const lines = code.split("\n");
	let inAsync = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		if (line?.match(/async\s+(function|\w+\s*\()/)) inAsync = true;
		if (line === "}" || line?.trim() === "}") inAsync = false;

		if (
			line?.includes("await") &&
			!inAsync &&
			!code.slice(0, code.indexOf(line!)).includes("async")
		) {
			bugs.push({
				type: "Async/Await Misuse",
				severity: "error",
				location: `Line ${lineNum}`,
				description:
					"Using 'await' outside of an async function will cause a syntax error.",
				fix: "Make the containing function async or remove the await keyword.",
			});
		}

		if (line?.match(/if\s*\([^)]*=[^=]/)) {
			bugs.push({
				type: "Assignment in Condition",
				severity: "warning",
				location: `Line ${lineNum}`,
				description:
					"Possible accidental assignment (=) instead of comparison (== or ===).",
				fix: "Use === for comparison or wrap in extra parentheses if intentional.",
			});
		}

		if (
			line?.match(/\w+\s*\[\s*['"][^'"]+['"]\s*\]/) &&
			!line?.includes("?.[")
		) {
			bugs.push({
				type: "Missing Optional Chaining",
				severity: "info",
				location: `Line ${lineNum}`,
				description:
					"Bracket access without optional chaining may throw if object is null/undefined.",
				fix: "Use optional chaining: obj?.['property'] or add a null check.",
			});
		}
	}

	return bugs;
}

interface CodePart {
	name: string;
	type: string;
	description: string;
}

function extractCodeParts(code: string): CodePart[] {
	const parts: CodePart[] = [];

	const funcMatches = code.matchAll(
		/(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)/g,
	);
	for (const match of funcMatches) {
		const name = match[1] ?? match[2];
		if (name) {
			parts.push({
				name,
				type: "function",
				description: `Defines a ${match[0]?.startsWith("async") ? "async " : ""}function '${name}' that encapsulates a specific piece of logic.`,
			});
		}
	}

	const classMatches = code.matchAll(/class\s+(\w+)(?:\s+extends\s+(\w+))?/g);
	for (const match of classMatches) {
		parts.push({
			name: match[1],
			type: "class",
			description: `Defines a class '${match[1]}'${match[2] ? ` that extends '${match[2]}'` : ""}.`,
		});
	}

	if (parts.length === 0) {
		parts.push({
			name: "main",
			type: "script",
			description: `A script block with ${code.split("\n").length} lines of code that performs sequential operations.`,
		});
	}

	return parts;
}

function calculateMetrics(code: string): {
	lines: number;
	characters: number;
	functions: number;
	classes: number;
	comments: number;
} {
	return {
		lines: code.split("\n").length,
		characters: code.length,
		functions: (
			code.match(
				/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\))?\s*=>)/g,
			) ?? []
		).length,
		classes: (code.match(/class\s+\w+/g) ?? []).length,
		comments: (code.match(/(?:\/\/.*$|\/\*[\s\S]*?\*\/)/gm) ?? []).length,
	};
}

function findDuplicateStrings(code: string): string[] {
	const stringMatches = code.matchAll(/['"`]([^'"`\n]{3,})['"`]/g);
	const counts = new Map<string, number>();
	for (const match of stringMatches) {
		const str = match[1];
		if (str) {
			counts.set(str, (counts.get(str) ?? 0) + 1);
		}
	}
	return [...counts.entries()].filter(([, c]) => c > 1).map(([s]) => s);
}

function countMaxNesting(code: string): number {
	let maxDepth = 0;
	let currentDepth = 0;
	for (const char of code) {
		if (char === "{") {
			currentDepth++;
			maxDepth = Math.max(maxDepth, currentDepth);
		}
		if (char === "}") {
			currentDepth = Math.max(0, currentDepth - 1);
		}
	}
	return maxDepth;
}

export default plugin;
