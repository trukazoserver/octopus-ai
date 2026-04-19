import { EventEmitter } from "node:events";
import type { AgentMessage } from "./types.js";

export type MessageHandler = (message: AgentMessage) => void | Promise<void>;

export class AgentMessageBus {
	private emitter = new EventEmitter();
	private history: AgentMessage[] = [];
	private maxHistory = 1000;

	constructor() {
		this.emitter.setMaxListeners(50);
	}

	publish(message: AgentMessage): void {
		this.addToHistory(message);
		this.emitter.emit(`agent:${message.to}`, message);
		this.emitter.emit("broadcast", message);
	}

	broadcast(from: string, content: string): void {
		const message: AgentMessage = {
			from,
			to: "*",
			type: "broadcast",
			content,
			timestamp: new Date(),
		};
		this.addToHistory(message);
		this.emitter.emit("broadcast", message);
	}

	subscribe(agentId: string, handler: MessageHandler): void {
		this.emitter.on(`agent:${agentId}`, handler);
	}

	unsubscribe(agentId: string, handler: MessageHandler): void {
		this.emitter.off(`agent:${agentId}`, handler);
	}

	subscribeAll(handler: MessageHandler): void {
		this.emitter.on("broadcast", handler);
	}

	unsubscribeAll(handler: MessageHandler): void {
		this.emitter.off("broadcast", handler);
	}

	async request(
		from: string,
		to: string,
		content: string,
		timeoutMs = 30000,
	): Promise<AgentMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.emitter.off(`response:${from}`, handler);
				reject(new Error(`Request from ${from} to ${to} timed out`));
			}, timeoutMs);

			const handler = (message: AgentMessage) => {
				if (message.type === "result" && message.from === to) {
					clearTimeout(timer);
					this.emitter.off(`response:${from}`, handler);
					resolve(message);
				}
			};

			this.emitter.on(`response:${from}`, handler);

			const request: AgentMessage = {
				from,
				to,
				type: "task",
				content,
				timestamp: new Date(),
			};
			this.addToHistory(request);
			this.emitter.emit(`agent:${to}`, request);
		});
	}

	sendProgress(from: string, to: string, content: string): void {
		const message: AgentMessage = {
			from,
			to,
			type: "progress",
			content,
			timestamp: new Date(),
		};
		this.addToHistory(message);
		this.emitter.emit(`agent:${to}`, message);
		this.emitter.emit("broadcast", message);
	}

	getHistory(opts?: {
		from?: string;
		to?: string;
		type?: string;
		limit?: number;
	}): AgentMessage[] {
		let messages = this.history;
		if (opts?.from) messages = messages.filter((m) => m.from === opts.from);
		if (opts?.to)
			messages = messages.filter((m) => m.to === opts.to || m.to === "*");
		if (opts?.type) messages = messages.filter((m) => m.type === opts.type);
		const limit = opts?.limit ?? 50;
		return messages.slice(-limit);
	}

	private addToHistory(message: AgentMessage): void {
		this.history.push(message);
		if (this.history.length > this.maxHistory) {
			this.history = this.history.slice(-this.maxHistory);
		}
	}
}
