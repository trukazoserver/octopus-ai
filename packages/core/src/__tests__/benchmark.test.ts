import { describe, it, expect } from 'vitest';
import { Benchmark } from '../utils/benchmark.js';

describe('Benchmark', () => {
  it('should run a benchmark and return valid results', async () => {
    const result = await Benchmark.run('simple', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }, { iterations: 10, warmup: 2 });

    expect(result.name).toBe('simple');
    expect(result.iterations).toBe(10);
    expect(result.totalMs).toBeGreaterThan(0);
    expect(result.avgMs).toBeGreaterThan(0);
    expect(result.minMs).toBeLessThanOrEqual(result.maxMs);
    expect(result.opsPerSecond).toBeGreaterThan(0);
    expect(result.p50Ms).toBeGreaterThanOrEqual(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
    expect(result.p99Ms).toBeGreaterThanOrEqual(result.p95Ms);
  });

  it('should format results as string', async () => {
    const result = await Benchmark.run('fmt-test', () => {}, { iterations: 5, warmup: 1 });
    const formatted = Benchmark.formatResult(result);
    expect(formatted).toContain('fmt-test');
    expect(formatted).toContain('Avg:');
    expect(formatted).toContain('Ops/sec:');
  });

  it('should compare multiple results', () => {
    const results = [
      { name: 'a', iterations: 10, totalMs: 100, avgMs: 10, minMs: 8, maxMs: 15, opsPerSecond: 100, p50Ms: 10, p95Ms: 14, p99Ms: 15 },
      { name: 'b', iterations: 10, totalMs: 200, avgMs: 20, minMs: 18, maxMs: 25, opsPerSecond: 50, p50Ms: 20, p95Ms: 24, p99Ms: 25 },
    ] as any[];
    const comparison = Benchmark.compare(results);
    expect(comparison).toContain('a');
    expect(comparison).toContain('b');
  });

  it('should handle sync functions', async () => {
    const result = await Benchmark.run('sync', () => {
      Math.sqrt(42);
    }, { iterations: 100, warmup: 5 });
    expect(result.iterations).toBe(100);
    expect(result.avgMs).toBeGreaterThan(0);
  });
});
