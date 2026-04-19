import { EventEmitter } from "eventemitter3";
import WebSocket from "ws";
import {
	MessageType,
	type ProtocolMessage,
	createMessage,
	parseMessage,
	serializeMessage,
} from "./protocol.js";

interface ClientEvents {
	connect: () => void;
	disconnect: () => void;
}

export interface TransportClientOptions {
	url: string;
	reconnect?: boolean;
	reconnectInterval?: number;
}

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class TransportClient {
	private url: string;
	private shouldReconnect: boolean;
	private baseReconnectInterval: number;
	private ws: WebSocket | null = null;
	private emitter = new EventEmitter<ClientEvents>();
	private messageHandlers = new Map<string, Set<(payload: unknown) => void>>();
	private pendingRequests = new Map<string, PendingRequest>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;

	constructor(opts: TransportClientOptions) {
		this.url = opts.url;
		this.shouldReconnect = opts.reconnect ?? true;
		this.baseReconnectInterval = opts.reconnectInterval ?? 1000;
	}

	async connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(this.url);

			const onError = (err: Error) => {
				ws.removeListener("open", onOpen);
				ws.removeListener("error", onError);
				reject(err);
			};

			const onOpen = () => {
				ws.removeListener("open", onOpen);
				ws.removeListener("error", onError);
				resolve();
			};

			ws.once("error", onError);
			ws.once("open", onOpen);

			ws.on("message", (raw: Buffer) => {
				try {
					const msg = parseMessage(raw);
					this.handleMessage(msg);
				} catch {}
			});

			ws.on("close", () => {
				this.ws = null;
				this.emitter.emit("disconnect");
				this.rejectAllPending("Connection closed");
				if (this.shouldReconnect) {
					this.scheduleReconnect();
				}
			});

			ws.on("error", () => {});

			this.ws = ws;
			this.reconnectAttempts = 0;
			this.emitter.emit("connect");
		});
	}

	disconnect(): void {
		this.shouldReconnect = false;
		this.clearReconnectTimer();
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	request<T>(channel: string, payload: unknown, timeout = 30000): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error("Not connected"));
				return;
			}

			const msg = createMessage(MessageType.request, channel, payload);
			const timer = setTimeout(() => {
				this.pendingRequests.delete(msg.id);
				reject(new Error(`Request timeout for channel "${channel}"`));
			}, timeout);

			this.pendingRequests.set(msg.id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
			});

			this.ws.send(serializeMessage(msg));
		});
	}

	send(channel: string, payload: unknown): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}
		const msg = createMessage(MessageType.event, channel, payload);
		this.ws.send(serializeMessage(msg));
	}

	subscribe(channel: string, handler: (payload: unknown) => void): () => void {
		let handlers = this.messageHandlers.get(channel);
		if (!handlers) {
			handlers = new Set();
			this.messageHandlers.set(channel, handlers);
		}
		handlers.add(handler);

		return () => {
			const existing = this.messageHandlers.get(channel);
			if (existing) {
				existing.delete(handler);
				if (existing.size === 0) {
					this.messageHandlers.delete(channel);
				}
			}
		};
	}

	onConnect(handler: () => void): void {
		this.emitter.on("connect", handler);
	}

	onDisconnect(handler: () => void): void {
		this.emitter.on("disconnect", handler);
	}

	private handleMessage(msg: ProtocolMessage<unknown>): void {
		if (msg.type === MessageType.response || msg.type === MessageType.error) {
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(msg.id);
				if (msg.type === MessageType.error) {
					pending.reject(msg.payload);
				} else {
					pending.resolve(msg.payload);
				}
				return;
			}
		}

		if (
			msg.type === MessageType.event ||
			msg.type === MessageType.stream ||
			msg.type === MessageType.stream_end
		) {
			const handlers = this.messageHandlers.get(msg.channel);
			if (handlers) {
				for (const handler of handlers) {
					handler(msg.payload);
				}
			}
		}

		if (msg.type === MessageType.ping) {
			const pong = createMessage(MessageType.pong, "system", null);
			pong.id = msg.id;
			this.ws?.send(serializeMessage(pong));
		}
	}

	private scheduleReconnect(): void {
		this.clearReconnectTimer();
		const jitter = Math.random() * 0.3 + 0.85;
		const delay =
			this.baseReconnectInterval * 2 ** this.reconnectAttempts * jitter;
		const maxDelay = 30000;
		const clampedDelay = Math.min(delay, maxDelay);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectAttempts++;
			this.shouldReconnect = true;
			this.connect().catch(() => {
				this.scheduleReconnect();
			});
		}, clampedDelay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private rejectAllPending(reason: string): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pendingRequests.clear();
	}
}
