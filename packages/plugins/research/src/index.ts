import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin } from "@octopus-ai/core";

const execAsync = promisify(exec);

const plugin: Plugin = {
	manifest: {
		name: "research",
		version: "1.0.0",
		description: "Web research, search, and information synthesis",
		author: "OctopusTeam",
	},
	commands: [
		{
			name: "/search",
			description: "Search the web for information. Usage: /search <query>",
			execute: async (args: string[]) => {
				const query = args.join(" ").trim();
				if (!query) return "Usage: /search <query>";

				try {
					const { stdout } = await execAsync(
						`curl -s "https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1"`,
						{ timeout: 10000 },
					);
					const data = JSON.parse(stdout);

					const results: string[] = [];
					if (data.Abstract) {
						results.push(`## ${data.Heading ?? query}\n\n${data.Abstract}`);
						if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
					}
					if (data.RelatedTopics) {
						const topics = (
							data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }>
						)
							.filter((t) => t.Text)
							.slice(0, 5);
						for (const topic of topics) {
							results.push(`- ${topic.Text}`);
						}
					}

					if (results.length === 0) {
						return `No results found for: "${query}"\nTry a different search query.`;
					}
					return results.join("\n\n");
				} catch {
					return `Search for "${query}" - web search requires curl.\nKey topics to research: ${query}`;
				}
			},
		},
		{
			name: "/summarize",
			description: "Summarize text. Usage: /summarize <text>",
			execute: async (args: string[]) => {
				const text = args.join(" ").trim();
				if (!text) return "Usage: /summarize <text>";

				const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
				const wordCount = text.split(/\s+/).length;

				if (sentences.length <= 2)
					return `Text is already concise (${wordCount} words):\n\n${text}`;

				const keyPoints = sentences.slice(
					0,
					Math.min(3, Math.ceil(sentences.length / 3)),
				);
				return `Summary (${wordCount} words -> ${keyPoints.length} key points):\n\n${keyPoints.join(" ").trim()}`;
			},
		},
		{
			name: "/define",
			description: "Get a definition or explanation. Usage: /define <term>",
			execute: async (args: string[]) => {
				const term = args.join(" ").trim();
				if (!term) return "Usage: /define <term>";

				const commonTerms: Record<string, string> = {
					api: "Application Programming Interface - a set of protocols for building software",
					rest: "Representational State Transfer - an architectural style for web services",
					json: "JavaScript Object Notation - a lightweight data interchange format",
					sql: "Structured Query Language - a language for managing relational databases",
					oauth: "Open Authorization - an open standard for access delegation",
					docker:
						"A platform for containerizing applications for consistent deployment",
					git: "A distributed version control system for tracking code changes",
					typescript:
						"A typed superset of JavaScript that compiles to plain JavaScript",
					node: "A JavaScript runtime built on Chrome's V8 engine for server-side execution",
					async:
						"Asynchronous execution - code that runs without blocking the main thread",
				};

				const lowerTerm = term.toLowerCase().replace(/[^a-z]/g, "");
				if (commonTerms[lowerTerm]) {
					return `**${term}**: ${commonTerms[lowerTerm]}`;
				}

				return `Definition for "${term}" - This term would benefit from a web search. Use /search ${term} for more details.`;
			},
		},
	],
	onLoad: async () => {},
};

export default plugin;
