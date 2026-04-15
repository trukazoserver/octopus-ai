import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, getDefaults } from '../config/defaults.js';

describe('Config Defaults', () => {
  describe('DEFAULT_CONFIG', () => {
    it('should have a version', () => {
      expect(DEFAULT_CONFIG.version).toBe(1);
    });

    it('should have server config', () => {
      expect(DEFAULT_CONFIG.server).toBeDefined();
      expect(DEFAULT_CONFIG.server.port).toBe(18789);
      expect(DEFAULT_CONFIG.server.host).toBe('127.0.0.1');
      expect(DEFAULT_CONFIG.server.transport).toBe('auto');
    });

    it('should have AI config with providers', () => {
      expect(DEFAULT_CONFIG.ai).toBeDefined();
      expect(DEFAULT_CONFIG.ai.default).toBeTruthy();
      expect(DEFAULT_CONFIG.ai.providers).toBeDefined();
      expect(DEFAULT_CONFIG.ai.providers.anthropic).toBeDefined();
      expect(DEFAULT_CONFIG.ai.providers.openai).toBeDefined();
      expect(DEFAULT_CONFIG.ai.providers.google).toBeDefined();
      expect(DEFAULT_CONFIG.ai.providers.local).toBeDefined();
    });

    it('should have channel config with all channels', () => {
      expect(DEFAULT_CONFIG.channels).toBeDefined();
      expect(DEFAULT_CONFIG.channels.whatsapp).toBeDefined();
      expect(DEFAULT_CONFIG.channels.telegram).toBeDefined();
      expect(DEFAULT_CONFIG.channels.discord).toBeDefined();
      expect(DEFAULT_CONFIG.channels.slack).toBeDefined();
      expect(DEFAULT_CONFIG.channels.webchat).toBeDefined();
      expect(DEFAULT_CONFIG.channels.webchat.enabled).toBe(true);
    });

    it('should have connection config', () => {
      expect(DEFAULT_CONFIG.connection).toBeDefined();
      expect(DEFAULT_CONFIG.connection.retryMaxAttempts).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.connection.circuitBreakerThreshold).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.connection.preferIPv4).toBe(true);
    });

    it('should have memory config with all sections', () => {
      expect(DEFAULT_CONFIG.memory).toBeDefined();
      expect(DEFAULT_CONFIG.memory.enabled).toBe(true);
      expect(DEFAULT_CONFIG.memory.shortTerm).toBeDefined();
      expect(DEFAULT_CONFIG.memory.longTerm).toBeDefined();
      expect(DEFAULT_CONFIG.memory.consolidation).toBeDefined();
      expect(DEFAULT_CONFIG.memory.retrieval).toBeDefined();
      expect(DEFAULT_CONFIG.memory.retrieval.weights).toBeDefined();
    });

    it('should have skills config with forge and improvement', () => {
      expect(DEFAULT_CONFIG.skills).toBeDefined();
      expect(DEFAULT_CONFIG.skills.enabled).toBe(true);
      expect(DEFAULT_CONFIG.skills.forge).toBeDefined();
      expect(DEFAULT_CONFIG.skills.improvement).toBeDefined();
      expect(DEFAULT_CONFIG.skills.loading).toBeDefined();
      expect(DEFAULT_CONFIG.skills.registry).toBeDefined();
    });

    it('should have plugins config', () => {
      expect(DEFAULT_CONFIG.plugins).toBeDefined();
      expect(DEFAULT_CONFIG.plugins.directories).toBeDefined();
      expect(DEFAULT_CONFIG.plugins.builtin).toBeDefined();
      expect(DEFAULT_CONFIG.plugins.builtin.length).toBeGreaterThan(0);
    });

    it('should have storage config', () => {
      expect(DEFAULT_CONFIG.storage).toBeDefined();
      expect(DEFAULT_CONFIG.storage.backend).toBe('sqlite');
      expect(DEFAULT_CONFIG.storage.path).toContain('.octopus');
    });

    it('should have security config', () => {
      expect(DEFAULT_CONFIG.security).toBeDefined();
      expect(DEFAULT_CONFIG.security.sandboxCommands).toBe(true);
    });

    it('should have valid retrieval weight sum close to 1', () => {
      const weights = DEFAULT_CONFIG.memory.retrieval.weights;
      const sum = weights.relevance + weights.recency + weights.frequency;
      expect(sum).toBeCloseTo(1.0, 1);
    });
  });

  describe('getDefaults', () => {
    it('should return a deep copy', () => {
      const defaults1 = getDefaults();
      const defaults2 = getDefaults();
      expect(defaults1).toEqual(defaults2);
      defaults1.server.port = 9999;
      expect(defaults2.server.port).toBe(18789);
    });
  });
});
