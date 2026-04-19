import type { MessageQueue } from "./types.js";

export class OfflineQueue implements MessageQueue {
	private queue: unknown[] = [];
	readonly maxSize: number;

	constructor(config: { maxSize?: number } = {}) {
		this.maxSize = config.maxSize ?? 1000;
	}

	enqueue(msg: unknown): void {
		if (this.queue.length >= this.maxSize) {
			this.queue.shift();
		}
		this.queue.push(msg);
	}

	dequeue(): unknown | undefined {
		return this.queue.shift();
	}

	peek(): unknown | undefined {
		return this.queue[0];
	}

	clear(): void {
		this.queue.length = 0;
	}

	get size(): number {
		return this.queue.length;
	}

	drain(): unknown[] {
		const items = this.queue.slice();
		this.queue.length = 0;
		return items;
	}
}
