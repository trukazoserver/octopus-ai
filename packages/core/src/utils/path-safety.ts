import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function normalizeForComparison(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Expands a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
	return p;
}

export function isPathInside(basePath: string, targetPath: string): boolean {
	const base = normalizeForComparison(basePath);
	const target = normalizeForComparison(targetPath);
	const relative = path.relative(base, target);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

export function isPathInsideAny(
	targetPath: string,
	allowedPaths: string[],
): boolean {
	if (allowedPaths.length === 0) return true;
	return allowedPaths.some((allowedPath) =>
		isPathInside(allowedPath, targetPath),
	);
}

export function resolveRelativePathInside(
	basePath: string,
	relativePath: string,
): string | null {
	if (path.isAbsolute(relativePath)) return null;
	const base = path.resolve(basePath);
	const target = path.resolve(base, relativePath);
	return isPathInside(base, target) ? target : null;
}

async function realpathOrNull(p: string): Promise<string | null> {
	try {
		return await realpath(p);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		// Fail closed on unexpected errors (permissions, I/O): safer to reject.
		throw new Error(
			`Unable to resolve real path of '${p}': ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// Resolves the real on-disk path of target, following symlinks/junctions for the
// existing components. For not-yet-existing paths it resolves the nearest
// existing ancestor and appends the remaining segments (so a junction anywhere
// in the existing prefix is still detected).
async function resolveReal(targetPath: string): Promise<string | null> {
	const direct = await realpathOrNull(targetPath);
	if (direct) return direct;
	let dir = targetPath;
	const tail: string[] = [];
	while (true) {
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		tail.unshift(path.basename(dir));
		dir = parent;
		const real = await realpathOrNull(dir);
		if (real) return tail.length ? path.join(real, ...tail) : real;
	}
}

/**
 * Rejects paths that escape the allowed roots via a symlink/junction. Lexical
 * checks (isPathInsideAny) can be fooled when an entry inside an allowed root is
 * a link pointing outside it; this follows the real filesystem targets before
 * the caller performs the actual operation.
 */
export async function assertRealPathInside(
	targetPath: string,
	allowedRoots: string[],
): Promise<void> {
	if (allowedRoots.length === 0) return;
	const realRoots = await Promise.all(
		allowedRoots.map(async (root) => {
			const expanded = expandHome(root);
			return (await realpathOrNull(expanded)) ?? path.resolve(expanded);
		}),
	);
	const real = await resolveReal(targetPath);
	if (real === null) return;
	if (!isPathInsideAny(real, realRoots)) {
		throw new Error(
			`Path '${targetPath}' resolves via symlink/junction to '${real}', which is outside the allowed paths.`,
		);
	}
}
