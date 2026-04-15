import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolResult } from '../tools/registry.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  const createTool = (name: string): ToolDefinition => ({
    name,
    description: `Tool ${name}`,
    parameters: {
      input: { type: 'string', description: 'Input value', required: true },
    },
    handler: async (params) => ({
      success: true,
      output: `result from ${name}: ${params.input}`,
    }),
  });

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register', () => {
    it('should register a tool', () => {
      registry.register(createTool('read-file'));
      expect(registry.has('read-file')).toBe(true);
    });

    it('should overwrite existing tool', () => {
      registry.register(createTool('tool'));
      const updated = createTool('tool');
      updated.description = 'Updated description';
      registry.register(updated);
      expect(registry.get('tool')?.description).toBe('Updated description');
    });
  });

  describe('unregister', () => {
    it('should remove a tool', () => {
      registry.register(createTool('tool'));
      registry.unregister('tool');
      expect(registry.has('tool')).toBe(false);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should return the registered tool', () => {
      const tool = createTool('my-tool');
      registry.register(tool);
      expect(registry.get('my-tool')).toBe(tool);
    });
  });

  describe('list', () => {
    it('should return empty array when no tools registered', () => {
      expect(registry.list()).toHaveLength(0);
    });

    it('should return all registered tools', () => {
      registry.register(createTool('a'));
      registry.register(createTool('b'));
      registry.register(createTool('c'));
      expect(registry.list()).toHaveLength(3);
    });
  });

  describe('has', () => {
    it('should return true for registered tool', () => {
      registry.register(createTool('exists'));
      expect(registry.has('exists')).toBe(true);
    });

    it('should return false for non-existent tool', () => {
      expect(registry.has('nope')).toBe(false);
    });
  });

  describe('toLLMTools', () => {
    it('should convert to LLM tool format', () => {
      registry.register(createTool('calculator'));
      const llmTools = registry.toLLMTools();
      expect(llmTools).toHaveLength(1);
      expect(llmTools[0]!.type).toBe('function');
      expect(llmTools[0]!.function.name).toBe('calculator');
      expect(llmTools[0]!.function.parameters).toBeDefined();
      expect(llmTools[0]!.function.parameters.type).toBe('object');
    });

    it('should mark required parameters', () => {
      registry.register(createTool('tool'));
      const llmTools = registry.toLLMTools();
      expect(llmTools[0]!.function.parameters.required).toContain('input');
    });
  });
});
