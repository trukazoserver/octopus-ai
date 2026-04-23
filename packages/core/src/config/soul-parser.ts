import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentConfig } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";

/**
 * SoulParser — Declarative Agent Configuration via Markdown
 *
 * Inspired by OpenClaw's SOUL.md/HEARTBEAT.md/MEMORY.md approach.
 * Allows users to configure their agent's behavior using human-readable
 * Markdown files instead of programmatic TypeScript objects.
 *
 * Supported files:
 * - SOUL.md      → Agent persona, personality, system prompt
 * - HEARTBEAT.md → Proactive tasks checklist
 * - MEMORY.md    → Memory behavior configuration
 * - TOOLS.md     → Tool permissions and preferences
 */

const logger = createLogger("soul-parser");

export interface SoulConfig {
	/** Agent name */
	name: string;
	/** Agent description */
	description: string;
	/** Full system prompt (from SOUL.md body) */
	systemPrompt: string;
	/** Personality traits */
	personality: string[];
	/** Goals and objectives */
	goals: string[];
	/** Rules / constraints */
	rules: string[];
	/** Preferred model */
	model?: string;
	/** Temperature */
	temperature?: number;
	/** Response language */
	language?: string;
}

export interface HeartbeatChecklist {
	items: Array<{
		id: string;
		description: string;
		priority: "high" | "medium" | "low";
	}>;
	intervalMinutes: number;
}

export interface MemoryConfig {
	/** Whether to enable auto-consolidation */
	autoConsolidate: boolean;
	/** Custom important keywords to always remember */
	importantKeywords: string[];
	/** Memory decay settings */
	decayDays: number;
	/** User modeling enabled */
	userModeling: boolean;
}

export interface ToolPreferences {
	/** Allowed tools (whitelist, empty = all) */
	allowed: string[];
	/** Blocked tools */
	blocked: string[];
	/** Per-tool instructions */
	instructions: Record<string, string>;
}

export class SoulParser {
	private workspacePath: string;

	constructor(workspacePath: string) {
		this.workspacePath = resolve(workspacePath);
	}

	/**
	 * Parse all configuration files from the workspace.
	 */
	async parseAll(): Promise<{
		soul: SoulConfig | null;
		heartbeat: HeartbeatChecklist | null;
		memory: MemoryConfig | null;
		tools: ToolPreferences | null;
	}> {
		return {
			soul: await this.parseSoul(),
			heartbeat: await this.parseHeartbeat(),
			memory: await this.parseMemory(),
			tools: await this.parseTools(),
		};
	}

	/**
	 * Parse SOUL.md — Agent persona and behavior.
	 */
	async parseSoul(): Promise<SoulConfig | null> {
		const content = await this.readFile("SOUL.md");
		if (!content) return null;

		const config: SoulConfig = {
			name: "Octopus",
			description: "",
			systemPrompt: "",
			personality: [],
			goals: [],
			rules: [],
		};

		const sections = this.parseSections(content);

		// Parse header/frontmatter
		const frontmatter = this.parseFrontmatter(content);
		if (frontmatter.name) config.name = frontmatter.name;
		if (frontmatter.model) config.model = frontmatter.model;
		if (frontmatter.temperature)
			config.temperature = Number(frontmatter.temperature);
		if (frontmatter.language) config.language = frontmatter.language;

		// Parse sections
		for (const [heading, body] of sections) {
			const key = heading.toLowerCase();

			if (
				key.includes("personality") ||
				key.includes("personalidad") ||
				key.includes("traits")
			) {
				config.personality = this.parseList(body);
			} else if (
				key.includes("goal") ||
				key.includes("objetivo") ||
				key.includes("purpose")
			) {
				config.goals = this.parseList(body);
			} else if (
				key.includes("rule") ||
				key.includes("regla") ||
				key.includes("constraint") ||
				key.includes("boundary")
			) {
				config.rules = this.parseList(body);
			} else if (
				key.includes("description") ||
				key.includes("descripción") ||
				key.includes("about")
			) {
				config.description = body.trim();
			}
		}

		// Build system prompt from all sections
		config.systemPrompt = this.buildSystemPromptFromSoul(config, content);

		logger.info(`Parsed SOUL.md: agent "${config.name}"`);
		return config;
	}

	/**
	 * Parse HEARTBEAT.md — Proactive task checklist.
	 */
	async parseHeartbeat(): Promise<HeartbeatChecklist | null> {
		const content = await this.readFile("HEARTBEAT.md");
		if (!content) return null;

		const frontmatter = this.parseFrontmatter(content);
		const intervalMinutes = Number(frontmatter.interval ?? 30);

		const items: HeartbeatChecklist["items"] = [];
		const lines = content.split("\n");

		let currentPriority: "high" | "medium" | "low" = "medium";

		for (const line of lines) {
			const trimmed = line.trim();

			// Detect priority sections
			if (trimmed.match(/^#{1,3}\s+.*(high|alta|urgent|urgente)/i)) {
				currentPriority = "high";
				continue;
			}
			if (trimmed.match(/^#{1,3}\s+.*(medium|media|normal)/i)) {
				currentPriority = "medium";
				continue;
			}
			if (trimmed.match(/^#{1,3}\s+.*(low|baja)/i)) {
				currentPriority = "low";
				continue;
			}

			// Parse list items as heartbeat tasks
			const listMatch = trimmed.match(/^[-*]\s+\[?\s*\]?\s*(.+)/);
			if (listMatch) {
				const description = listMatch[1].trim();
				if (description.length > 5) {
					const id = description
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.substring(0, 40);
					items.push({ id, description, priority: currentPriority });
				}
			}
		}

		logger.info(
			`Parsed HEARTBEAT.md: ${items.length} items, interval ${intervalMinutes}min`,
		);
		return { items, intervalMinutes };
	}

	/**
	 * Parse MEMORY.md — Memory configuration.
	 */
	async parseMemory(): Promise<MemoryConfig | null> {
		const content = await this.readFile("MEMORY.md");
		if (!content) return null;

		const frontmatter = this.parseFrontmatter(content);

		const config: MemoryConfig = {
			autoConsolidate:
				frontmatter.auto_consolidate !== "false",
			importantKeywords: [],
			decayDays: Number(frontmatter.decay_days ?? 90),
			userModeling: frontmatter.user_modeling !== "false",
		};

		const sections = this.parseSections(content);
		for (const [heading, body] of sections) {
			const key = heading.toLowerCase();
			if (
				key.includes("important") ||
				key.includes("keywords") ||
				key.includes("remember")
			) {
				config.importantKeywords = this.parseList(body);
			}
		}

		logger.info("Parsed MEMORY.md");
		return config;
	}

	/**
	 * Parse TOOLS.md — Tool permissions and preferences.
	 */
	async parseTools(): Promise<ToolPreferences | null> {
		const content = await this.readFile("TOOLS.md");
		if (!content) return null;

		const prefs: ToolPreferences = {
			allowed: [],
			blocked: [],
			instructions: {},
		};

		const sections = this.parseSections(content);
		for (const [heading, body] of sections) {
			const key = heading.toLowerCase();
			if (key.includes("allowed") || key.includes("permitido")) {
				prefs.allowed = this.parseList(body);
			} else if (
				key.includes("blocked") ||
				key.includes("bloqueado") ||
				key.includes("disabled")
			) {
				prefs.blocked = this.parseList(body);
			} else {
				// Treat other sections as tool-specific instructions
				const toolName = heading
					.replace(/^#+\s*/, "")
					.trim()
					.toLowerCase();
				if (toolName && body.trim()) {
					prefs.instructions[toolName] = body.trim();
				}
			}
		}

		logger.info("Parsed TOOLS.md");
		return prefs;
	}

	/**
	 * Convert SoulConfig to AgentConfig.
	 */
	toAgentConfig(soul: SoulConfig, agentId: string): AgentConfig {
		return {
			id: agentId,
			name: soul.name,
			description: soul.description,
			systemPrompt: soul.systemPrompt,
			model: soul.model,
			temperature: soul.temperature,
		};
	}

	// --- Utilities ---

	private async readFile(filename: string): Promise<string | null> {
		const path = join(this.workspacePath, filename);
		try {
			return await fs.readFile(path, "utf-8");
		} catch {
			return null;
		}
	}

	private parseFrontmatter(content: string): Record<string, string> {
		const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
		if (!match) return {};

		const result: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const [key, ...valueParts] = line.split(":");
			if (key && valueParts.length > 0) {
				result[key.trim().toLowerCase()] = valueParts
					.join(":")
					.trim()
					.replace(/^["']|["']$/g, "");
			}
		}
		return result;
	}

	private parseSections(content: string): [string, string][] {
		// Remove frontmatter
		const cleaned = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");

		const sections: [string, string][] = [];
		const lines = cleaned.split("\n");
		let currentHeading = "";
		let currentBody: string[] = [];

		for (const line of lines) {
			const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
			if (headingMatch) {
				if (currentHeading) {
					sections.push([currentHeading, currentBody.join("\n")]);
				}
				currentHeading = headingMatch[2].trim();
				currentBody = [];
			} else {
				currentBody.push(line);
			}
		}

		if (currentHeading) {
			sections.push([currentHeading, currentBody.join("\n")]);
		}

		return sections;
	}

	private parseList(content: string): string[] {
		return content
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.match(/^[-*]\s+/))
			.map((line) => line.replace(/^[-*]\s+/, "").trim())
			.filter((item) => item.length > 0);
	}

	private buildSystemPromptFromSoul(
		soul: SoulConfig,
		rawContent: string,
	): string {
		const parts: string[] = [];

		parts.push(`You are ${soul.name}.`);

		if (soul.description) {
			parts.push(soul.description);
		}

		if (soul.personality.length > 0) {
			parts.push(`\n## Personality\n${soul.personality.map((p) => `- ${p}`).join("\n")}`);
		}

		if (soul.goals.length > 0) {
			parts.push(`\n## Goals\n${soul.goals.map((g) => `- ${g}`).join("\n")}`);
		}

		if (soul.rules.length > 0) {
			parts.push(`\n## Rules\n${soul.rules.map((r) => `- ${r}`).join("\n")}`);
		}

		if (soul.language) {
			parts.push(`\nAlways respond in ${soul.language}.`);
		}

		return parts.join("\n");
	}
}
