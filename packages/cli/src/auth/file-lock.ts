/**
 * Cross-process file lock for serializing operations that must not run
 * concurrently across Octopus processes (e.g. the Codex OAuth token refresh —
 * concurrent refreshes with the same refresh token trigger ChatGPT's strict
 * rotation/reuse detection and revoke the whole session).
 *
 * Uses an exclusive-create lockfile (O_EXCL via flag "wx"). On a stale lock
 * (older than `staleMs`) it is stolen, so a crashed process can't block forever.
 * Best-effort release; in-process dedup is handled by the caller.
 */
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface FileLockOptions {
	/** Max time to wait to acquire the lock before throwing. Default 15000ms. */
	timeoutMs?: number;
	/** A lock older than this is considered stale and stolen. Default 30000ms. */
	staleMs?: number;
	/** Retry interval while waiting. Default 100ms. */
	retryMs?: number;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire an exclusive lock at `lockPath`. Returns a `release()` function that
 * removes the lock file (only if still owned). Throws on timeout.
 */
export async function acquireFileLock(
	lockPath: string,
	options: FileLockOptions = {},
): Promise<() => Promise<void>> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const staleMs = options.staleMs ?? 30_000;
	const retryMs = options.retryMs ?? 100;
	const dir = dirname(lockPath);
	const startedAt = Date.now();
	let ownsLock = false;

	const tryAcquire = (): boolean => {
		try {
			mkdirSync(dir, { recursive: true });
			// "wx" = O_WRONLY|O_CREAT|O_EXCL → throws EEXIST if it already exists.
			const fd = openSync(lockPath, "wx");
			closeSync(fd);
			ownsLock = true;
			return true;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				try {
					const st = statSync(lockPath);
					if (Date.now() - st.mtimeMs > staleMs) {
						unlinkSync(lockPath); // steal stale lock; retry recreates below
					}
				} catch {
					/* ignore stat/unlink errors; retry */
				}
				return false;
			}
			throw err;
		}
	};

	while (!tryAcquire()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(
				`acquireFileLock timed out after ${timeoutMs}ms waiting for ${lockPath}`,
			);
		}
		await sleep(retryMs);
	}

	return async () => {
		if (!ownsLock) return;
		ownsLock = false;
		try {
			unlinkSync(lockPath);
		} catch {
			/* best-effort: another process may have stolen a stale lock */
		}
	};
}
