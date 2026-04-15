import { describe, it, expect } from 'vitest';
import { TokenCounter } from '../ai/tokenizer.js';

describe('TokenCounter', () => {
  const counter = new TokenCounter();

  describe('countTokens', () => {
    it('should count tokens for simple text', () => {
      const count = counter.countTokens('Hello, world!');
      expect(count).toBeGreaterThan(0);
    });

    it('should return 0 for empty string', () => {
      expect(counter.countTokens('')).toBe(0);
    });

    it('should count more tokens for longer text', () => {
      const short = counter.countTokens('Hello');
      const long = counter.countTokens('Hello, this is a much longer sentence with many more words and tokens.');
      expect(long).toBeGreaterThan(short);
    });

    it('should handle special characters', () => {
      const count = counter.countTokens('function test() { return "hello 🎉"; }');
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('countMessagesTokens', () => {
    it('should count tokens for messages', () => {
      const messages = [
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      const count = counter.countMessagesTokens(messages);
      expect(count).toBeGreaterThan(0);
    });

    it('should handle messages with toolCalls', () => {
      const messages = [
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 'call_1', type: 'function' as const, function: { name: 'test', arguments: '{}' } }],
        },
      ];
      const count = counter.countMessagesTokens(messages);
      expect(count).toBeGreaterThan(0);
    });

    it('should handle empty array', () => {
      expect(counter.countMessagesTokens([])).toBe(2);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate roughly 1 token per 3.5 chars', () => {
      const text = 'This is about thirty-five characters';
      const estimate = counter.estimateTokens(text);
      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(text.length);
    });

    it('should return 0 for empty string', () => {
      expect(counter.estimateTokens('')).toBe(0);
    });
  });
});
