import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import type { EmbeddingFunction } from "../memory/types.js";
import { createLogger } from "../utils/logger.js";
import type { SkillRegistry } from "./registry.js";
import type { Skill } from "./types.js";

const logger = createLogger("skill-marketplace");

export interface SharedSkillMetadata {
	name: string;
	version: string;
	description: string;
	author: string;
	tags: string[];
	downloads: number;
	rating: number;
	quality: {
		completeness: number;
		accuracy: number;
		clarity: number;
	};
	updatedAt: string;
}

export interface SkillMarketplaceConfig {
	registryUrl: string;
	exportDir: string;
}

const DEFAULT_SKILL_MARKETPLACE_CONFIG: SkillMarketplaceConfig = {
	registryUrl: "https://registry.octopus-ai.dev",
	exportDir: path.join(os.homedir(), ".octopus", "exports"),
};

export class SkillMarketplace {
	private config: SkillMarketplaceConfig;
	private skillRegistry: SkillRegistry;
	private embedFn: EmbeddingFunction;
	private cache: Map<string, { data: unknown; expires: number }> = new Map();

	constructor(
		skillRegistry: SkillRegistry,
		embedFn: EmbeddingFunction,
		config?: Partial<SkillMarketplaceConfig>,
	) {
		this.skillRegistry = skillRegistry;
		this.embedFn = embedFn;
		this.config = { ...DEFAULT_SKILL_MARKETPLACE_CONFIG, ...config };
	}

	async search(
		query: string,
		options?: { limit?: number },
	): Promise<SharedSkillMetadata[]> {
		const limit = options?.limit ?? 20;
		const cacheKey = `skill-search:${query}:${limit}`;
		const cached = this.getFromCache<SharedSkillMetadata[]>(cacheKey);
		if (cached) return cached;

		try {
			const url = `${this.config.registryUrl}/api/v1/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`;
			const result = await this.fetchJson<SharedSkillMetadata[]>(url);
			this.setToCache(cacheKey, result);
			return result;
		} catch {
			logger.warn("Skill registry unavailable");
			return [];
		}
	}

	async list(options?: { category?: string; limit?: number }): Promise<
		SharedSkillMetadata[]
	> {
		const params = new URLSearchParams();
		if (options?.category) params.set("category", options.category);
		if (options?.limit) params.set("limit", String(options.limit));

		const cacheKey = `skill-list:${params.toString()}`;
		const cached = this.getFromCache<SharedSkillMetadata[]>(cacheKey);
		if (cached) return cached;

		try {
			const url = `${this.config.registryUrl}/api/v1/skills?${params.toString()}`;
			const result = await this.fetchJson<SharedSkillMetadata[]>(url);
			this.setToCache(cacheKey, result);
			return result;
		} catch {
			return [];
		}
	}

	async exportSkill(
		skillName: string,
	): Promise<{ success: boolean; message: string; filePath?: string }> {
		const skill = await this.skillRegistry.getByName(skillName);
		if (!skill) {
			return { success: false, message: `Skill '${skillName}' not found` };
		}

		try {
			await fs.mkdir(this.config.exportDir, { recursive: true });

			const exportData = {
				version: "1.0.0",
				exportedAt: new Date().toISOString(),
				skill: {
					...skill,
					embedding: undefined,
				},
			};

			const fileName = `${skillName}-v${skill.version}.json`;
			const filePath = path.join(this.config.exportDir, fileName);
			await fs.writeFile(
				filePath,
				JSON.stringify(exportData, null, 2),
				"utf-8",
			);

			logger.info(`Skill '${skillName}' exported to ${filePath}`);
			return {
				success: true,
				message: `Skill exported to ${filePath}`,
				filePath,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, message: `Export failed: ${message}` };
		}
	}

	async importSkill(
		filePath: string,
	): Promise<{ success: boolean; message: string; skill?: Skill }> {
		try {
			const resolvedPath = filePath.startsWith("~")
				? path.join(os.homedir(), filePath.slice(1))
				: path.resolve(filePath);

			const content = await fs.readFile(resolvedPath, "utf-8");
			const exportData = JSON.parse(content);

			if (!exportData.skill) {
				return {
					success: false,
					message: "Invalid skill export file: missing skill data",
				};
			}

			const skill: Skill = exportData.skill;

			const existing = await this.skillRegistry.getByName(skill.name);
			if (existing) {
				return {
					success: false,
					message: `Skill '${skill.name}' already exists. Use --force to overwrite.`,
				};
			}

			const embedding = await this.embedFn(
				`${skill.name} ${skill.description} ${skill.instructions}`,
			);
			skill.embedding = embedding;

			await this.skillRegistry.save(skill);

			logger.info(`Skill '${skill.name}' imported successfully`);
			return {
				success: true,
				message: `Skill '${skill.name}' v${skill.version} imported`,
				skill,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, message: `Import failed: ${message}` };
		}
	}

	async importFromMarketplace(
		skillName: string,
	): Promise<{ success: boolean; message: string }> {
		try {
			const url = `${this.config.registryUrl}/api/v1/skills/${encodeURIComponent(skillName)}/download`;
			const exportDir = path.join(
				os.homedir(),
				".octopus",
				"cache",
				"skill-downloads",
			);
			await fs.mkdir(exportDir, { recursive: true });

			const filePath = path.join(exportDir, `${skillName}.json`);
			await this.downloadFile(url, filePath);

			const result = await this.importSkill(filePath);
			await fs.unlink(filePath).catch(() => {});
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, message: `Download failed: ${message}` };
		}
	}

	async publish(
		skillName: string,
	): Promise<{ success: boolean; message: string }> {
		const skill = await this.skillRegistry.getByName(skillName);
		if (!skill) {
			return { success: false, message: `Skill '${skillName}' not found` };
		}

		try {
			const exportData = {
				version: "1.0.0",
				publishedAt: new Date().toISOString(),
				skill: {
					...skill,
					embedding: undefined,
				},
			};

			const url = `${this.config.registryUrl}/api/v1/skills/publish`;
			await this.postJson(url, exportData);

			return {
				success: true,
				message: `Skill '${skillName}' published to marketplace`,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, message: `Publish failed: ${message}` };
		}
	}

	clearCache(): void {
		this.cache.clear();
	}

	private async fetchJson<T>(url: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const client = url.startsWith("https") ? https : http;
			client
				.get(url, { timeout: 10000 }, (res) => {
					if (
						res.statusCode &&
						res.statusCode >= 300 &&
						res.statusCode < 400 &&
						res.headers.location
					) {
						this.fetchJson<T>(res.headers.location).then(resolve).catch(reject);
						return;
					}
					if (
						res.statusCode &&
						(res.statusCode < 200 || res.statusCode >= 300)
					) {
						reject(new Error(`HTTP ${res.statusCode}`));
						return;
					}
					let data = "";
					res.on("data", (chunk) => {
						data += chunk;
					});
					res.on("end", () => {
						try {
							resolve(JSON.parse(data));
						} catch {
							reject(new Error("Invalid JSON response"));
						}
					});
				})
				.on("error", reject);
		});
	}

	private async postJson(url: string, body: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const parsedUrl = new URL(url);
			const options = {
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
				path: parsedUrl.pathname + parsedUrl.search,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				timeout: 15000,
			};

			const client = parsedUrl.protocol === "https:" ? https : http;
			const req = client.request(options, (res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(data));
					} catch {
						resolve(data);
					}
				});
			});
			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy();
				reject(new Error("Request timeout"));
			});
			req.write(JSON.stringify(body));
			req.end();
		});
	}

	private async downloadFile(url: string, destPath: string): Promise<void> {
		await fs.mkdir(path.dirname(destPath), { recursive: true });
		return new Promise((resolve, reject) => {
			const client = url.startsWith("https") ? https : http;
			const file = createWriteStream(destPath);
			client
				.get(url, { timeout: 30000 }, (res) => {
					if (
						res.statusCode &&
						res.statusCode >= 300 &&
						res.statusCode < 400 &&
						res.headers.location
					) {
						file.close();
						this.downloadFile(res.headers.location, destPath)
							.then(resolve)
							.catch(reject);
						return;
					}
					if (
						res.statusCode &&
						(res.statusCode < 200 || res.statusCode >= 300)
					) {
						file.close();
						reject(new Error(`Download failed: HTTP ${res.statusCode}`));
						return;
					}
					res.pipe(file);
					file.on("finish", () => {
						file.close();
						resolve();
					});
				})
				.on("error", (err) => {
					file.close();
					reject(err);
				});
		});
	}

	private getFromCache<T>(key: string): T | null {
		const entry = this.cache.get(key);
		if (entry && entry.expires > Date.now()) return entry.data as T;
		if (entry) this.cache.delete(key);
		return null;
	}

	private setToCache(key: string, data: unknown): void {
		this.cache.set(key, { data, expires: Date.now() + 5 * 60 * 1000 });
	}
}
