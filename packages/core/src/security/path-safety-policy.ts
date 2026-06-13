import * as os from "node:os";
import * as path from "node:path";
import { isPathInsideAny } from "../utils/path-safety.js";

export interface PathSafetyPolicyConfig {
	allowedPaths?: string[];
}

export class PathSafetyPolicy {
	private readonly allowedPaths: string[];

	constructor(config: PathSafetyPolicyConfig = {}) {
		this.allowedPaths = (config.allowedPaths ?? []).map((allowedPath) =>
			this.resolvePath(allowedPath),
		);
	}

	assertAllowed(rawPath: string, context = "Path"): string {
		const resolved = this.resolvePath(rawPath);
		if (!isPathInsideAny(resolved, this.allowedPaths)) {
			throw new Error(
				`${context} denied by path safety policy: '${resolved}' is outside allowed paths`,
			);
		}
		return resolved;
	}

	isAllowed(rawPath: string): boolean {
		return isPathInsideAny(this.resolvePath(rawPath), this.allowedPaths);
	}

	getAllowedPaths(): string[] {
		return [...this.allowedPaths];
	}

	private resolvePath(rawPath: string): string {
		return path.resolve(
			rawPath.startsWith("~")
				? path.join(os.homedir(), rawPath.slice(1))
				: rawPath,
		);
	}
}
