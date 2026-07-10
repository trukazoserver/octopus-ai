import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks so the vi.mock factories can reference them.
const mocks = vi.hoisted(() => ({
	fs: {
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	},
	cp: {
		spawnSync: vi.fn(),
		spawn: vi.fn(),
	},
	os: {
		homedir: vi.fn(() => "/home/user"),
	},
	refresh: vi.fn(),
}));

vi.mock("node:fs", () => mocks.fs);
vi.mock("node:child_process", () => mocks.cp);
vi.mock("node:os", () => mocks.os);
vi.mock("../auth/oauth.js", () => ({ refreshAccessToken: mocks.refresh }));

import {
	exchangeAdcForAccessToken,
	findGcloudBinary,
	getAdcFilePath,
	getGcloudLoginStatus,
	readAdcCredentials,
	resetGcloudLoginSession,
	spawnGcloudLogin,
} from "../auth/gcloud-adc.js";

const ADC_JSON = JSON.stringify({
	type: "authorized_user",
	client_id: "client-123.apps.googleusercontent.com",
	client_secret: "secret-abc",
	refresh_token: "refresh-xyz",
	account: "user@example.com",
	quota_project_id: "proj-1",
});

function makeFakeChild() {
	const child = new EventEmitter();
	(child as unknown as { unref: ReturnType<typeof vi.fn> }).unref = vi.fn();
	(child as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();
	return child as unknown as {
		on(event: string, cb: (...a: unknown[]) => void): unknown;
		emit(event: string, ...a: unknown[]): boolean;
		unref(): void;
		kill(): void;
	};
}

describe("gcloud-adc", () => {
	const originalPlatform = process.platform;
	const envBackup: Record<string, string | undefined> = {};

	beforeEach(() => {
		vi.useFakeTimers();
		resetGcloudLoginSession();
		mocks.fs.existsSync.mockReset();
		mocks.fs.readFileSync.mockReset();
		mocks.cp.spawnSync.mockReset();
		mocks.cp.spawn.mockReset();
		mocks.os.homedir.mockReset();
		mocks.os.homedir.mockReturnValue("/home/user");
		mocks.refresh.mockReset();
		for (const key of [
			"CLOUDSDK_CONFIG",
			"APPDATA",
			"GCLOUD_PATH",
			"ProgramFiles",
			"ProgramFiles(x86)",
			"LOCALAPPDATA",
		]) {
			envBackup[key] = process.env[key];
		}
	});

	afterEach(() => {
		vi.useRealTimers();
		resetGcloudLoginSession();
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
			configurable: true,
		});
		for (const [key, value] of Object.entries(envBackup)) {
			if (value === undefined) unsetEnv(key);
			else process.env[key] = value;
		}
	});

	function setPlatform(platform: string): void {
		Object.defineProperty(process, "platform", {
			value: platform,
			configurable: true,
		});
	}

	// process.env requires `delete` (not assignment) to actually unset a var —
	// assigning undefined leaves it set in this runtime.
	function unsetEnv(key: string): void {
		delete process.env[key];
	}

	describe("getAdcFilePath", () => {
		it("honors CLOUDSDK_CONFIG on any OS", () => {
			setPlatform("linux");
			process.env.CLOUDSDK_CONFIG = "/custom/config";
			expect(getAdcFilePath()).toBe(
				"/custom/config/application_default_credentials.json",
			);
		});

		it("uses CLOUDSDK_CONFIG with backslashes on Windows", () => {
			setPlatform("win32");
			process.env.CLOUDSDK_CONFIG = "C:\\gc";
			expect(getAdcFilePath()).toBe(
				"C:\\gc\\application_default_credentials.json",
			);
		});

		it("uses %APPDATA%\\gcloud on Windows", () => {
			setPlatform("win32");
			unsetEnv("CLOUDSDK_CONFIG");
			process.env.APPDATA = "C:\\Users\\u\\AppData\\Roaming";
			expect(getAdcFilePath()).toBe(
				"C:\\Users\\u\\AppData\\Roaming\\gcloud\\application_default_credentials.json",
			);
		});

		it("uses ~/.config/gcloud on Unix", () => {
			setPlatform("linux");
			unsetEnv("CLOUDSDK_CONFIG");
			mocks.os.homedir.mockReturnValue("/home/u");
			expect(getAdcFilePath()).toBe(
				"/home/u/.config/gcloud/application_default_credentials.json",
			);
		});

		it("uses ~/.config/gcloud on darwin too", () => {
			setPlatform("darwin");
			unsetEnv("CLOUDSDK_CONFIG");
			mocks.os.homedir.mockReturnValue("/Users/u");
			expect(getAdcFilePath()).toBe(
				"/Users/u/.config/gcloud/application_default_credentials.json",
			);
		});
	});

	describe("readAdcCredentials", () => {
		it("returns null when the file is absent", () => {
			mocks.fs.readFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			expect(readAdcCredentials()).toBeNull();
		});

		it("returns null on malformed JSON (no throw)", () => {
			mocks.fs.readFileSync.mockReturnValue("{not json");
			expect(readAdcCredentials()).toBeNull();
		});

		it("returns null when type is not authorized_user", () => {
			mocks.fs.readFileSync.mockReturnValue(
				JSON.stringify({ type: "service_account", client_email: "x" }),
			);
			expect(readAdcCredentials()).toBeNull();
		});

		it("returns null when refresh_token is missing", () => {
			mocks.fs.readFileSync.mockReturnValue(
				JSON.stringify({
					type: "authorized_user",
					client_id: "c",
					client_secret: "s",
				}),
			);
			expect(readAdcCredentials()).toBeNull();
		});

		it("parses a valid authorized_user ADC file", () => {
			mocks.fs.readFileSync.mockReturnValue(ADC_JSON);
			const creds = readAdcCredentials();
			expect(creds).not.toBeNull();
			expect(creds?.type).toBe("authorized_user");
			expect(creds?.client_id).toBe("client-123.apps.googleusercontent.com");
			expect(creds?.client_secret).toBe("secret-abc");
			expect(creds?.refresh_token).toBe("refresh-xyz");
			expect(creds?.account).toBe("user@example.com");
			expect(creds?.quota_project_id).toBe("proj-1");
		});
	});

	describe("findGcloudBinary", () => {
		it("returns undefined when nothing is found", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockReturnValue({ status: 1, stdout: "" });
			mocks.fs.existsSync.mockReturnValue(false);
			expect(findGcloudBinary()).toBeUndefined();
		});

		it("resolves via command -v on Unix", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockImplementation((cmd: string) => {
				if (cmd.includes("command -v")) {
					return { status: 0, stdout: "/usr/bin/gcloud\n" };
				}
				return { status: 1, stdout: "" };
			});
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "/usr/bin/gcloud",
			);
			expect(findGcloudBinary()).toBe("/usr/bin/gcloud");
		});

		it("resolves via a known Windows install path", () => {
			setPlatform("win32");
			const candidate =
				"C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd";
			// Windows resolution: spawnSync (for trick) fails, existsSync hits.
			mocks.cp.spawnSync.mockReturnValue({ status: 1, stdout: "" });
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === candidate,
			);
			expect(findGcloudBinary()).toBe(candidate);
		});

		it("resolves gcloud.cmd from PATH via the for trick on Windows", () => {
			setPlatform("win32");
			mocks.cp.spawnSync.mockImplementation((cmd: string) => {
				if (cmd.includes("for %I")) {
					return {
						status: 0,
						stdout: "C:\\Tools\\gcloud.cmd\r\n",
					};
				}
				return { status: 1, stdout: "" };
			});
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "C:\\Tools\\gcloud.cmd",
			);
			expect(findGcloudBinary()).toBe("C:\\Tools\\gcloud.cmd");
		});
	});

	describe("exchangeAdcForAccessToken", () => {
		it("forwards refresh credentials to refreshAccessToken(google) and maps expiry", async () => {
			mocks.refresh.mockResolvedValue({
				access_token: "AT-1",
				refresh_token: "rt",
				expires_in: 3600,
				token_type: "Bearer",
			});
			const now = 1_000_000;
			vi.setSystemTime(now);
			const out = await exchangeAdcForAccessToken({
				type: "authorized_user",
				client_id: "cid",
				client_secret: "csec",
				refresh_token: "rt",
			});
			expect(mocks.refresh).toHaveBeenCalledWith("google", "rt", "cid", "csec");
			expect(out.accessToken).toBe("AT-1");
			expect(out.expiresAt).toBe(now + 3600 * 1000);
		});
	});

	describe("spawnGcloudLogin state machine", () => {
		it("fails when gcloud is not found", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockReturnValue({ status: 1, stdout: "" });
			mocks.fs.existsSync.mockReturnValue(false);
			const r = spawnGcloudLogin();
			expect(r.ok).toBe(false);
			expect(getGcloudLoginStatus().status).toBe("idle");
		});

		it("short-circuits to ready when ADC already exists", () => {
			// findGcloudBinary ok + ADC present.
			setPlatform("linux");
			mocks.cp.spawnSync.mockImplementation((cmd: string) =>
				cmd.includes("command -v")
					? { status: 0, stdout: "/usr/bin/gcloud\n" }
					: { status: 1, stdout: "" },
			);
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "/usr/bin/gcloud",
			);
			mocks.fs.readFileSync.mockReturnValue(ADC_JSON);
			const r = spawnGcloudLogin();
			expect(r.ok).toBe(true);
			expect(mocks.cp.spawn).not.toHaveBeenCalled();
			expect(getGcloudLoginStatus()).toMatchObject({
				status: "ready",
				account: "user@example.com",
			});
		});

		it("transitions running -> ready on exit(0) with ADC", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockImplementation((cmd: string) =>
				cmd.includes("command -v")
					? { status: 0, stdout: "/usr/bin/gcloud\n" }
					: { status: 1, stdout: "" },
			);
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "/usr/bin/gcloud",
			);
			// ADC absent at spawn time.
			mocks.fs.readFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			const child = makeFakeChild();
			mocks.cp.spawn.mockReturnValue(child);

			const r = spawnGcloudLogin();
			expect(r.ok).toBe(true);
			expect(getGcloudLoginStatus().status).toBe("running");
			expect(child.unref).toHaveBeenCalled();

			// ADC appears after login completes.
			mocks.fs.readFileSync.mockReturnValue(ADC_JSON);
			child.emit("exit", 0, null);
			expect(getGcloudLoginStatus()).toMatchObject({ status: "ready" });
		});

		it("transitions to error on exit(0) without ADC (user cancelled)", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockImplementation((cmd: string) =>
				cmd.includes("command -v")
					? { status: 0, stdout: "/usr/bin/gcloud\n" }
					: { status: 1, stdout: "" },
			);
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "/usr/bin/gcloud",
			);
			mocks.fs.readFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			const child = makeFakeChild();
			mocks.cp.spawn.mockReturnValue(child);

			spawnGcloudLogin();
			child.emit("exit", 0, null);
			expect(getGcloudLoginStatus().status).toBe("error");
		});

		it("transitions to error on non-zero exit", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockImplementation((cmd: string) =>
				cmd.includes("command -v")
					? { status: 0, stdout: "/usr/bin/gcloud\n" }
					: { status: 1, stdout: "" },
			);
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "/usr/bin/gcloud",
			);
			mocks.fs.readFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			const child = makeFakeChild();
			mocks.cp.spawn.mockReturnValue(child);

			spawnGcloudLogin();
			child.emit("exit", 1, null);
			const snap = getGcloudLoginStatus();
			expect(snap.status).toBe("error");
			expect(snap.error).toContain("1");
		});

		it("transitions to error on spawn error (ENOENT)", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockImplementation((cmd: string) =>
				cmd.includes("command -v")
					? { status: 0, stdout: "/usr/bin/gcloud\n" }
					: { status: 1, stdout: "" },
			);
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "/usr/bin/gcloud",
			);
			mocks.fs.readFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			const child = makeFakeChild();
			mocks.cp.spawn.mockReturnValue(child);

			spawnGcloudLogin();
			child.emit("error", new Error("spawn ENOENT"));
			expect(getGcloudLoginStatus().status).toBe("error");
		});

		it("times out to error after 5 minutes of running", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockImplementation((cmd: string) =>
				cmd.includes("command -v")
					? { status: 0, stdout: "/usr/bin/gcloud\n" }
					: { status: 1, stdout: "" },
			);
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "/usr/bin/gcloud",
			);
			mocks.fs.readFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			const child = makeFakeChild();
			mocks.cp.spawn.mockReturnValue(child);

			spawnGcloudLogin();
			vi.advanceTimersByTime(5 * 60_000);
			const snap = getGcloudLoginStatus();
			expect(snap.status).toBe("error");
			expect(snap.error).toContain("Timeout");
			expect(child.kill).toHaveBeenCalled();
		});

		it("is idempotent while a login is running", () => {
			setPlatform("linux");
			mocks.cp.spawnSync.mockImplementation((cmd: string) =>
				cmd.includes("command -v")
					? { status: 0, stdout: "/usr/bin/gcloud\n" }
					: { status: 1, stdout: "" },
			);
			mocks.fs.existsSync.mockImplementation(
				(p: unknown) => String(p) === "/usr/bin/gcloud",
			);
			mocks.fs.readFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			mocks.cp.spawn.mockReturnValue(makeFakeChild());

			const first = spawnGcloudLogin();
			const second = spawnGcloudLogin();
			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);
			expect(mocks.cp.spawn).toHaveBeenCalledTimes(1);
		});
	});
});
