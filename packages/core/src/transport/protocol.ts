import { nanoid } from "nanoid";

export enum MessageType {
	request = "request",
	response = "response",
	event = "event",
	stream = "stream",
	stream_end = "stream_end",
	error = "error",
	ping = "ping",
	pong = "pong",
}

export interface ProtocolMessage<T> {
	id: string;
	type: MessageType;
	channel: string;
	payload: T;
	timestamp: number;
	metadata?: Record<string, unknown>;
}

export function createMessage<T>(
	type: MessageType,
	channel: string,
	payload: T,
): ProtocolMessage<T> {
	return {
		id: nanoid(16),
		type,
		channel,
		payload,
		timestamp: Date.now(),
	};
}

export function parseMessage(data: string | Buffer): ProtocolMessage<unknown> {
	const raw = typeof data === "string" ? data : data.toString("utf-8");
	const parsed = JSON.parse(raw) as ProtocolMessage<unknown>;
	if (
		typeof parsed.id !== "string" ||
		typeof parsed.type !== "string" ||
		typeof parsed.channel !== "string" ||
		!("payload" in parsed) ||
		typeof parsed.timestamp !== "number"
	) {
		throw new Error("Invalid protocol message format");
	}
	return parsed;
}

export function serializeMessage(msg: ProtocolMessage<unknown>): string {
	return JSON.stringify(msg);
}
