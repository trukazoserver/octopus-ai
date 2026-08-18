import { describe, expect, it } from "vitest";
import { getDefaults } from "../config/defaults.js";
import { SettingsService } from "../settings/service.js";

describe("SettingsService", () => {
	it("reports leaf paths and keeps memory.enabled hot-applicable", () => {
		const config = getDefaults();
		const result = SettingsService.applySectionUpdate(config, "memory", {
			patch: { enabled: false },
		});

		expect(result.changedKeys).toEqual(["memory.enabled"]);
		expect(
			SettingsService.restartKeysForChanges("memory", result.changedKeys),
		).toEqual([]);
	});

	it("reports nested embedding changes instead of only the section root", () => {
		const config = getDefaults();
		const result = SettingsService.applySectionUpdate(config, "memory", {
			patch: { embeddings: { provider: "openai" } },
		});

		expect(result.changedKeys).toEqual(["memory.embeddings.provider"]);
	});

	it("marks structural memory changes as pending restart keys", () => {
		const config = getDefaults();
		const result = SettingsService.applySectionUpdate(config, "memory", {
			patch: {
				shortTerm: { maxMessages: config.memory.shortTerm.maxMessages + 1 },
			},
		});

		expect(
			SettingsService.restartKeysForChanges("memory", result.changedKeys),
		).toEqual(["memory.shortTerm"]);
	});

	it("returns no changed paths for a no-op patch", () => {
		const config = getDefaults();
		const result = SettingsService.applySectionUpdate(config, "tools", {
			patch: { disabled: config.tools.disabled },
		});

		expect(result.changedKeys).toEqual([]);
	});

	it("reports only actual pending restart state in status", () => {
		const config = getDefaults();
		expect(SettingsService.getStatus(config).restartRequired).toBe(false);
		expect(
			SettingsService.getStatus(config, ["memory.shortTerm"]),
		).toMatchObject({
			restartRequired: true,
			restartKeys: ["memory.shortTerm"],
		});
	});

	it("matches a parent config write against nested restart keys", () => {
		expect(SettingsService.restartKeysForChangedPaths(["memory"])).toEqual(
			expect.arrayContaining([
				"memory.shortTerm",
				"memory.longTerm",
				"memory.consolidation",
			]),
		);
	});

	it("round-trips configured false secret sentinels without changing schema types", () => {
		const config = getDefaults();
		config.mcp!.servers.empty = {
			type: "http",
			url: "https://mcp.example.test",
			args: [],
			headers: { Authorization: "" },
		};
		const section = SettingsService.getSection(config, "mcp");
		const result = SettingsService.applySectionUpdate(config, "mcp", {
			data: section.data,
		});

		expect(result.config.mcp?.servers.empty?.headers?.Authorization).toBe("");
	});
});
