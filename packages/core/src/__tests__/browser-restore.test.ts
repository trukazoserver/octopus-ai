import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BrowserTool,
	findSavedBrowserSessions,
} from "../tools/browser.js";

async function writeSession(
	root: string,
	provider: string,
	host: string,
	meta: { url: string; title?: string; savedAt: string },
): Promise<void> {
	const dir = join(root, provider, host.replace(/[^a-z0-9.-]+/g, "-"));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "storageState.json"), '{"cookies":[]}', "utf8");
	await writeFile(
		join(dir, "meta.json"),
		JSON.stringify({ host, ...meta }),
		"utf8",
	);
}

describe("browser_restore / session persistence", () => {
	let sessionsDir: string;

	beforeEach(async () => {
		sessionsDir = await mkdtemp(join(tmpdir(), "octopus-browser-sessions-"));
	});

	afterEach(async () => {
		await rm(sessionsDir, { recursive: true, force: true });
	});

	it("lists saved sessions sorted by recency and filters by host", async () => {
		await writeSession(sessionsDir, "embedded", "github.com", {
			url: "https://github.com/owner/repo/pulls",
			title: "Pulls · owner/repo",
			savedAt: "2026-08-17T10:00:00.000Z",
		});
		await writeSession(sessionsDir, "embedded", "news.ycombinator.com", {
			url: "https://news.ycombinator.com/item?id=1",
			savedAt: "2026-08-17T12:00:00.000Z",
		});
		await writeSession(sessionsDir, "decodo", "shop.example.com", {
			url: "https://shop.example.com/cart",
			savedAt: "2026-08-16T08:00:00.000Z",
		});

		const all = await findSavedBrowserSessions(sessionsDir);
		expect(all.map((session) => session.host)).toEqual([
			"news.ycombinator.com",
			"github.com",
			"shop.example.com",
		]);

		const byHost = await findSavedBrowserSessions(sessionsDir, {
			host: "example.com",
		});
		expect(byHost.map((session) => session.host)).toEqual(["shop.example.com"]);

		expect(
			await findSavedBrowserSessions(sessionsDir, { host: "missing.tld" }),
		).toEqual([]);
	});

	it("skips sessions older than the TTL", async () => {
		await writeSession(sessionsDir, "embedded", "old-site.com", {
			url: "https://old-site.com/page",
			savedAt: "2020-01-01T00:00:00.000Z",
		});
		await writeSession(sessionsDir, "embedded", "fresh-site.com", {
			url: "https://fresh-site.com/page",
			savedAt: new Date().toISOString(),
		});

		const sessions = await findSavedBrowserSessions(sessionsDir, {
			ttlHours: 1,
		});

		expect(sessions.map((session) => session.host)).toEqual(["fresh-site.com"]);
	});

	it("returns an empty list for a missing storage dir", async () => {
		await expect(
			findSavedBrowserSessions(join(sessionsDir, "does-not-exist")),
		).resolves.toEqual([]);
	});

	function createRestoreTool(
		stubs: { gotoUrl?: string } = {},
	): { handler: (params: Record<string, unknown>) => Promise<{
		success: boolean;
		output: string;
		error?: string;
	}> } {
		const browser = new BrowserTool({
			humanBehavior: false,
			sessionStorageDir: sessionsDir,
		});
		const internals = browser as unknown as {
			init: () => Promise<void>;
			page: unknown;
			gotoWithSession: (url: string, options?: unknown) => Promise<unknown>;
			saveSessionForCurrentPage: () => Promise<boolean>;
		};
		internals.init = vi.fn(async () => {});
		internals.page = {
			url: vi.fn(() => stubs.gotoUrl ?? "https://github.com/owner/repo/pulls"),
			title: vi.fn(async () => "Pulls · owner/repo"),
		};
		internals.gotoWithSession = vi.fn(async () => null);
		internals.saveSessionForCurrentPage = vi.fn(async () => true);
		const tool = browser
			.createTools()
			.find((candidate) => candidate.name === "browser_restore");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("browser_restore tool missing");
		return {
			handler: (params) =>
				tool.handler(params, {} as never) as Promise<{
					success: boolean;
					output: string;
					error?: string;
				}>,
		};
	}

	it("restores the most recent session when no host is given", async () => {
		await writeSession(sessionsDir, "embedded", "github.com", {
			url: "https://github.com/owner/repo/pulls",
			title: "Pulls · owner/repo",
			savedAt: "2026-08-17T10:00:00.000Z",
		});
		const { handler } = createRestoreTool();

		const result = await handler({});

		expect(result.success).toBe(true);
		expect(result.output).toContain("github.com");
		expect(result.output).toContain("https://github.com/owner/repo/pulls");
	});

	it("restores a specific host by exact or subdomain match", async () => {
		await writeSession(sessionsDir, "embedded", "shop.example.com", {
			url: "https://shop.example.com/cart",
			title: "Cart",
			savedAt: new Date().toISOString(),
		});
		const { handler } = createRestoreTool();

		const result = await handler({ host: "example.com" });

		expect(result.success).toBe(true);
		expect(result.output).toContain("shop.example.com");
	});

	it("lists available sessions when the requested host has none", async () => {
		await writeSession(sessionsDir, "embedded", "github.com", {
			url: "https://github.com/owner/repo/pulls",
			title: "Pulls · owner/repo",
			savedAt: "2026-08-17T10:00:00.000Z",
		});
		const { handler } = createRestoreTool();

		const result = await handler({ host: "missing.tld" });

		expect(result.success).toBe(false);
		expect(result.output).toContain("github.com");
		expect(result.output).toContain("No saved session for 'missing.tld'");
	});
});
