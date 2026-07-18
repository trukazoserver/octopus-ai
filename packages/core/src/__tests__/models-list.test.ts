import { describe, expect, it } from "vitest";
import { parseModelIds } from "../ai/providers/base.js";

describe("parseModelIds", () => {
	it("parses the OpenAI/Anthropic/Zhipu {data:[{id}]} shape", () => {
		expect(parseModelIds({ data: [{ id: "gpt-4o" }, { id: "o3" }] })).toEqual([
			"gpt-4o",
			"o3",
		]);
	});

	it("parses the Ollama/Cohere {models:[{name}]} shape", () => {
		expect(
			parseModelIds({ models: [{ name: "llama3.1" }, { name: "qwen2.5" }] }),
		).toEqual(["llama3.1", "qwen2.5"]);
	});

	it("parses the Codex {models:[{slug}]} shape", () => {
		expect(parseModelIds({ models: [{ slug: "gpt-5.5" }] })).toEqual([
			"gpt-5.5",
		]);
	});

	it("parses a {models:[{id}]} shape (some providers use id inside models)", () => {
		expect(parseModelIds({ models: [{ id: "m1" }, { id: "m2" }] })).toEqual([
			"m1",
			"m2",
		]);
	});

	it("strips the Google `models/` prefix", () => {
		expect(
			parseModelIds({ models: [{ name: "models/gemini-2.5-pro" }] }),
		).toEqual(["gemini-2.5-pro"]);
	});

	it("parses a bare top-level array", () => {
		expect(parseModelIds([{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
	});

	it("deduplicates ids", () => {
		expect(parseModelIds({ data: [{ id: "x" }, { id: "x" }] })).toEqual(["x"]);
	});

	it("returns [] for empty / unparseable payloads", () => {
		expect(parseModelIds({})).toEqual([]);
		expect(parseModelIds({ data: [] })).toEqual([]);
		expect(parseModelIds(null)).toEqual([]);
		expect(parseModelIds({ unrelated: 1 })).toEqual([]);
	});

	it("ignores entries without a usable id/name/slug", () => {
		expect(
			parseModelIds({ data: [{ id: "ok" }, { foo: "bar" }, { id: "" }] }),
		).toEqual(["ok"]);
	});
});
