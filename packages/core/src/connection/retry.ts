export class RetryHandler {
	private maxAttempts: number;
	private baseDelay: number;
	private maxDelay: number;

	constructor(
		config: {
			maxAttempts?: number;
			baseDelay?: number;
			maxDelay?: number;
		} = {},
	) {
		this.maxAttempts = config.maxAttempts ?? 5;
		this.baseDelay = config.baseDelay ?? 1000;
		this.maxDelay = config.maxDelay ?? 30000;
	}

	async execute<T>(fn: () => Promise<T>): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
			try {
				return await fn();
			} catch (error) {
				lastError = error;
				if (attempt >= this.maxAttempts - 1 || !this.isRetryable(error)) {
					throw error;
				}
				const delay = this.calculateDelay(attempt);
				await this.sleep(delay);
			}
		}
		throw lastError;
	}

	private calculateDelay(attempt: number): number {
		return Math.min(
			this.baseDelay * 2 ** attempt * Math.random(),
			this.maxDelay,
		);
	}

	isRetryable(error: unknown): boolean {
		if (error == null || typeof error !== "object") return false;

		const err = error as Record<string, unknown>;

		if (err.code === "ECONNREFUSED") return true;
		if (err.code === "ECONNRESET") return true;
		if (err.code === "ETIMEDOUT") return true;
		if (err.code === "ENOTFOUND") return true;
		if (err.code === "ENETUNREACH") return true;
		if (err.code === "EAI_AGAIN") return true;

		if (typeof err.status === "number") {
			const status = err.status as number;
			if (status === 429 || status === 503 || status === 502 || status === 504)
				return true;
		}

		if (typeof err.statusCode === "number") {
			const statusCode = err.statusCode as number;
			if (
				statusCode === 429 ||
				statusCode === 503 ||
				statusCode === 502 ||
				statusCode === 504
			)
				return true;
		}

		if (err.name === "NetworkError") return true;
		if (err.name === "TimeoutError") return true;
		if (err.name === "AbortError") return true;

		const message =
			typeof err.message === "string"
				? (err.message as string).toLowerCase()
				: "";
		if (
			message.includes("network") ||
			message.includes("timeout") ||
			message.includes("econnrefused") ||
			message.includes("econnreset")
		) {
			return true;
		}

		return false;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
