import type { HealthStatus } from './types.js';

export class HealthMonitor {
  private interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statuses: Map<string, HealthStatus> = new Map();

  constructor(config: { interval?: number } = {}) {
    this.interval = config.interval ?? 30000;
  }

  start(checkFn: () => Promise<boolean>): void {
    this.stop();
    this.timer = setInterval(async () => {
      try {
        await checkFn();
      } catch {
        // swallow errors from health check
      }
    }, this.interval);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(channelId: string): HealthStatus {
    const existing = this.statuses.get(channelId);
    if (existing) return existing;
    return {
      healthy: true,
      latency: 0,
      lastCheck: new Date(0),
      consecutiveFailures: 0,
    };
  }

  updateStatus(channelId: string, healthy: boolean, latency: number): void {
    const current = this.statuses.get(channelId);
    const consecutiveFailures = current
      ? healthy
        ? 0
        : current.consecutiveFailures + 1
      : healthy
        ? 0
        : 1;

    this.statuses.set(channelId, {
      healthy,
      latency,
      lastCheck: new Date(),
      consecutiveFailures,
    });
  }
}
