import { describe, expect, it } from "vitest";
import {
	MessageType,
	createMessage,
	parseMessage,
	serializeMessage,
} from "../transport/protocol.js";

describe("Protocol", () => {
	describe("createMessage", () => {
		it("should create a valid protocol message", () => {
			const msg = createMessage(MessageType.request, "test-channel", {
				action: "ping",
			});
			expect(msg.id).toBeTruthy();
			expect(msg.type).toBe(MessageType.request);
			expect(msg.channel).toBe("test-channel");
			expect(msg.payload).toEqual({ action: "ping" });
			expect(msg.timestamp).toBeGreaterThan(0);
		});

		it("should create messages with unique IDs", () => {
			const msg1 = createMessage(MessageType.request, "ch", {});
			const msg2 = createMessage(MessageType.request, "ch", {});
			expect(msg1.id).not.toBe(msg2.id);
		});
	});

	describe("parseMessage", () => {
		it("should parse a valid JSON string", () => {
			const msg = createMessage(MessageType.response, "ch", { result: "ok" });
			const serialized = serializeMessage(msg);
			const parsed = parseMessage(serialized);
			expect(parsed.id).toBe(msg.id);
			expect(parsed.type).toBe(MessageType.response);
			expect(parsed.channel).toBe("ch");
			expect(parsed.payload).toEqual({ result: "ok" });
		});

		it("should parse a Buffer", () => {
			const msg = createMessage(MessageType.event, "ch", { data: 42 });
			const serialized = serializeMessage(msg);
			const buffer = Buffer.from(serialized, "utf-8");
			const parsed = parseMessage(buffer);
			expect(parsed.payload).toEqual({ data: 42 });
		});

		it("should throw on invalid JSON", () => {
			expect(() => parseMessage("not json")).toThrow();
		});

		it("should throw on missing required fields", () => {
			expect(() => parseMessage(JSON.stringify({ id: "1" }))).toThrow(
				"Invalid protocol message format",
			);
		});

		it("should throw on wrong field types", () => {
			expect(() =>
				parseMessage(
					JSON.stringify({
						id: 123,
						type: "request",
						channel: "ch",
						payload: {},
						timestamp: "now",
					}),
				),
			).toThrow("Invalid protocol message format");
		});
	});

	describe("serializeMessage", () => {
		it("should produce valid JSON", () => {
			const msg = createMessage(MessageType.ping, "ch", null);
			const serialized = serializeMessage(msg);
			const parsed = JSON.parse(serialized);
			expect(parsed.id).toBe(msg.id);
		});
	});

	describe("MessageType enum", () => {
		it("should have all expected types", () => {
			expect(MessageType.request).toBe("request");
			expect(MessageType.response).toBe("response");
			expect(MessageType.event).toBe("event");
			expect(MessageType.stream).toBe("stream");
			expect(MessageType.stream_end).toBe("stream_end");
			expect(MessageType.error).toBe("error");
			expect(MessageType.ping).toBe("ping");
			expect(MessageType.pong).toBe("pong");
		});
	});
});
