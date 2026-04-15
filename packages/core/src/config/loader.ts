import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { OctopusConfig } from "./schema.js";
import { getDefaults } from "./defaults.js";
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

    const raw = readFileSync(this.configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const resolved = this.resolveEnvVars(parsed);
    const merged = this.deepMerge(defaults, resolved as Partial<OctopusConfig>) as OctopusConfig;

    const result = this.validator.validate(merged);
    if (!result.valid) {
      throw new Error(`Invalid configuration: ${result.errors.join("; ")}`);
    }

    return merged;
  }

  save(config: OctopusConfig): void {
    const result = this.validator.validate(config);
    if (!result.valid) {
      throw new Error(`Cannot save invalid configuration: ${result.errors.join("; ")}`);
    }

    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
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

  private deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
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
          sourceValue as Record<string, unknown>
        );
      } else {
        result[key] = sourceValue;
      }
    }

    return result as T;
  }
}
