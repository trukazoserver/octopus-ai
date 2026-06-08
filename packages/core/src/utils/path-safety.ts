import * as path from "node:path";

function normalizeForComparison(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
