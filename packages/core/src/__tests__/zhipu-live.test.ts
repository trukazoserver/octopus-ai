import { describe, it, expect } from 'vitest';
import { ZhipuProvider } from '../ai/providers/zhipu.js';
import type { ZhipuApiMode } from '../ai/providers/zhipu.js';

const ZAI_API_KEY = process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY || '';

const modes: ZhipuApiMode[] = ['coding-plan', 'api'];

for (const mode of modes) {
  describe(`Z.ai GLM Provider (${mode})`, () => {
    const provider = new ZhipuProvider({ apiKey: ZAI_API_KEY, mode });

    it('should initialize with correct endpoint', () => {
      expect(provider.getMode()).toBe(mode);
      if (mode === 'coding-plan') {
        expect(provider.getBaseUrl()).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
      } else {
        expect(provider.getBaseUrl()).toBe('https://open.bigmodel.cn/api/paas/v4');
      }
    });

    it('should be available with valid API key', async () => {
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('should complete a simple chat request', async () => {
      try {
        const response = await provider.chat({
          model: 'glm-5.1',
          messages: [
            { role: 'system', content: 'You are a helpful assistant. Respond in exactly 5 words.' },
            { role: 'user', content: 'What is Octopus AI?' },
          ],
          maxTokens: 100,
          temperature: 0.7,
          reasoning: { effort: 'none' },
        });

        expect(response).toBeDefined();
        expect(response.content || response.thinking).toBeTruthy();
        expect(response.content.length + (response.thinking?.[0]?.text.length ?? 0)).toBeGreaterThan(0);
        expect(response.model).toBeTruthy();
        expect(response.finishReason).toBeTruthy();
        const display = response.content || response.thinking?.[0]?.text || '';
        console.log(`  [${mode}] Response: "${display.slice(0, 100)}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429') || msg.includes('余额') || msg.includes('insufficient') || msg.includes('quota')) {
          console.warn(`  [${mode}] Skipped: No credits/quota (${msg.slice(0, 80)})`);
          return;
        }
        throw err;
      }
    }, 30000);

    it('should handle tool calling', async () => {
      try {
        const tools = [
          {
            type: 'function' as const,
            function: {
              name: 'get_weather',
              description: 'Get the current weather for a location',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'City name' },
                },
                required: ['location'],
              },
            },
          },
        ];

        const response = await provider.chat({
          model: 'glm-5.1',
          messages: [
            { role: 'user', content: 'What is the weather in Tokyo right now?' },
          ],
          tools,
          maxTokens: 500,
        });

        expect(response).toBeDefined();
        if (response.toolCalls && response.toolCalls.length > 0) {
          const tc = response.toolCalls[0]!;
          expect(tc.function.name).toBe('get_weather');
          const args = JSON.parse(tc.function.arguments);
          expect(args).toHaveProperty('location');
          console.log(`  [${mode}] Tool call: ${tc.function.name}(${JSON.stringify(args)})`);
        } else {
          console.log(`  [${mode}] No tool call (content: "${response.content.slice(0, 80)}")`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429') || msg.includes('余额') || msg.includes('insufficient') || msg.includes('quota')) {
          console.warn(`  [${mode}] Skipped: No credits/quota`);
          return;
        }
        throw err;
      }
    }, 30000);

    it('should stream a response', async () => {
      try {
        const chunks: string[] = [];
        for await (const chunk of provider.chatStream({
          model: 'glm-5.1',
          messages: [
            { role: 'user', content: 'Say hello in 3 different languages. Be brief.' },
          ],
          maxTokens: 200,
          reasoning: { effort: 'none' },
        })) {
          if (chunk.content) {
            chunks.push(chunk.content);
          }
        }

        expect(chunks.length).toBeGreaterThan(0);
        const full = chunks.join('');
        console.log(`  [${mode}] Stream: "${full.slice(0, 100)}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429') || msg.includes('余额') || msg.includes('insufficient') || msg.includes('quota')) {
          console.warn(`  [${mode}] Skipped: No credits/quota`);
          return;
        }
        throw err;
      }
    }, 30000);
  });
}
