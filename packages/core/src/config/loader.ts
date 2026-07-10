import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getDefaults } from "./defaults.js";
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
		if (this.migrateGoogleProvider(parsed)) {
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

		writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
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

		delete providers.google;
		return true;
	}

	private resolveEnvVars(obj: unknown): unknown {
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
				result[key] = this.resolveEnvVars(value);
			}
			return result;
		}

		return obj;
	}

	private deepMerge<T extends Record<string, unknown>>(
		target: T,
		source: Partial<T>,
	): T {
		const result = { ...target } as Record<string, unknown>;

		for (const key of Object.keys(source as Record<string, unknown>)) {
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
