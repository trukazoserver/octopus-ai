import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleProvider } from "../ai/providers/google.js";
import type { LLMChunk } from "../ai/types.js";

/**
 * The native Vertex path is exercised end-to-end by mocking `fetch` and
 * capturing the request URL + body it received, plus the response we return.
 * Auth is bypassed by setting `accessToken` (vertexAccessToken returns it
 * verbatim, no JWT exchange).
 */

interface CapturedCall {
	url: string;
	body: unknown;
}

let calls: CapturedCall[] = [];

function jsonResponse(json: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => json,
		text: async () => JSON.stringify(json),
	} as unknown as Response;
}

function sseResponse(chunks: string[]): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		},
	});
	return {
		ok: true,
		status: 200,
		body: stream,
		text: async () => "",
	} as unknown as Response;
}

describe("GoogleProvider Vertex native API", () => {
	beforeEach(() => {
		calls = [];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("builds the native URL with global host + generateContent", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "proj-1",
			location: "global",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({
					url,
					body: init.body ? JSON.parse(init.body as string) : null,
				});
				return jsonResponse({
					candidates: [
						{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
					],
				});
			}),
		);

		await provider.chat({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: "hi" }],
		});

		expect(calls[0].url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-2.5-flash:generateContent",
		);
	});

	it("builds the regional host + streamGenerateContent?alt=sse for streaming", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "us-central1",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({
					url,
					body: init.body ? JSON.parse(init.body as string) : null,
				});
				return sseResponse(["data: \n\n"]);
			}),
		);

		const out: LLMChunk[] = [];
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const _c of provider.chatStream({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: "hi" }],
		})) {
			out.push(_c);
		}

		expect(calls[0].url).toBe(
			"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
	});

	it("converts messages: system→systemInstruction, user→contents, tools→functionDeclarations", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({
					url,
					body: init.body ? JSON.parse(init.body as string) : null,
				});
				return jsonResponse({
					candidates: [
						{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
					],
				});
			}),
		);

		await provider.chat({
			model: "gemini-2.5-flash",
			messages: [
				{ role: "system", content: "Be helpful" },
				{ role: "user", content: "hi" },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "search",
						description: "search the web",
						parameters: { type: "object", properties: {} },
					},
				},
			],
			maxTokens: 256,
			temperature: 0.5,
		});

		const body = calls[0].body as Record<string, unknown>;
		expect(body.systemInstruction).toEqual({ parts: [{ text: "Be helpful" }] });
		expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
		const tools = body.tools as Array<{ functionDeclarations: unknown[] }>;
		expect(tools[0].functionDeclarations[0]).toMatchObject({ name: "search" });
		const genConfig = body.generationConfig as Record<string, unknown>;
		expect(genConfig.maxOutputTokens).toBe(256);
		expect(genConfig.temperature).toBe(0.5);
	});

	it("maps assistant toolCalls→functionCall and tool role→functionResponse", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({
					url,
					body: init.body ? JSON.parse(init.body as string) : null,
				});
				return jsonResponse({
					candidates: [
						{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
					],
				});
			}),
		);

		await provider.chat({
			model: "gemini-2.5-flash",
			messages: [
				{ role: "user", content: "search for cats" },
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "search", arguments: '{"q":"cats"}' },
						},
					],
				},
				{ role: "tool", content: "results", toolCallId: "search" },
			],
		});

		const contents = (
			calls[0].body as { contents: Array<Record<string, unknown>> }
		).contents;
		// assistant turn has a functionCall part
		const assistant = contents[1];
		expect(assistant.role).toBe("model");
		expect(
			(assistant.parts as Array<Record<string, unknown>>).some(
				(p) => p.functionCall,
			),
		).toBe(true);
		// tool turn has a functionResponse part on a user role
		const tool = contents[2];
		expect(tool.role).toBe("user");
		expect(
			(tool.parts as Array<Record<string, unknown>>).some(
				(p) => p.functionResponse,
			),
		).toBe(true);
	});

	it("parses a non-stream Gemini response (content, toolCalls, usageMetadata)", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					candidates: [
						{
							content: {
								parts: [
									{ text: "Calling tool" },
									{ functionCall: { name: "search", args: { q: "x" } } },
								],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						thoughtsTokenCount: 3,
					},
				}),
			),
		);

		const res = await provider.chat({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: "go" }],
		});

		expect(res.content).toBe("Calling tool");
		expect(res.toolCalls?.[0].function.name).toBe("search");
		expect(res.toolCalls?.[0].function.arguments).toBe('{"q":"x"}');
		expect(res.usage.promptTokens).toBe(10);
		expect(res.usage.completionTokens).toBe(5);
		expect(res.usage.reasoningTokens).toBe(3);
		expect(res.finishReason).toBe("STOP");
	});

	it("parses an SSE stream into content/finishReason/usage chunks", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		const chunk1 = `data: ${JSON.stringify({
			candidates: [{ content: { parts: [{ text: "Hel" }] } }],
		})}\r\n\r\n`;
		const chunk2 = `data: ${JSON.stringify({
			candidates: [
				{ content: { parts: [{ text: "lo!" }] }, finishReason: "STOP" },
			],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
		})}\r\n\r\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => sseResponse([chunk1, chunk2])),
		);

		const out: LLMChunk[] = [];
		for await (const c of provider.chatStream({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: "hi" }],
		})) {
			out.push(c);
		}

		const text = out
			.filter((c) => c.content)
			.map((c) => c.content)
			.join("");
		expect(text).toBe("Hello!");
		expect(out.some((c) => c.finishReason === "STOP")).toBe(true);
		const usage = out.find((c) => c.usage)?.usage;
		expect(usage?.promptTokens).toBe(1);
		expect(usage?.completionTokens).toBe(2);
	});
});
