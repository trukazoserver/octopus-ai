import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigLoader } from "../config/loader.js";

describe("multimedia config migration", () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("upgrades a minimal v1 config even without an explicit imageGeneration block", () => {
		directory = mkdtempSync(join(tmpdir(), "octopus-config-v2-"));
		const configPath = join(directory, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({ version: 1, server: { port: 19001 } }),
			"utf8",
		);

		const loaded = new ConfigLoader(configPath).load();
		const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
			version: number;
			multimedia?: unknown;
		};

		expect(loaded.version).toBe(2);
		expect(loaded.server.port).toBe(19001);
		expect(loaded.multimedia?.video.primary.model).toBe("veo-3.1-generate-001");
		expect(persisted.version).toBe(2);
		expect(persisted.multimedia).toBeDefined();
	});

	it("preserves legacy image provider choices while creating video defaults", () => {
		directory = mkdtempSync(join(tmpdir(), "octopus-config-image-v2-"));
		const configPath = join(directory, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				tools: {
					imageGeneration: {
						openai: { enabled: true, provider: "openai-api", model: "gpt-image-custom" },
						nanoBanana: { enabled: true, provider: "gemini-api", model: "gemini-image-custom" },
					},
				},
			}),
			"utf8",
		);

		const loaded = new ConfigLoader(configPath).load();

		expect(loaded.multimedia?.image.primary).toMatchObject({
			provider: "openai",
			model: "gpt-image-custom",
		});
		expect(loaded.multimedia?.image.fallbacks[0]).toMatchObject({
			provider: "gemini",
			model: "gemini-image-custom",
		});
		expect(loaded.multimedia?.image.openaiAuthMode).toBe("api-key");
		expect(loaded.multimedia?.video.primary.model).toBe("veo-3.1-generate-001");
	});

	it("preserves the legacy Codex billing mode when no explicit auth mode exists", () => {
		directory = mkdtempSync(join(tmpdir(), "octopus-config-codex-image-v2-"));
		const configPath = join(directory, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				ai: {
					providers: {
						openai: { apiKey: "api-key", accessToken: "codex-token" },
					},
				},
				tools: {
					imageGeneration: {
						openai: { enabled: true, provider: "codex", model: "gpt-image-2" },
						nanoBanana: { enabled: false },
					},
				},
			}),
			"utf8",
		);

		const loaded = new ConfigLoader(configPath).load();

		expect(loaded.multimedia?.image.openaiAuthMode).toBe("codex");
		expect(loaded.multimedia?.image.primary.provider).toBe("openai");
	});

	it("does not migrate a disabled legacy provider into a billable route", () => {
		directory = mkdtempSync(join(tmpdir(), "octopus-config-disabled-image-v2-"));
		const configPath = join(directory, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 1,
				tools: {
					imageGeneration: {
						openai: { enabled: false, provider: "openai-api", model: "gpt-image-2" },
						nanoBanana: { enabled: true, provider: "gemini-api", model: "gemini-image-custom" },
					},
				},
			}),
			"utf8",
		);

		const loaded = new ConfigLoader(configPath).load();

		expect(loaded.multimedia?.image.enabled).toBe(true);
		expect(loaded.multimedia?.image.primary).toMatchObject({
			provider: "gemini",
			model: "gemini-image-custom",
		});
		expect(loaded.multimedia?.image.fallbacks).toEqual([]);
	});
});
