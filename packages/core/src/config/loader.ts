import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getDefaults } from "./defaults.js";
import { assertSafeObjectKey, assertSafeObjectTree } from "./object-safety.js";
import type { OctopusConfig } from "./schema.js";
import { ConfigValidator } from "./validator.js";

export class ConfigLoader {
	private configPath: string;
	private validator: ConfigValidator;

	constructor(configPath?: string) {
		this.configPath = configPath ?? join(homedir(), ".octopus", "config.json");
		this.validator = new ConfigValidator();
	}

	load(): OctopusConfig {
		const defaults = getDefaults();

		if (!existsSync(this.configPath)) {
			return defaults;
		}

		const raw = readFileSync(this.configPath, "utf-8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const migratedGoogle = this.migrateGoogleProvider(parsed);
		const migratedMultimedia = this.migrateMultimediaConfig(parsed);
		if (migratedGoogle || migratedMultimedia) {
			writeFileSync(this.configPath, JSON.stringify(parsed, null, 2), "utf-8");
		}
		const resolved = this.resolveEnvVars(parsed);
		const merged = this.deepMerge(
			defaults,
			resolved as Partial<OctopusConfig>,
		) as OctopusConfig;

		const result = this.validator.validate(merged);
		if (!result.valid) {
			throw new Error(`Invalid configuration: ${result.errors.join("; ")}`);
		}

		return merged;
	}

	/**
	 * Provider keys that have a credential stored DIRECTLY in the config file
	 * (apiKey / accessToken / credentialsFile / etc.) — NOT resolved from
	 * environment variables. Used to distinguish "the user configured this
	 * explicitly" from "auto-detected from env" for the connection status UI.
	 * Reads the raw file (no `${VAR}` substitution, no env auto-resolution).
	 */
	getExplicitlyConfiguredProviderKeys(): string[] {
		if (!existsSync(this.configPath)) return [];
		try {
			const raw = readFileSync(this.configPath, "utf-8").replace(/^﻿/, "");
			const parsed = JSON.parse(raw) as {
				ai?: { providers?: Record<string, unknown> };
			};
			const providers = parsed.ai?.providers ?? {};
			const result: string[] = [];
			for (const [key, value] of Object.entries(providers)) {
				if (value && typeof value === "object") {
					const p = value as Record<string, unknown>;
					if (
						p.apiKey ||
						p.accessToken ||
						p.credentialsFile ||
						p.credentialsJson ||
						p.oauthAccessToken ||
						p.browserCookies
					) {
						result.push(key);
					}
				}
			}
			return result;
		} catch {
			return [];
		}
	}

	save(config: OctopusConfig): void {
		const result = this.validator.validate(config);
		if (!result.valid) {
			throw new Error(
				`Cannot save invalid configuration: ${result.errors.join("; ")}`,
			);
		}

		const dir = dirname(this.configPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		writeFileSync(this.configPath, JSON.stringify(config, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		if (process.platform !== "win32") chmodSync(this.configPath, 0o600);
	}

	savePreservingEnv(config: OctopusConfig): void {
		const result = this.validator.validate(config);
		if (!result.valid) {
			throw new Error(
				`Cannot save invalid configuration: ${result.errors.join("; ")}`,
			);
		}
		let persisted: unknown = config;
		if (existsSync(this.configPath)) {
			try {
				const raw = readFileSync(this.configPath, "utf-8").replace(/^\uFEFF/, "");
				persisted = this.restoreUnchangedEnvTemplates(
					JSON.parse(raw),
					config,
				);
			} catch {
				persisted = config;
			}
		}
		assertSafeObjectTree(persisted);
		const dir = dirname(this.configPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.configPath, JSON.stringify(persisted, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		if (process.platform !== "win32") chmodSync(this.configPath, 0o600);
	}

	/**
	 * Migrate the legacy `ai.providers.google` entry into the split `gemini`
	 * (API key) and `vertex` (service account) providers. Idempotent: no-op when
	 * no `google` entry is present. Returns true if the config was changed (so
	 * the caller persists it).
	 */
	private migrateGoogleProvider(parsed: Record<string, unknown>): boolean {
		const ai = parsed.ai as Record<string, unknown> | undefined;
		const providers = ai?.providers as
			| Record<string, Record<string, unknown>>
			| undefined;
		if (!providers || !providers.google) return false;
		const g = providers.google;
		const pick = (obj: Record<string, unknown>, keys: string[]) => {
			const out: Record<string, unknown> = {};
			for (const k of keys) if (obj[k] != null) out[k] = obj[k];
			return out;
		};

		const isVertex =
			g.authMode === "vertex" ||
			g.credentialsFile ||
			g.projectId ||
			g.credentialsJson ||
			g.accessToken ||
			g.oauthAccessToken;

		// API-key (Gemini) fields.
		const geminiFields = pick(g, ["apiKey", "apiKeyEnv", "baseUrl", "models"]);
		if (Object.keys(geminiFields).length > 0 && (g.apiKey || !isVertex)) {
			providers.gemini = { ...(providers.gemini ?? {}), ...geminiFields };
		}

		// Vertex fields.
		if (isVertex) {
			const vertexFields = pick(g, [
				"projectId",
				"location",
				"credentialsFile",
				"credentialsJson",
				"accessToken",
				"accessTokenEnv",
				"baseUrl",
				"oauthAccessToken",
				"oauthRefreshToken",
				"oauthClientId",
				"oauthClientSecret",
				"oauthExpiresAt",
				"models",
			]);
			providers.vertex = { ...(providers.vertex ?? {}), ...vertexFields };
		}

		Reflect.deleteProperty(providers, "google");
		return true;
	}

	private migrateMultimediaConfig(parsed: Record<string, unknown>): boolean {
		let changed = parsed.version !== 2;
		parsed.version = 2;
		if (parsed.multimedia && typeof parsed.multimedia === "object") return changed;
		const tools = parsed.tools as Record<string, unknown> | undefined;
		const imageGeneration = tools?.imageGeneration as
			| Record<string, Record<string, unknown>>
			| undefined;
		if (!imageGeneration) {
			parsed.multimedia = getDefaults().multimedia;
			return true;
		}
		const openai = imageGeneration.openai ?? {};
		const nanoBanana = imageGeneration.nanoBanana ?? {};
		const imageRoutes: Array<{
			provider: "openai" | "gemini" | "vertex";
			model: string;
			transport: "openai-images" | "generate-content";
		}> = [];
		if (openai.enabled !== false) {
			imageRoutes.push({
				provider: "openai",
				model: typeof openai.model === "string" ? openai.model : "gpt-image-2",
				transport: "openai-images",
			});
		}
		if (nanoBanana.enabled !== false) {
			imageRoutes.push({
				provider: nanoBanana.provider === "gemini-api" ? "gemini" : "vertex",
				model:
					typeof nanoBanana.model === "string"
						? nanoBanana.model
						: "gemini-3.1-flash-image",
				transport: "generate-content",
			});
		}
		const defaultImageRoute = {
			provider: "openai" as const,
			model: "gpt-image-2",
			transport: "openai-images" as const,
		};
		parsed.multimedia = {
			image: {
				enabled: imageRoutes.length > 0,
				openaiAuthMode:
					openai.provider === "codex"
						? "codex"
						: openai.provider === "openai-api"
							? "api-key"
							: "inherit",
				primary: imageRoutes[0] ?? defaultImageRoute,
				fallbacks: imageRoutes.slice(1),
			},
			video: {
				enabled: true,
				primary: {
					provider: "vertex",
					model: "veo-3.1-generate-001",
					transport: "video-lro",
				},
				fallbacks: [
					{
						provider: "vertex",
						model: "veo-3.1-fast-generate-001",
						transport: "video-lro",
					},
					{
						provider: "vertex",
						model: "veo-3.1-lite-generate-001",
						transport: "video-lro",
					},
					{
						provider: "gemini",
						model: "gemini-omni-flash-preview",
						transport: "interactions",
					},
				],
				pollIntervalMs: 5000,
				maxPollMs: 1800000,
			},
		};
		changed = true;
		return changed;
	}

	private resolveEnvVars(obj: unknown): unknown {
		assertSafeObjectTree(obj);
		if (typeof obj === "string") {
			return obj.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
				return process.env[varName] ?? "";
			});
		}

		if (Array.isArray(obj)) {
			return obj.map((item) => this.resolveEnvVars(item));
		}

		if (obj !== null && typeof obj === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(obj)) {
				assertSafeObjectKey(key);
				result[key] = this.resolveEnvVars(value);
			}
			return result;
		}

		return obj;
	}

	private restoreUnchangedEnvTemplates(raw: unknown, next: unknown): unknown {
		if (
			typeof raw === "string" &&
			raw.includes("${") &&
			JSON.stringify(this.resolveEnvVars(raw)) === JSON.stringify(next)
		) {
			return raw;
		}
		if (Array.isArray(raw) && Array.isArray(next)) {
			return next.map((item, index) =>
				this.restoreUnchangedEnvTemplates(raw[index], item),
			);
		}
		if (
			raw &&
			next &&
			typeof raw === "object" &&
			typeof next === "object" &&
			!Array.isArray(raw) &&
			!Array.isArray(next)
		) {
			const rawRecord = raw as Record<string, unknown>;
			return Object.fromEntries(
				Object.entries(next as Record<string, unknown>).map(([key, value]) => [
					key,
					this.restoreUnchangedEnvTemplates(rawRecord[key], value),
				]),
			);
		}
		return next;
	}

	private deepMerge<T extends Record<string, unknown>>(
		target: T,
		source: Partial<T>,
	): T {
		const result = { ...target } as Record<string, unknown>;

		for (const key of Object.keys(source as Record<string, unknown>)) {
			assertSafeObjectKey(key);
			const sourceValue = (source as Record<string, unknown>)[key];
			const targetValue = result[key];

			if (
				sourceValue !== null &&
				typeof sourceValue === "object" &&
				!Array.isArray(sourceValue) &&
				targetValue !== null &&
				typeof targetValue === "object" &&
				!Array.isArray(targetValue)
			) {
				result[key] = this.deepMerge(
					targetValue as Record<string, unknown>,
					sourceValue as Record<string, unknown>,
				);
			} else {
				result[key] = sourceValue;
			}
		}

		return result as T;
	}
}
