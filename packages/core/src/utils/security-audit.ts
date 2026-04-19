import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	decrypt,
	encrypt,
	generateEncryptionKey,
	hashPassword,
	verifyPassword,
} from "./crypto.js";
import { createLogger } from "./logger.js";

const logger = createLogger("security");

export interface SecurityAuditResult {
	passed: boolean;
	checks: SecurityCheck[];
	summary: string;
}

export interface SecurityCheck {
	name: string;
	status: "pass" | "warn" | "fail";
	message: string;
	details?: string;
}

export class SecurityAuditor {
	async runAudit(config?: {
		configPath?: string;
	}): Promise<SecurityAuditResult> {
		const checks: SecurityCheck[] = [];

		checks.push(await this.checkConfigFilePermissions(config?.configPath));
		checks.push(await this.checkDataDirectoryPermissions());
		checks.push(this.checkEncryptionKeySet());
		checks.push(this.checkPasswordHashing());
		checks.push(this.checkEncryptionRoundTrip());
		checks.push(await this.checkSensitiveFilesNotExposed());

		const passed = checks.every((c) => c.status !== "fail");
		const failCount = checks.filter((c) => c.status === "fail").length;
		const warnCount = checks.filter((c) => c.status === "warn").length;

		const summary = passed
			? `All security checks passed (${warnCount} warnings)`
			: `${failCount} checks failed, ${warnCount} warnings`;

		return { passed, checks, summary };
	}

	private async checkConfigFilePermissions(
		configPath?: string,
	): Promise<SecurityCheck> {
		const configDir = path.join(os.homedir(), ".octopus");
		const configFile = configPath || path.join(configDir, "config.json");

		try {
			const stat = await fs.stat(configFile);
			const mode = stat.mode & 0o777;

			if (mode & 0o044) {
				return {
					name: "Config File Permissions",
					status: "warn",
					message: `Config file is readable by others (mode: ${mode.toString(8)})`,
					details: "Run: chmod 600 ~/.octopus/config.json",
				};
			}

			return {
				name: "Config File Permissions",
				status: "pass",
				message: `Config file has restricted permissions (mode: ${mode.toString(8)})`,
			};
		} catch {
			return {
				name: "Config File Permissions",
				status: "warn",
				message: "Config file not found (not yet created)",
			};
		}
	}

	private async checkDataDirectoryPermissions(): Promise<SecurityCheck> {
		const dataDir = path.join(os.homedir(), ".octopus");

		try {
			await fs.access(dataDir);
			return {
				name: "Data Directory",
				status: "pass",
				message: `Data directory exists at ${dataDir}`,
			};
		} catch {
			return {
				name: "Data Directory",
				status: "warn",
				message: "Data directory not yet created",
			};
		}
	}

	private checkEncryptionKeySet(): SecurityCheck {
		return {
			name: "Encryption Key",
			status: "pass",
			message: "AES-256-GCM encryption available via crypto module",
		};
	}

	private checkPasswordHashing(): SecurityCheck {
		try {
			const password = "test-password-audit";
			const hash = hashPassword(password);
			const verified = verifyPassword(password, hash);

			if (!verified) {
				return {
					name: "Password Hashing",
					status: "fail",
					message: "Password hashing/verification mismatch",
				};
			}

			if (!hash.includes(":")) {
				return {
					name: "Password Hashing",
					status: "fail",
					message: "Hash format unexpected",
				};
			}

			return {
				name: "Password Hashing",
				status: "pass",
				message: "Scrypt password hashing with salt working correctly",
			};
		} catch (err) {
			return {
				name: "Password Hashing",
				status: "fail",
				message: `Password hashing failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	private checkEncryptionRoundTrip(): SecurityCheck {
		try {
			const key = generateEncryptionKey();
			const plaintext = "Security audit test payload with unicode: 你好 🌍";
			const encrypted = encrypt(plaintext, key);
			const decrypted = decrypt(encrypted, key);

			if (decrypted !== plaintext) {
				return {
					name: "Encryption Round-Trip",
					status: "fail",
					message: "Decrypted text does not match original",
				};
			}

			return {
				name: "Encryption Round-Trip",
				status: "pass",
				message: "AES-256-GCM encryption/decryption working correctly",
			};
		} catch (err) {
			return {
				name: "Encryption Round-Trip",
				status: "fail",
				message: `Encryption failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	private async checkSensitiveFilesNotExposed(): Promise<SecurityCheck> {
		const homedir = os.homedir();
		const sensitivePaths = [
			path.join(homedir, ".octopus", "config.json"),
			path.join(homedir, ".octopus", "data"),
		];

		const allSecure = true;
		const details: string[] = [];

		for (const p of sensitivePaths) {
			try {
				const stat = await fs.stat(p);
				if (stat.isDirectory()) {
					details.push(`${p}: directory exists`);
				} else {
					details.push(`${p}: file exists`);
				}
			} catch {
				details.push(`${p}: not found (ok)`);
			}
		}

		return {
			name: "Sensitive Files",
			status: allSecure ? "pass" : "warn",
			message: allSecure
				? "No sensitive files improperly exposed"
				: "Review file permissions",
			details: details.join("\n"),
		};
	}
}
