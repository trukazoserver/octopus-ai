import type { LLMRouter } from "../ai/router.js";
import type { DatabaseAdapter } from "../storage/database.js";
import { createLogger } from "../utils/logger.js";
import type { HeartbeatDaemon } from "./heartbeat.js";
import type { ReflectionEngine } from "./reflection.js";
import type { AgentRuntime } from "./runtime.js";
import type { AutomationRunner } from "../tasks/cron-runner.js";
import type { ChannelManager } from "../channels/manager.js";

/**
 * OctopusDaemon — Persistent Background Service
 *
 * Runs Octopus AI as a long-lived daemon process that:
 * - Listens on all configured channels simultaneously
 * - Runs the HeartbeatDaemon for proactive tasks
 * - Runs AutomationRunner for cron jobs
 * - Auto-recovers from crashes
 * - Provides health status
 *
 * This is the equivalent of OpenClaw's Gateway daemon.
 */

const logger = createLogger("daemon");

export interface DaemonConfig {
	/** Whether to start heartbeat automatically */
	enableHeartbeat: boolean;
	/** Whether to start automations automatically */
	enableAutomations: boolean;
	/** Whether to start channels automatically */
	enableChannels: boolean;
	/** Health check interval in ms (default: 60s) */
	healthCheckIntervalMs: number;
	/** Maximum consecutive errors before entering error state */
	maxConsecutiveErrors: number;
	/** Grace period before shutdown in ms */
	shutdownGraceMs: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
	enableHeartbeat: true,
	enableAutomations: true,
	enableChannels: true,
	healthCheckIntervalMs: 60_000,
	maxConsecutiveErrors: 5,
	shutdownGraceMs: 5_000,
};

export interface DaemonStatus {
	state: "starting" | "running" | "stopping" | "stopped" | "error";
	uptime: number;
	startedAt: Date | null;
	heartbeatRunning: boolean;
	automationsRunning: boolean;
	channelsActive: string[];
	consecutiveErrors: number;
	lastError: string | null;
	lastHealthCheck: Date | null;
}

export class OctopusDaemon {
	private config: DaemonConfig;
	private status: DaemonStatus;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	private startTime: Date | null = null;

	// Optional subsystems
	private runtime: AgentRuntime | null = null;
	private heartbeat: HeartbeatDaemon | null = null;
	private automationRunner: AutomationRunner | null = null;
	private channelManager: ChannelManager | null = null;

	constructor(config: Partial<DaemonConfig> = {}) {
		this.config = { ...DEFAULT_DAEMON_CONFIG, ...config };
		this.status = {
			state: "stopped",
			uptime: 0,
			startedAt: null,
			heartbeatRunning: false,
			automationsRunning: false,
			channelsActive: [],
			consecutiveErrors: 0,
			lastError: null,
			lastHealthCheck: null,
		};
	}

	/**
	 * Attach subsystems to the daemon.
	 */
	attachRuntime(runtime: AgentRuntime): void {
		this.runtime = runtime;
	}

	attachHeartbeat(heartbeat: HeartbeatDaemon): void {
		this.heartbeat = heartbeat;
	}

	attachAutomationRunner(runner: AutomationRunner): void {
		this.automationRunner = runner;
	}

	attachChannelManager(channelManager: ChannelManager): void {
		this.channelManager = channelManager;
	}

	/**
	 * Start the daemon and all attached subsystems.
	 */
	async start(): Promise<void> {
		if (this.status.state === "running") {
			logger.warn("Daemon is already running");
			return;
		}

		this.status.state = "starting";
		this.startTime = new Date();
		logger.info("🐙 Octopus AI Daemon starting...");

		try {
			// Start heartbeat if configured and attached
			if (this.config.enableHeartbeat && this.heartbeat) {
				await this.heartbeat.start();
				this.status.heartbeatRunning = true;
				logger.info("💓 Heartbeat daemon started");
			}

			// Start automation runner if configured and attached
			if (this.config.enableAutomations && this.automationRunner) {
				await this.automationRunner.initialize();
				this.status.automationsRunning = true;
				logger.info("⚙️ Automation runner started");
			}

			// Start channel listeners if configured and attached
			if (this.config.enableChannels && this.channelManager) {
				const channels = this.channelManager.getAll?.() ?? [];
				this.status.channelsActive = channels.map(
					(c: { id: string }) => c.id,
				);
				logger.info(
					`📡 ${this.status.channelsActive.length} channels active`,
				);
			}

			// Setup health check timer
			this.healthTimer = setInterval(() => {
				this.healthCheck().catch((err) =>
					logger.error("Health check failed:", err),
				);
			}, this.config.healthCheckIntervalMs);

			// Setup process signal handlers for graceful shutdown
			this.setupSignalHandlers();

			this.status.state = "running";
			this.status.startedAt = this.startTime;
			this.status.consecutiveErrors = 0;
			logger.info("🐙 Octopus AI Daemon is running");
		} catch (err) {
			this.status.lastError =
				err instanceof Error ? err.message : String(err);
			logger.error(`Daemon failed to start: ${String(err)}`);
			throw err;
		}
	}

	/**
	 * Stop the daemon gracefully.
	 */
	async stop(): Promise<void> {
		if (this.status.state === "stopped") return;

		this.status.state = "stopping";
		logger.info("🐙 Octopus AI Daemon stopping...");

		// Clear health timer
		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}

		// Stop heartbeat
		if (this.heartbeat) {
			this.heartbeat.stop();
			this.status.heartbeatRunning = false;
		}

		// Grace period
		await new Promise((resolve) =>
			setTimeout(resolve, this.config.shutdownGraceMs),
		);

		this.status.state = "stopped";
		this.status.channelsActive = [];
		logger.info("🐙 Octopus AI Daemon stopped");
	}

	/**
	 * Get current daemon status.
	 */
	getStatus(): DaemonStatus {
		return {
			...this.status,
			uptime: this.startTime
				? Date.now() - this.startTime.getTime()
				: 0,
		};
	}

	// --- Private ---

	private async healthCheck(): Promise<void> {
		try {
			// Check heartbeat
			if (this.config.enableHeartbeat && this.heartbeat) {
				this.status.heartbeatRunning = this.heartbeat.isRunning();
			}

			// Check channels
			if (this.channelManager) {
				const channels = this.channelManager.getAll?.() ?? [];
				this.status.channelsActive = channels.map(
					(c: { id: string }) => c.id,
				);
			}

			this.status.lastHealthCheck = new Date();
			this.status.consecutiveErrors = 0;
		} catch (err) {
			this.status.consecutiveErrors += 1;
			this.status.lastError =
				err instanceof Error ? err.message : String(err);

			if (
				this.status.consecutiveErrors >= this.config.maxConsecutiveErrors
			) {
				this.status.state = "error";
				logger.error(
					`Health check failed ${this.status.consecutiveErrors} times. Entering error state.`,
				);
			}
		}
	}

	private setupSignalHandlers(): void {
		const shutdown = async (signal: string) => {
			logger.info(`Received ${signal}. Shutting down...`);
			await this.stop();
			process.exit(0);
		};

		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));

		process.on("uncaughtException", (err) => {
			logger.error(`Uncaught exception: ${err.message}`);
			this.status.consecutiveErrors += 1;
			this.status.lastError = err.message;
		});

		process.on("unhandledRejection", (reason) => {
			logger.error(`Unhandled rejection: ${String(reason)}`);
			this.status.consecutiveErrors += 1;
		});
	}
}
