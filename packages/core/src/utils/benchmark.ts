import { performance } from 'node:perf_hooks';

export interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  opsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export class Benchmark {
  static async run(
    name: string,
    fn: () => Promise<void> | void,
    options: { iterations?: number; warmup?: number } = {},
  ): Promise<BenchmarkResult> {
    const iterations = options.iterations ?? 100;
    const warmup = options.warmup ?? 5;
    const timings: number[] = [];

    for (let i = 0; i < warmup; i++) {
      await fn();
    }

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await fn();
      const elapsed = performance.now() - start;
      timings.push(elapsed);
    }

    timings.sort((a, b) => a - b);

    const totalMs = timings.reduce((sum, t) => sum + t, 0);
    const avgMs = totalMs / iterations;
    const minMs = timings[0]!;
    const maxMs = timings[timings.length - 1]!;
    const opsPerSecond = 1000 / avgMs;

    return {
      name,
      iterations,
      totalMs,
      avgMs,
      minMs,
      maxMs,
      opsPerSecond,
      p50Ms: percentile(timings, 50),
      p95Ms: percentile(timings, 95),
      p99Ms: percentile(timings, 99),
    };
  }

  static formatResult(result: BenchmarkResult): string {
    return [
      `Benchmark: ${result.name}`,
      `  Iterations: ${result.iterations}`,
      `  Total: ${result.totalMs.toFixed(2)}ms`,
      `  Avg: ${result.avgMs.toFixed(3)}ms`,
      `  Min: ${result.minMs.toFixed(3)}ms`,
      `  Max: ${result.maxMs.toFixed(3)}ms`,
      `  Ops/sec: ${result.opsPerSecond.toFixed(1)}`,
      `  P50: ${result.p50Ms.toFixed(3)}ms`,
      `  P95: ${result.p95Ms.toFixed(3)}ms`,
      `  P99: ${result.p99Ms.toFixed(3)}ms`,
    ].join('\n');
  }

  static compare(results: BenchmarkResult[]): string {
    const lines: string[] = ['Benchmark Comparison:', '' ];
    const nameWidth = Math.max(...results.map((r) => r.name.length));
    lines.push(
      '  '.padEnd(nameWidth + 2) +
        'Avg (ms)'.padEnd(12) +
        'Ops/sec'.padEnd(12) +
        'P95 (ms)'.padEnd(12),
    );

    for (const result of results) {
      lines.push(
        `  ${result.name.padEnd(nameWidth + 2)}` +
          `${result.avgMs.toFixed(3).padEnd(12)}` +
          `${result.opsPerSecond.toFixed(1).padEnd(12)}` +
          `${result.p95Ms.toFixed(3).padEnd(12)}`,
      );
    }
    return lines.join('\n');
  }
}

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}
