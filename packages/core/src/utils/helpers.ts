import { homedir } from "node:os";
import { resolve } from "node:path";
import { nanoid } from "nanoid";

export function expandTildePath(p: string): string {
  if (p.startsWith("~")) {
    return resolve(homedir(), p.slice(1));
  }
  return p;
}

export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

export function generateId(): string {
  return nanoid(12);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts: number; baseDelay: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === opts.maxAttempts) break;
      const jitter = Math.random() * 0.3 + 0.85;
      const delay = opts.baseDelay * Math.pow(2, attempt - 1) * jitter;
      await sleep(delay);
    }
  }
  throw lastError;
}

export function truncateToTokenBudget(
  items: Array<{ text: string; tokenCount: number }>,
  budget: number,
): typeof items {
  const result: Array<{ text: string; tokenCount: number }> = [];
  let used = 0;
  for (const item of items) {
    if (used + item.tokenCount > budget) break;
    result.push(item);
    used += item.tokenCount;
  }
  return result;
}
