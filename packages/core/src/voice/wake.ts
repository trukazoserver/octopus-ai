export interface WakeWordConfig {
	/**
	 * Wake word phrases to detect (e.g., ["hey octopus", "ok octopus"])
	 */
	keywords: string[];
	/**
	 * Sensitivity level (0.0 to 1.0). Higher = more sensitive but more false positives
	 */
	sensitivity?: number;
	/**
	 * Backend to use for detection
	 */
	backend?: "porcupine" | "snowboy" | "manual" | "mock";
	/**
	 * API key for Porcupine (if using that backend)
	 */
	apiKey?: string;
}

export interface WakeWordResult {
	detected: boolean;
	keyword?: string;
	confidence?: number;
	timestamp: number;
}

/**
 * Wake Word Detection Engine
 *
 * Supports multiple backends for wake word detection:
 * - porcupine: Uses Picovoice Porcupine (requires API key)
 * - snowboy: Uses Snowboy (deprecated but still works)
 * - manual: Manual STT-based detection
 * - mock: Testing/development mode
 *
 * @example
 * ```ts
 * const engine = new WakeWordEngine({
 *   keywords: ["hey octopus", "ok octopus"],
 *   sensitivity: 0.7,
 *   backend: "mock"
 * });
 *
 * engine.startListening((result) => {
 *   if (result.detected) {
 *     console.log(`Wake word detected: ${result.keyword}`);
 *   }
 * });
 * ```
 */
export class WakeWordEngine {
	private isListening = false;
	private config: WakeWordConfig;
	private callback: ((result: WakeWordResult) => void) | null = null;

	constructor(config: WakeWordConfig) {
		this.config = {
			sensitivity: 0.5,
			backend: "mock",
			...config,
		};
	}

	/**
	 * Start listening for wake words
	 * @param callback - Function called when a wake word is detected
	 */
	startListening(callback: (result: WakeWordResult) => void): void {
		if (this.isListening) {
			throw new Error("Already listening for wake words");
		}

		this.isListening = true;
		this.callback = callback;

		switch (this.config.backend) {
			case "porcupine":
				this.startPorcupine();
				break;
			case "snowboy":
				this.startSnowboy();
				break;
			case "manual":
				this.startManualDetection();
				break;
			default:
				this.startMockDetection();
				break;
		}
	}

	/**
	 * Stop listening for wake words
	 */
	stopListening(): void {
		this.isListening = false;
		this.callback = null;
		// Backend-specific cleanup would go here
	}

	/**
	 * Get current listening status
	 */
	isActive(): boolean {
		return this.isListening;
	}

	/**
	 * Update configuration (can be done while listening)
	 */
	updateConfig(config: Partial<WakeWordConfig>): void {
		this.config = { ...this.config, ...config };
	}

	private startPorcupine(): void {
		// Porcupine implementation would go here
		// Requires: @picovoice/porcupine-node
		if (!this.config.apiKey) {
			throw new Error("Porcupine backend requires an API key");
		}
		throw new Error(
			"Porcupine backend not yet implemented. Install @picovoice/porcupine-node and implement here.",
		);
	}

	private startSnowboy(): void {
		// Snowboy implementation would go here
		// Note: Snowboy is deprecated but still functional
		throw new Error(
			"Snowboy backend not yet implemented. Consider using Porcupine instead.",
		);
	}

	private startManualDetection(): void {
		// Manual STT-based detection would go here
		// This would continuously stream audio to STT and check for keywords
		throw new Error(
			"Manual detection backend not yet implemented. Requires continuous audio streaming and STT integration.",
		);
	}

	private startMockDetection(): void {
		// Mock implementation for testing/development
		// In production, replace with real backend
		console.warn(
			"[WakeWordEngine] Using mock backend. Wake words will NOT be detected. Configure a real backend for production use.",
		);
		// In a real implementation, this would continuously listen and call notifyDetection()
		// when a wake word is detected
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	private notifyDetection(keyword: string, confidence?: number): void {
		if (this.callback) {
			this.callback({
				detected: true,
				keyword,
				confidence,
				timestamp: Date.now(),
			});
		}
	}
}
