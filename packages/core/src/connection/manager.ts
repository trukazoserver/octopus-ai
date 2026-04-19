import { CircuitBreaker } from "./circuit.js";
import { HealthMonitor } from "./health.js";
import { NetworkResolver } from "./network.js";
import { OfflineQueue } from "./offline.js";
import { ProxyDetector } from "./proxy.js";
import { RetryHandler } from "./retry.js";
import type {
	ConnectionManagerConfig,
	Endpoint,
	ProxyConfig,
} from "./types.js";

interface ManagedConnection {
	channelId: string;
	circuitBreaker: CircuitBreaker;
	offlineQueue: OfflineQueue;
}

export class ConnectionManager {
	private config: ConnectionManagerConfig;
	private proxyDetector: ProxyDetector;
	private retryHandler: RetryHandler;
	private healthMonitor: HealthMonitor;
	private networkResolver: NetworkResolver;
	private channels: Map<string, ManagedConnection> = new Map();

	constructor(config: ConnectionManagerConfig) {
		this.config = config;
		this.proxyDetector = new ProxyDetector();
		this.retryHandler = new RetryHandler({
			maxAttempts: config.retryMaxAttempts,
			baseDelay: config.retryBaseDelay,
		});
		this.healthMonitor = new HealthMonitor({
			interval: config.healthCheckInterval,
		});
		this.networkResolver = new NetworkResolver();
	}

	detectProxy(): ProxyConfig {
		return this.proxyDetector.detect();
	}

	registerChannel(channelId: string): ManagedConnection {
		const circuitBreaker = new CircuitBreaker({
			threshold: this.config.circuitBreakerThreshold,
		});
		const offlineQueue = new OfflineQueue({
			maxSize: this.config.offlineQueueSize,
		});
		const managed: ManagedConnection = {
			channelId,
			circuitBreaker,
			offlineQueue,
		};
		this.channels.set(channelId, managed);
		return managed;
	}

	async executeWithRetry<T>(
		channelId: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const channel = this.channels.get(channelId);
		if (!channel) {
			throw new Error(`Channel not registered: ${channelId}`);
		}
		return this.retryHandler.execute(() => channel.circuitBreaker.execute(fn));
	}

	startHealthMonitor(checkFn: (channelId: string) => Promise<boolean>): void {
		this.healthMonitor.start(async () => {
			for (const channelId of this.channels.keys()) {
				const start = Date.now();
				try {
					const healthy = await checkFn(channelId);
					const latency = Date.now() - start;
					this.healthMonitor.updateStatus(channelId, healthy, latency);
				} catch {
					const latency = Date.now() - start;
					this.healthMonitor.updateStatus(channelId, false, latency);
				}
			}
			return true;
		});
	}

	stopHealthMonitor(): void {
		this.healthMonitor.stop();
	}

	getOfflineQueue(channelId: string): OfflineQueue {
		const channel = this.channels.get(channelId);
		if (!channel) {
			throw new Error(`Channel not registered: ${channelId}`);
		}
		return channel.offlineQueue;
	}

	getChannelStatus(channelId: string): ManagedConnection | undefined {
		return this.channels.get(channelId);
	}

	resolveEndpoint(host: string): Promise<Endpoint> {
		return this.networkResolver.resolveEndpoint(host, this.config.preferIPv4);
	}

	shutdown(): void {
		this.healthMonitor.stop();
		for (const channel of this.channels.values()) {
			channel.offlineQueue.clear();
		}
		this.channels.clear();
	}
}
