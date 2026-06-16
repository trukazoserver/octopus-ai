import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, getDefaults } from "../config/defaults.js";

describe("Config Defaults", () => {
	describe("DEFAULT_CONFIG", () => {
		it("should have a version", () => {
			expect(DEFAULT_CONFIG.version).toBe(1);
		});

		it("should have server config", () => {
			expect(DEFAULT_CONFIG.server).toBeDefined();
			expect(DEFAULT_CONFIG.server.port).toBe(18789);
			expect(DEFAULT_CONFIG.server.host).toBe("127.0.0.1");
			expect(DEFAULT_CONFIG.server.transport).toBe("auto");
		});

		it("should have AI config with providers", () => {
			expect(DEFAULT_CONFIG.ai).toBeDefined();
			expect(DEFAULT_CONFIG.ai.default).toBeTruthy();
			expect(DEFAULT_CONFIG.ai.providers).toBeDefined();
			expect(DEFAULT_CONFIG.ai.providers.anthropic).toBeDefined();
			expect(DEFAULT_CONFIG.ai.providers.openai).toBeDefined();
			expect(DEFAULT_CONFIG.ai.providers.google).toBeDefined();
			expect(DEFAULT_CONFIG.ai.providers.zhipu.mode).toBe("coding-plan");
			expect(DEFAULT_CONFIG.ai.providers.openai.authMode).toBe("api-key");
			expect(DEFAULT_CONFIG.ai.providers.google.authMode).toBe("api-key");
			expect(DEFAULT_CONFIG.ai.providers.openrouter.baseUrl).toBe(
				"https://openrouter.ai/api/v1",
			);
			expect(DEFAULT_CONFIG.ai.providers.local).toBeDefined();
		});

		it("should expose browser fallback controls", () => {
			expect(DEFAULT_CONFIG.browser.brightDataEnabled).toBe(true);
			expect(DEFAULT_CONFIG.browser.decodoEnabled).toBe(true);
			expect(DEFAULT_CONFIG.browser.autoFallbackOnBlock).toBe(false);
			expect(DEFAULT_CONFIG.browser.blockFallbackProvider).toBe("decodo");
		});

		it("should default browser previews to native visual rendering", () => {
			expect(DEFAULT_CONFIG.browser.headless).toBe(false);
			expect(DEFAULT_CONFIG.browser.nativeFingerprint).toBe(true);
			expect(DEFAULT_CONFIG.browser.stealth).toBe(false);
			expect(DEFAULT_CONFIG.browser.blockResources).toEqual([]);
			expect(DEFAULT_CONFIG.browser.blockTrackerDomains).toBe(false);
		});

		it("should have channel config with all channels", () => {
			expect(DEFAULT_CONFIG.channels).toBeDefined();
			expect(DEFAULT_CONFIG.channels.whatsapp).toBeDefined();
			expect(DEFAULT_CONFIG.channels.telegram).toBeDefined();
			expect(DEFAULT_CONFIG.channels.discord).toBeDefined();
			expect(DEFAULT_CONFIG.channels.slack).toBeDefined();
			expect(DEFAULT_CONFIG.channels.webchat).toBeDefined();
			expect(DEFAULT_CONFIG.channels.webchat.enabled).toBe(true);
			expect(DEFAULT_CONFIG.channels.teams).toBeUndefined();
			expect(DEFAULT_CONFIG.channels.signal).toBeUndefined();
			expect(DEFAULT_CONFIG.channels.wechat).toBeUndefined();
		});

		it("should have connection config", () => {
			expect(DEFAULT_CONFIG.connection).toBeDefined();
			expect(DEFAULT_CONFIG.connection.retryMaxAttempts).toBeGreaterThan(0);
			expect(DEFAULT_CONFIG.connection.circuitBreakerThreshold).toBeGreaterThan(
				0,
			);
			expect(DEFAULT_CONFIG.connection.preferIPv4).toBe(true);
		});

		it("should have memory config with all sections", () => {
			expect(DEFAULT_CONFIG.memory).toBeDefined();
			expect(DEFAULT_CONFIG.memory.enabled).toBe(true);
			expect(DEFAULT_CONFIG.memory.shortTerm).toBeDefined();
			expect(DEFAULT_CONFIG.memory.longTerm).toBeDefined();
			expect(DEFAULT_CONFIG.memory.longTerm.vectorStore.collection).toBe(
				"octopus_memory",
			);
			expect(DEFAULT_CONFIG.memory.longTerm.vectorStore.timeoutMs).toBe(10000);
			expect(DEFAULT_CONFIG.memory.longTerm.vectorStore.maxRetries).toBe(2);
			expect(DEFAULT_CONFIG.memory.longTerm.vectorStore.retryBaseDelayMs).toBe(
				100,
			);
			expect(DEFAULT_CONFIG.memory.consolidation).toBeDefined();
			expect(DEFAULT_CONFIG.memory.retrieval).toBeDefined();
			expect(DEFAULT_CONFIG.memory.retrieval.weights).toBeDefined();
			expect(DEFAULT_CONFIG.memory.embeddings.enabled).toBe(false);
			expect(DEFAULT_CONFIG.memory.embeddings.provider).toBe("auto");
			expect(DEFAULT_CONFIG.memory.embeddings.apiType).toBe("openai");
			expect(DEFAULT_CONFIG.memory.embeddings.task).toBe("document");
			expect(DEFAULT_CONFIG.memory.embeddings.dimensions).toBe(1024);
			expect(DEFAULT_CONFIG.memory.embeddings.failureRetryMs).toBe(60000);
			expect(DEFAULT_CONFIG.memory.retention.enabled).toBe(false);
			expect(DEFAULT_CONFIG.memory.retention.cron).toBe("30 3 * * *");
			expect(DEFAULT_CONFIG.memory.retention.unusedDays).toBe(90);
		});

		it("should have skills config with forge and improvement", () => {
			expect(DEFAULT_CONFIG.skills).toBeDefined();
			expect(DEFAULT_CONFIG.skills.enabled).toBe(true);
			expect(DEFAULT_CONFIG.skills.forge).toBeDefined();
			expect(DEFAULT_CONFIG.skills.improvement).toBeDefined();
			expect(DEFAULT_CONFIG.skills.loading).toBeDefined();
			expect(DEFAULT_CONFIG.skills.registry).toBeDefined();
		});

		it("should have learning config", () => {
			expect(DEFAULT_CONFIG.learning).toBeDefined();
			expect(DEFAULT_CONFIG.learning.enabled).toBe(true);
			expect(DEFAULT_CONFIG.learning.minConfidenceToStore).toBeGreaterThan(0);
			expect(DEFAULT_CONFIG.learning.maxInsightsPerContext).toBeGreaterThan(0);
		});

		it("should have plugins config", () => {
			expect(DEFAULT_CONFIG.plugins).toBeDefined();
			expect(DEFAULT_CONFIG.plugins.directories).toBeDefined();
			expect(DEFAULT_CONFIG.plugins.builtin).toBeDefined();
			expect(DEFAULT_CONFIG.plugins.builtin.length).toBeGreaterThan(0);
		});

		it("should have storage config", () => {
			expect(DEFAULT_CONFIG.storage).toBeDefined();
			expect(DEFAULT_CONFIG.storage.backend).toBe("sqlite");
			expect(DEFAULT_CONFIG.storage.path).toContain(".octopus");
			expect(DEFAULT_CONFIG.storage.connectionString).toBe("");
			expect(DEFAULT_CONFIG.storage.ssl).toBe(false);
		});

		it("should have security config", () => {
			expect(DEFAULT_CONFIG.security).toBeDefined();
			expect(DEFAULT_CONFIG.security.memoryApiKey).toBe("");
			expect(DEFAULT_CONFIG.security.sandboxCommands).toBe(true);
			expect(DEFAULT_CONFIG.security.commandApproval.mode).toBe("smart");
			expect(DEFAULT_CONFIG.security.commandApproval.allowlist).toEqual([]);
			expect(DEFAULT_CONFIG.security.redaction.enabled).toBe(true);
			expect(DEFAULT_CONFIG.security.urlPolicy.enabled).toBe(true);
			expect(DEFAULT_CONFIG.security.urlPolicy.allowPrivateNetworks).toBe(
				false,
			);
			expect(DEFAULT_CONFIG.security.urlPolicy.dnsLookup.enabled).toBe(true);
			expect(DEFAULT_CONFIG.security.urlPolicy.dnsLookup.failClosed).toBe(true);
			expect(DEFAULT_CONFIG.security.envFiltering.enabled).toBe(true);
			expect(DEFAULT_CONFIG.security.contentScanning.mode).toBe("annotate");
		});

		it("should enable tool iteration limits by default", () => {
			expect(DEFAULT_CONFIG.tools.iterationLimit.enabled).toBe(true);
			expect(DEFAULT_CONFIG.tools.iterationLimit.maxIterations).toBe(256);
		});

		it("should have valid retrieval weight sum close to 1", () => {
			const weights = DEFAULT_CONFIG.memory.retrieval.weights;
			const sum = weights.relevance + weights.recency + weights.frequency;
			expect(sum).toBeCloseTo(1.0, 1);
		});
	});

	describe("getDefaults", () => {
		it("should return a deep copy", () => {
			const defaults1 = getDefaults();
			const defaults2 = getDefaults();
			expect(defaults1).toEqual(defaults2);
			defaults1.server.port = 9999;
			expect(defaults2.server.port).toBe(18789);
		});
	});
});
