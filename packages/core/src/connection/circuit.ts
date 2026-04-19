import type { CircuitState } from "./types.js";

export class CircuitBreaker {
	private threshold: number;
	private resetTimeout: number;
	private _state: CircuitState = "closed";
	private _failureCount = 0;
	private _lastFailureTime = 0;

	constructor(config: { threshold?: number; resetTimeout?: number } = {}) {
		this.threshold = config.threshold ?? 5;
		this.resetTimeout = config.resetTimeout ?? 60000;
	}

	get state(): CircuitState {
		return this.getState();
	}

	get failureCount(): number {
		return this._failureCount;
	}

	get lastFailureTime(): number {
		return this._lastFailureTime;
	}

	async execute<T>(fn: () => Promise<T>): Promise<T> {
		const currentState = this.getState();

		if (currentState === "open") {
			throw new Error("Circuit breaker is open");
		}

		try {
			const result = await fn();
			this.recordSuccess();
			return result;
		} catch (error) {
			this.recordFailure();
			throw error;
		}
	}

	recordSuccess(): void {
		this._failureCount = 0;
		this._state = "closed";
	}

	recordFailure(): void {
		this._failureCount++;
		this._lastFailureTime = Date.now();
		if (this._failureCount >= this.threshold) {
			this._state = "open";
		}
	}

	getState(): CircuitState {
		if (this._state === "open") {
			const elapsed = Date.now() - this._lastFailureTime;
			if (elapsed >= this.resetTimeout) {
				this._state = "half-open";
			}
		}
		return this._state;
	}
}
