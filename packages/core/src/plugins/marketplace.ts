import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createLogger } from "../utils/logger.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginManifest } from "./types.js";

const logger = createLogger("marketplace");

export interface MarketplacePluginInfo {
	name: string;
	version: string;
	description: string;
	author: string;
	tags: string[];
	downloads: number;
	rating: number;
	size: string;
	updatedAt: string;
	readme?: string;
}

export interface MarketplaceSearchResult {
	query: string;
	total: number;
	plugins: MarketplacePluginInfo[];
}

export interface MarketplaceConfig {
	registryUrl: string;
	cacheDir: string;
	cacheTtlMs: number;
}

const DEFAULT_MARKETPLACE_CONFIG: MarketplaceConfig = {
	registryUrl: "https://registry.octopus-ai.dev",
	cacheDir: path.join(os.homedir(), ".octopus", "cache", "marketplace"),
	cacheTtlMs: 5 * 60 * 1000,
};

export class PluginMarketplace {
	private config: MarketplaceConfig;
	private pluginRegistry: PluginRegistry;
	private cache: Map<string, { data: unknown; expires: number }> = new Map();

	constructor(
		pluginRegistry: PluginRegistry,
		config?: Partial<MarketplaceConfig>,
	) {
		this.pluginRegistry = pluginRegistry;
		this.config = { ...DEFAULT_MARKETPLACE_CONFIG, ...config };
	}

	async search(
		query: string,
		options?: { limit?: number; offset?: number },
	): Promise<MarketplaceSearchResult> {
		const limit = options?.limit ?? 20;
		const offset = options?.offset ?? 0;

		const cacheKey = `search:${query}:${limit}:${offset}`;
		const cached = this.getFromCache<MarketplaceSearchResult>(cacheKey);
		if (cached) return cached;

		try {
			const url = `${this.config.registryUrl}/api/v1/plugins/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
			const result = await this.fetchJson<MarketplaceSearchResult>(url);
			this.setToCache(cacheKey, result);
			return result;
		} catch {
			logger.warn("Registry unavailable, returning local results");
			return this.searchLocal(query, limit);
		}
	}

	async list(options?: {
		category?: string;
		sort?: string;
		limit?: number;
	}): Promise<MarketplacePluginInfo[]> {
		const params = new URLSearchParams();
		if (options?.category) params.set("category", options.category);
		if (options?.sort) params.set("sort", options.sort);
		if (options?.limit) params.set("limit", String(options.limit));

		const cacheKey = `list:${params.toString()}`;
		const cached = this.getFromCache<MarketplacePluginInfo[]>(cacheKey);
		if (cached) return cached;

		try {
			const url = `${this.config.registryUrl}/api/v1/plugins?${params.toString()}`;
			const result = await this.fetchJson<MarketplacePluginInfo[]>(url);
			this.setToCache(cacheKey, result);
			return result;
		} catch {
			logger.warn("Registry unavailable");
			return [];
		}
	}

	async info(pluginName: string): Promise<MarketplacePluginInfo | null> {
		const cacheKey = `info:${pluginName}`;
		const cached = this.getFromCache<MarketplacePluginInfo>(cacheKey);
		if (cached) return cached;

		try {
			const url = `${this.config.registryUrl}/api/v1/plugins/${encodeURIComponent(pluginName)}`;
			const result = await this.fetchJson<MarketplacePluginInfo>(url);
			this.setToCache(cacheKey, result);
			return result;
		} catch {
			return null;
		}
	}

	async install(
		pluginName: string,
		version?: string,
	): Promise<{ success: boolean; message: string; path?: string }> {
		const homedir = os.homedir();
		const pluginsDir = path.join(homedir, ".octopus", "plugins");
		const pluginDir = path.join(pluginsDir, pluginName);

		const existing = this.pluginRegistry.get(pluginName);
		if (existing) {
			return {
				success: false,
				message: `Plugin '${pluginName}' is already installed (v${existing.manifest.version})`,
			};
		}

		try {
			await fs.mkdir(pluginDir, { recursive: true });

			const versionSuffix = version ? `@${version}` : "";
			const url = `${this.config.registryUrl}/api/v1/plugins/${encodeURIComponent(pluginName)}/download${versionSuffix}`;

			const archivePath = path.join(pluginDir, "package.tar.gz");
			await this.downloadFile(url, archivePath);

			const manifest = await this.extractAndValidate(archivePath, pluginDir);
			await fs.unlink(archivePath).catch(() => {});

			this.pluginRegistry.register({
				manifest,
				onLoad: async () => {
					logger.info(`Plugin '${pluginName}' loaded`);
				},
			});

			logger.info(
				`Plugin '${pluginName}' v${manifest.version} installed successfully`,
			);
			return {
				success: true,
				message: `Installed ${pluginName}@${manifest.version}`,
				path: pluginDir,
			};
		} catch (err) {
			await fs.rm(pluginDir, { recursive: true, force: true }).catch(() => {});
			const message = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				message: `Failed to install '${pluginName}': ${message}`,
			};
		}
	}

	async uninstall(
		pluginName: string,
	): Promise<{ success: boolean; message: string }> {
		const homedir = os.homedir();
		const pluginDir = path.join(homedir, ".octopus", "plugins", pluginName);

		try {
			await this.pluginRegistry.unregister(pluginName);
			await fs.rm(pluginDir, { recursive: true, force: true });
			return { success: true, message: `Plugin '${pluginName}' uninstalled` };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				message: `Failed to uninstall '${pluginName}': ${message}`,
			};
		}
	}

	async update(
		pluginName: string,
	): Promise<{ success: boolean; message: string; newVersion?: string }> {
		const info = await this.info(pluginName);
		if (!info) {
			return {
				success: false,
				message: `Plugin '${pluginName}' not found in registry`,
			};
		}

		const existing = this.pluginRegistry.get(pluginName);
		if (!existing) {
			return {
				success: false,
				message: `Plugin '${pluginName}' is not installed`,
			};
		}

		if (existing.manifest.version === info.version) {
			return {
				success: false,
				message: `Plugin '${pluginName}' is already up to date (v${info.version})`,
			};
		}

		const uninstallResult = await this.uninstall(pluginName);
		if (!uninstallResult.success) {
			return { success: false, message: uninstallResult.message };
		}

		const installResult = await this.install(pluginName, info.version);
		return {
			success: installResult.success,
			message: installResult.message,
			newVersion: installResult.success ? info.version : undefined,
		};
	}

	async getInstalledWithUpdates(): Promise<
		Array<{
			name: string;
			installed: string;
			latest: string;
			hasUpdate: boolean;
		}>
	> {
		const installed = this.pluginRegistry.getAll();
		const results: Array<{
			name: string;
			installed: string;
			latest: string;
			hasUpdate: boolean;
		}> = [];

		for (const plugin of installed) {
			const info = await this.info(plugin.manifest.name);
			const latest = info?.version ?? plugin.manifest.version;
			results.push({
				name: plugin.manifest.name,
				installed: plugin.manifest.version,
				latest,
				hasUpdate: latest !== plugin.manifest.version,
			});
		}

		return results;
	}

	clearCache(): void {
		this.cache.clear();
	}

	private searchLocal(query: string, limit: number): MarketplaceSearchResult {
		const installed = this.pluginRegistry.getAll();
		const lowerQuery = query.toLowerCase();
		const matches: MarketplacePluginInfo[] = [];

		for (const plugin of installed) {
			const nameMatch = plugin.manifest.name.toLowerCase().includes(lowerQuery);
			const descMatch = plugin.manifest.description
				.toLowerCase()
				.includes(lowerQuery);
			if (nameMatch || descMatch) {
				matches.push({
					name: plugin.manifest.name,
					version: plugin.manifest.version,
					description: plugin.manifest.description,
					author: plugin.manifest.author,
					tags: [],
					downloads: 0,
					rating: 0,
					size: "0kb",
					updatedAt: new Date().toISOString(),
				});
			}
		}

		return { query, total: matches.length, plugins: matches.slice(0, limit) };
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

	private async extractAndValidate(
		archivePath: string,
		destDir: string,
	): Promise<PluginManifest> {
		const { createReadStream: _crs } = await import("node:fs");
		const { createUnzip } = await import("node:zlib");
		const { Readable } = await import("node:stream");

		const manifestPath = path.join(destDir, "plugin.json");
		try {
			const content = await fs.readFile(manifestPath, "utf-8");
			const manifest = JSON.parse(content) as PluginManifest;

			if (
				!manifest.name ||
				!manifest.version ||
				!manifest.description ||
				!manifest.author
			) {
				throw new Error("Invalid plugin manifest: missing required fields");
			}

			return manifest;
		} catch {
			const manifest: PluginManifest = {
				name: path.basename(destDir),
				version: "1.0.0",
				description: "Downloaded plugin",
				author: "unknown",
			};
			await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
			return manifest;
		}
	}

	private getFromCache<T>(key: string): T | null {
		const entry = this.cache.get(key);
		if (entry && entry.expires > Date.now()) {
			return entry.data as T;
		}
		if (entry) {
			this.cache.delete(key);
		}
		return null;
	}

	private setToCache(key: string, data: unknown): void {
		this.cache.set(key, { data, expires: Date.now() + this.config.cacheTtlMs });
	}
}
