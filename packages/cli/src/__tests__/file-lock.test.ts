import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireFileLock } from "../auth/file-lock.js";

const tmpBase = join(
	tmpdir(),
	`octo-lock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
);
mkdirSync(tmpBase, { recursive: true });

afterAll(() => {
	// best-effort cleanup; lock files may be gone already
});

function lockPath(name: string): string {
	const dir = join(tmpBase, name);
	mkdirSync(dir, { recursive: true });
	return join(dir, ".lock");
}

describe("acquireFileLock", () => {
	it("acquires, then releases (removes the lock file)", async () => {
		const path = lockPath("basic");
		const release = await acquireFileLock(path);
		expect(existsSync(path)).toBe(true);
		await release();
		expect(existsSync(path)).toBe(false);
	});

	it("serializes two concurrent acquisitions", async () => {
		const path = lockPath("serialize");
		const order: string[] = [];

		const a = acquireFileLock(path).then(async (release) => {
			order.push("a-acquired");
			await new Promise((r) => setTimeout(r, 80));
			order.push("a-released");
			await release();
		});
		// Second acquisition starts immediately but must wait for the first.
		const b = acquireFileLock(path, { retryMs: 10 }).then(async (release) => {
			order.push("b-acquired");
			await release();
		});

		await Promise.all([a, b]);
		// A fully acquired and released before B acquired.
		expect(order).toEqual(["a-acquired", "a-released", "b-acquired"]);
	});

	it("steals a stale lock", async () => {
		const path = lockPath("stale");
		// Pre-create a stale lock file (old mtime).
		writeFileSync(path, "stale", { flag: "wx" });
		const old = new Date(Date.now() - 120_000); // 2 min ago > staleMs default
		utimesSync(path, old, old);

		const release = await acquireFileLock(path, {
			staleMs: 30_000,
			retryMs: 10,
		});
		// Stealing recreates the lock; we now own it.
		expect(existsSync(path)).toBe(true);
		await release();
		expect(existsSync(path)).toBe(false);
	});

	it("times out when the lock is held longer than timeoutMs", async () => {
		const path = lockPath("timeout");
		const release = await acquireFileLock(path);
		await expect(
			acquireFileLock(path, { timeoutMs: 60, retryMs: 20, staleMs: 60_000 }),
		).rejects.toThrow(/timed out/);
		await release();
	});
});
