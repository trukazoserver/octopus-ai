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
				return sseResponse([
					`data: ${JSON.stringify({
						candidates: [{ finishReason: "STOP" }],
					})}\n\n`,
				]);
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
				{ role: "tool", content: "results", toolCallId: "call_1" },
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
		expect(tool.parts).toEqual([
			{
				functionResponse: {
					name: "search",
					response: { content: "results" },
				},
			},
		]);
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

	it("parses a final tool call event without a trailing SSE delimiter", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		const event = `data:${JSON.stringify({
			candidates: [
				{
					content: {
						parts: [
							{
								functionCall: {
									name: "generate_image",
									args: { width: 2048, height: 1152 },
								},
								thoughtSignature: "sig-image",
							},
						],
					},
					finishReason: "STOP",
				},
			],
		})}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => sseResponse([event])),
		);

		const out: LLMChunk[] = [];
		for await (const chunk of provider.chatStream({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: "generate an image" }],
		})) {
			out.push(chunk);
		}

		expect(out.find((chunk) => chunk.toolCalls)?.toolCalls).toMatchObject({
			function: {
				name: "generate_image",
				arguments: '{"width":2048,"height":1152}',
			},
		});
		expect(out.some((chunk) => chunk.finishReason === "STOP")).toBe(true);
	});

	it("rejects a stream that closes before a terminal event", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sseResponse([
					`data: ${JSON.stringify({
						candidates: [{ content: { parts: [{ text: "partial" }] } }],
					})}\n\n`,
				]),
			),
		);

		const consume = async () => {
			for await (const _chunk of provider.chatStream({
				model: "gemini-2.5-flash",
				messages: [{ role: "user", content: "hi" }],
			})) {
				// Consume the complete stream to trigger the premature-close guard.
			}
		};

		await expect(consume()).rejects.toThrow("stream closed before completion");
	});

	it("keeps thought signatures associated with unique sequential tool calls", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		const responses = [
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: { name: "search", args: { q: "cats" } },
									thoughtSignature: "sig-search",
								},
							],
						},
						finishReason: "STOP",
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: { name: "download", args: { id: 1 } },
									thoughtSignature: "sig-download",
								},
							],
						},
						finishReason: "STOP",
					},
				],
			},
			{ candidates: [{ content: { parts: [{ text: "done" }] } }] },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				calls.push({
					url: String(_url),
					body: init.body ? JSON.parse(init.body as string) : null,
				});
				return jsonResponse(responses[calls.length - 1]);
			}),
		);

		const first = await provider.chat({
			model: "gemini-2.5-flash",
			messages: [{ role: "user", content: "start" }],
		});
		const firstCall = first.toolCalls?.[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) throw new Error("Expected first tool call");
		const secondMessages = [
			{ role: "user" as const, content: "start" },
			{
				role: "assistant" as const,
				content: "",
				toolCalls: [firstCall],
			},
			{ role: "tool" as const, content: "found", toolCallId: firstCall.id },
		];
		const second = await provider.chat({
			model: "gemini-2.5-flash",
			messages: secondMessages,
		});
		const secondCall = second.toolCalls?.[0];
		expect(secondCall).toBeDefined();
		if (!secondCall) throw new Error("Expected second tool call");
		expect(secondCall.id).not.toBe(firstCall.id);

		const reconfiguredProvider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		await reconfiguredProvider.chat({
			model: "gemini-2.5-flash",
			messages: [
				...secondMessages,
				{
					role: "assistant",
					content: "",
					toolCalls: [secondCall],
				},
				{
					role: "tool",
					content: "downloaded",
					toolCallId: secondCall.id,
				},
			],
		});

		const contents = (
			calls[2].body as {
				contents: Array<{ parts: Array<Record<string, unknown>> }>;
			}
		).contents;
		const functionCallParts = contents.flatMap((content) =>
			content.parts.filter((part) => part.functionCall),
		);
		expect(functionCallParts).toMatchObject([
			{ thoughtSignature: "sig-search" },
			{ thoughtSignature: "sig-download" },
		]);
	});

	it("keeps native call ids and omits generated image bytes from function responses", async () => {
		const provider = new GoogleProvider({
			authMode: "vertex",
			accessToken: "tok",
			projectId: "p",
			location: "global",
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementationOnce(async () =>
					jsonResponse({
						candidates: [
							{
								content: {
									parts: [
										{
											functionCall: {
												id: "server-call-7",
												name: "nano-banana-generate",
												args: { aspect_ratio: "16:9", resolution: "2K" },
											},
											thoughtSignature: "sig-image",
										},
									],
								},
								finishReason: "STOP",
							},
						],
					}),
				)
				.mockImplementationOnce(async (url: string, init: RequestInit) => {
					calls.push({
						url,
						body: init.body ? JSON.parse(init.body as string) : null,
					});
					return jsonResponse({
						candidates: [{ content: { parts: [{ text: "Image ready" }] } }],
					});
				}),
		);

		const first = await provider.chat({
			model: "gemini-3.1-flash-lite",
			messages: [{ role: "user", content: "Generate an image" }],
		});
		const toolCall = first.toolCalls?.[0];
		expect(toolCall?.id).toMatch(/^vertex-tc-/);
		if (!toolCall) throw new Error("Expected image tool call");

		const imageDataUrl = `data:image/png;base64,${"A".repeat(2_000_000)}`;
		await provider.chat({
			model: "gemini-3.1-flash-lite",
			messages: [
				{ role: "user", content: "Generate an image" },
				{ role: "assistant", content: "", toolCalls: [toolCall] },
				{
					role: "tool",
					toolCallId: toolCall.id,
					content: [
						{
							type: "text",
							text: "Generated: /api/media/file/cr7.png",
						},
						{ type: "image_url", image_url: { url: imageDataUrl } },
					],
				},
			],
		});

		const serializedBody = JSON.stringify(calls[0].body);
		expect(serializedBody.length).toBeLessThan(2_000);
		expect(serializedBody).not.toContain("data:image/png;base64");
		const contents = (
			calls[0].body as {
				contents: Array<{
					role: string;
					parts: Array<Record<string, unknown>>;
				}>;
			}
		).contents;
		expect(contents[1]).toEqual({
			role: "model",
			parts: [
				{
					functionCall: {
						id: "server-call-7",
						name: "nano-banana-generate",
						args: { aspect_ratio: "16:9", resolution: "2K" },
					},
					thoughtSignature: "sig-image",
				},
			],
		});
		expect(contents[2]).toEqual({
			role: "user",
			parts: [
				{
					functionResponse: {
						id: "server-call-7",
						name: "nano-banana-generate",
						response: {
							content: "Generated: /api/media/file/cr7.png",
						},
					},
				},
			],
		});
	});
});
