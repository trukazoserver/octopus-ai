import { Value } from "@sinclair/typebox/value";
import { ConfigSchema } from "./schema.js";
import type { OctopusConfig } from "./schema.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class ConfigValidator {
  validate(config: OctopusConfig): ValidationResult {
    const isValid = Value.Check(ConfigSchema, config);

    if (isValid) {
      return { valid: true, errors: [] };
    }

    const errors: string[] = [];
    for (const error of Value.Errors(ConfigSchema, config)) {
      const path = error.path ?? "/";
      const message = error.message ?? "validation failed";
      errors.push(`${path}: ${message}`);
    }

    return { valid: false, errors };
  }
}
