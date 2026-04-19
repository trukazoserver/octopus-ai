export interface ProxyConfig {
	httpProxy?: string;
	httpsProxy?: string;
	noProxy?: string[];
}

export interface Endpoint {
	host: string;
	port?: number;
	protocol: "ipv4" | "ipv6";
	address: string;
	family?: number;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface HealthStatus {
	healthy: boolean;
	latency: number;
	lastCheck: Date;
	consecutiveFailures: number;
}

export interface ManagedConnection {
	id: string;
	channelId: string;
	status: "connected" | "disconnected" | "connecting" | "error";
	health: HealthStatus;
	circuitState: CircuitState;
}

export interface MessageQueue {
	size: number;
	maxSize: number;
	enqueue(msg: unknown): void;
	dequeue(): unknown | undefined;
	clear(): void;
}

export interface RetryConfig {
	maxAttempts: number;
	baseDelay: number;
	maxDelay?: number;
}

export interface CircuitBreakerConfig {
	threshold: number;
	resetTimeout?: number;
}

export interface HealthMonitorConfig {
	interval: number;
}

export interface OfflineQueueConfig {
	maxSize: number;
}

export interface ConnectionManagerConfig {
	autoProxy?: boolean;
	retryMaxAttempts: number;
	retryBaseDelay: number;
	circuitBreakerThreshold: number;
	healthCheckInterval: number;
	offlineQueueSize: number;
	preferIPv4: boolean;
}
