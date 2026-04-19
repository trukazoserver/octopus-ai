import { describe, expect, it } from "vitest";
import { ZhipuProvider } from "../ai/providers/zhipu.js";
import { LLMRouter } from "../ai/router.js";
import type { LLMRequest } from "../ai/types.js";

const ZAI_API_KEY = process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY || "";
const hasApiKey = ZAI_API_KEY.length > 0;

function handleQuotaError(err: unknown, label: string): void {
	const msg = err instanceof Error ? err.message : String(err);
	if (
		msg.includes("429") ||
		msg.includes("余额") ||
		msg.includes("insufficient") ||
		msg.includes("quota")
	) {
		console.warn(`  [${label}] Skipped: Sin créditos (${msg.slice(0, 80)})`);
		return;
	}
	throw err;
}

describe.skipIf(!hasApiKey)("Reasoning - ZhipuProvider directo", () => {
	const provider = new ZhipuProvider({
		apiKey: ZAI_API_KEY,
		mode: "coding-plan",
	});

	it("debe separar reasoning_content como thinking cuando hay contenido", async () => {
		try {
			const response = await provider.chat({
				model: "glm-5.1",
				messages: [
					{ role: "user", content: "¿Cuánto es 15 * 23? Piensa paso a paso." },
				],
				maxTokens: 500,
				reasoning: { effort: "high", includeThinking: true },
			});

			expect(response).toBeDefined();
			console.log(`  Content: "${response.content.slice(0, 200)}"`);
			if (response.thinking) {
				console.log(
					`  Thinking (${response.thinking.length} bloques): "${response.thinking[0]?.text.slice(0, 200)}"`,
				);
			}
			if (response.usage.reasoningTokens) {
				console.log(`  Reasoning tokens: ${response.usage.reasoningTokens}`);
			}
		} catch (err) {
			handleQuotaError(err, "zhipu-direct");
		}
	}, 90000);

	it("debe hacer streaming con thinking separado", async () => {
		try {
			const contentChunks: string[] = [];
			const thinkingChunks: string[] = [];

			for await (const chunk of provider.chatStream({
				model: "glm-4.7",
				messages: [
					{
						role: "user",
						content: "Explica por qué el cielo es azul, paso a paso.",
					},
				],
				maxTokens: 800,
				reasoning: { effort: "medium", includeThinking: true },
			})) {
				if (chunk.content) contentChunks.push(chunk.content);
				if (chunk.thinking) thinkingChunks.push(chunk.thinking);
			}

			const fullContent = contentChunks.join("");
			const fullThinking = thinkingChunks.join("");
			console.log(`  Stream content: "${fullContent.slice(0, 150)}"`);
			if (fullThinking) {
				console.log(
					`  Stream thinking (${thinkingChunks.length} chunks): "${fullThinking.slice(0, 150)}"`,
				);
			} else {
				console.log("  Stream thinking: no devuelto");
			}
			expect(fullContent.length + fullThinking.length).toBeGreaterThan(0);
		} catch (err) {
			handleQuotaError(err, "zhipu-stream");
		}
	}, 60000);
});

describe.skipIf(!hasApiKey)(
	"Reasoning - LLMRouter inyección automática",
	() => {
		it("debe inyectar reasoning desde config thinking=high", async () => {
			const router = new LLMRouter({
				default: "zhipu",
				providers: {
					zhipu: { apiKey: ZAI_API_KEY, mode: "coding-plan" },
				},
				thinking: "high",
			});
			await router.initialize();

			try {
				const response = await router.chat({
					model: "glm-5.1",
					messages: [
						{
							role: "user",
							content:
								"¿Cuántos números primos hay entre 1 y 50? Piensa paso a paso.",
						},
					],
					maxTokens: 300,
				});

				expect(response).toBeDefined();
				expect(response.content || response.thinking).toBeTruthy();
				console.log(`  Router content: "${response.content.slice(0, 200)}"`);
				if (response.thinking) {
					console.log(
						`  Router thinking: "${response.thinking[0]?.text.slice(0, 200)}"`,
					);
				}
			} catch (err) {
				handleQuotaError(err, "router");
			}
		}, 60000);

		it("debe hacer streaming via router con thinking inyectado", async () => {
			const router = new LLMRouter({
				default: "zhipu",
				providers: {
					zhipu: { apiKey: ZAI_API_KEY, mode: "coding-plan" },
				},
				thinking: "medium",
			});
			await router.initialize();

			try {
				const chunks: string[] = [];
				const thinkingChunks: string[] = [];

				for await (const chunk of router.chatStream({
					model: "glm-5.1",
					messages: [
						{
							role: "user",
							content: "Dime 3 datos interesantes sobre los pulpos. Sé breve.",
						},
					],
					maxTokens: 300,
				})) {
					if (chunk.content) chunks.push(chunk.content);
					if (chunk.thinking) thinkingChunks.push(chunk.thinking);
				}

				const full = chunks.join("");
				const fullThinking = thinkingChunks.join("");
				console.log(`  Router stream: "${full.slice(0, 150)}"`);
				if (thinkingChunks.length > 0) {
					console.log(
						`  Router stream thinking (${thinkingChunks.length} chunks)`,
					);
				}
				expect(full.length + fullThinking.length).toBeGreaterThan(0);
			} catch (err) {
				handleQuotaError(err, "router-stream");
			}
		}, 60000);
	},
);

describe.skipIf(!hasApiKey)("Reasoning - sin reasoning (effort=none)", () => {
	const provider = new ZhipuProvider({
		apiKey: ZAI_API_KEY,
		mode: "coding-plan",
	});

	it("debe funcionar normalmente sin reasoning", async () => {
		try {
			const response = await provider.chat({
				model: "glm-5.1",
				messages: [
					{
						role: "user",
						content: 'Di "hola mundo" en español, francés y alemán.',
					},
				],
				maxTokens: 100,
				reasoning: { effort: "none" },
			});

			expect(response).toBeDefined();
			expect(response.content).toBeTruthy();
			console.log(`  Sin reasoning: "${response.content.slice(0, 150)}"`);
		} catch (err) {
			handleQuotaError(err, "no-reasoning");
		}
	}, 30000);
});

describe.skipIf(!hasApiKey)(
	"Reasoning - request manual sin config global",
	() => {
		const provider = new ZhipuProvider({
			apiKey: ZAI_API_KEY,
			mode: "coding-plan",
		});

		it("debe aceptar reasoning directo en el request", async () => {
			try {
				const response = await provider.chat({
					model: "glm-5.1",
					messages: [
						{
							role: "user",
							content:
								"Si tengo 3 manzanas y doy 1, ¿cuántas me quedan? Razona tu respuesta.",
						},
					],
					maxTokens: 200,
					reasoning: {
						effort: "low",
						includeThinking: true,
					},
				});

				expect(response).toBeDefined();
				expect(response.content || response.thinking).toBeTruthy();
				console.log(`  Manual reasoning: "${response.content.slice(0, 150)}"`);
				if (response.thinking) {
					console.log(`  Thinking: sí (${response.thinking.length} bloques)`);
				}
			} catch (err) {
				handleQuotaError(err, "manual");
			}
		}, 30000);
	},
);
