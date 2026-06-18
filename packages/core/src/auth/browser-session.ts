import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "patchright";

export interface BrowserAuthConfig {
	loginUrl: string;
	checkUrl: string;
	cookieNames: string[];
	interceptUrlPattern?: string;
	interceptHeaderName?: string;
	postLoginWaitMs?: number;
}

export interface BrowserAuthResult {
	success: boolean;
	cookies: Array<{
		name: string;
		value: string;
		domain: string;
		path: string;
		expires?: number;
		httpOnly: boolean;
		secure: boolean;
		sameSite: string;
	}>;
	interceptedToken?: string;
	userAgent?: string;
	error?: string;
}

interface ProviderAuthConfig {
	name: string;
	loginUrl: string;
	checkUrl: string;
	cookieNames: string[];
	interceptUrlPattern?: string;
	interceptHeaderName?: string;
	postLoginWaitMs?: number;
}

const PROVIDER_AUTH_CONFIGS: Record<string, ProviderAuthConfig> = {
	openai: {
		name: "ChatGPT",
		loginUrl: "https://chatgpt.com/auth/login",
		checkUrl: "https://chatgpt.com/api/auth/session",
		cookieNames: ["__Secure-next-auth.session-token"],
		interceptUrlPattern: "https://chatgpt.com/backend-api/",
		interceptHeaderName: "Authorization",
		postLoginWaitMs: 3000,
	},
	anthropic: {
		name: "Claude",
		loginUrl: "https://claude.ai/login",
		checkUrl: "https://claude.ai/api/organizations",
		cookieNames: ["sessionKey"],
		postLoginWaitMs: 3000,
	},
	google: {
		name: "Gemini",
		loginUrl: "https://gemini.google.com/app",
		checkUrl: "https://gemini.google.com/app",
		cookieNames: [
			"__Secure-1PSID",
			"__Secure-1PSIDTS",
			"SID",
			"HSID",
			"SSID",
			"APISID",
			"SAPISID",
		],
		postLoginWaitMs: 5000,
	},
	deepseek: {
		name: "DeepSeek",
		loginUrl: "https://chat.deepseek.com/",
		checkUrl: "https://chat.deepseek.com/api/v0/users/current",
		cookieNames: ["d_id", "ds_session_id", "HWSID"],
		interceptUrlPattern: "https://chat.deepseek.com/api/v0/",
		interceptHeaderName: "Authorization",
		postLoginWaitMs: 3000,
	},
	xai: {
		name: "Grok",
		loginUrl: "https://grok.com/",
		checkUrl: "https://grok.com/rest/app-chat/conversations/new",
		cookieNames: [],
		postLoginWaitMs: 3000,
	},
};

function getProviderConfig(provider: string): ProviderAuthConfig | null {
	return PROVIDER_AUTH_CONFIGS[provider] ?? null;
}

export function getBrowserAuthProviders(): string[] {
	return Object.keys(PROVIDER_AUTH_CONFIGS);
}

function findBrowserExecutable(): string | undefined {
	const candidates = [
		process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		join(
			process.env.PLAYWRIGHT_BROWSERS_PATH ??
				join(homedir(), ".cache", "ms-playwright"),
			"chromium-*/chrome-win/chrome.exe",
		),
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		join(
			process.env.LOCALAPPDATA ?? "",
			"Google\\Chrome\\Application\\chrome.exe",
		),
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium-browser",
		"/usr/bin/chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	];

	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const resolved = execSync(
				`cmd /c for %I in ("${candidate}") do @echo %~fI`,
				{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
			).trim();
			if (resolved && existsSync(resolved)) return resolved;
		} catch {
			if (existsSync(candidate)) return candidate;
		}
	}

	return undefined;
}

let activeAuthBrowser: {
	context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
	provider: string;
	status: "waiting" | "captured" | "error" | "closed";
	result?: BrowserAuthResult;
} | null = null;

export function getAuthStatus(provider: string): {
	status: string;
	result?: BrowserAuthResult;
} {
	if (!activeAuthBrowser || activeAuthBrowser.provider !== provider) {
		return { status: "idle" };
	}
	return {
		status: activeAuthBrowser.status,
		result: activeAuthBrowser.result,
	};
}

export async function startBrowserAuth(
	provider: string,
): Promise<{ ok: boolean; error?: string }> {
	if (activeAuthBrowser?.status === "waiting") {
		return {
			ok: false,
			error: "Auth already in progress for another provider",
		};
	}

	const config = getProviderConfig(provider);
	if (!config) {
		return { ok: false, error: `Browser auth not supported for: ${provider}` };
	}

	const executablePath = findBrowserExecutable();
	if (!executablePath) {
		return {
			ok: false,
			error: "No browser found. Install Chrome or Chromium.",
		};
	}

	try {
		const userDataDir = join(homedir(), ".octopus", "browser-auth", provider);
		mkdirSync(userDataDir, { recursive: true });

		const context = await chromium.launchPersistentContext(userDataDir, {
			headless: false,
			executablePath,
			args: [
				"--disable-infobars",
				"--disable-extensions",
				"--disable-dev-shm-usage",
				"--window-size=800,700",
			],
			ignoreDefaultArgs: ["--enable-automation"],
			viewport: { width: 800, height: 700 },
		});

		activeAuthBrowser = {
			context,
			provider,
			status: "waiting",
		};

		const page = context.pages()[0] ?? (await context.newPage());

		let interceptedToken: string | undefined;

		if (config.interceptUrlPattern && config.interceptHeaderName) {
			await page.route(config.interceptUrlPattern, async (route) => {
				const headers = route.request().headers();
				const headerName = config.interceptHeaderName?.toLowerCase();
				const authHeader = headerName ? headers[headerName] : undefined;
				if (authHeader?.startsWith("Bearer ")) {
					interceptedToken = authHeader;
				}
				await route.continue();
			});
		}

		await page.goto(config.loginUrl, {
			waitUntil: "domcontentloaded",
			timeout: 30000,
		});

		const pollAuth = async () => {
			if (!activeAuthBrowser || activeAuthBrowser.status !== "waiting") return;

			try {
				const pages = context.pages();
				if (pages.length === 0) {
					activeAuthBrowser.status = "closed";
					return;
				}

				const currentUrl = pages[0].url();
				const isLoggedIn =
					currentUrl.includes(
						config.checkUrl.replace("https://", "").split("/")[0],
					) &&
					!currentUrl.includes("login") &&
					!currentUrl.includes("auth");

				if (isLoggedIn || interceptedToken) {
					await new Promise((r) =>
						setTimeout(r, config.postLoginWaitMs ?? 3000),
					);

					const cookies = await context.cookies();
					const relevantCookies = cookies.filter((c) =>
						config.cookieNames.some((name) => c.name.includes(name)),
					);

					if (interceptedToken || relevantCookies.length > 0) {
						const ua = await pages[0].evaluate(() => navigator.userAgent);
						activeAuthBrowser.result = {
							success: true,
							cookies: relevantCookies,
							interceptedToken,
							userAgent: ua,
						};
						activeAuthBrowser.status = "captured";

						await context.close().catch(() => {});
						return;
					}
				}
			} catch {
				activeAuthBrowser.status = "error";
				activeAuthBrowser.result = {
					success: false,
					cookies: [],
					error: "Polling error",
				};
				await context.close().catch(() => {});
				return;
			}

			setTimeout(pollAuth, 2000);
		};

		setTimeout(pollAuth, config.postLoginWaitMs ?? 3000);

		return { ok: true };
	} catch (err) {
		activeAuthBrowser = null;
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to launch browser",
		};
	}
}

export function getAuthResult(provider: string): BrowserAuthResult | null {
	if (
		!activeAuthBrowser ||
		activeAuthBrowser.provider !== provider ||
		activeAuthBrowser.status !== "captured"
	) {
		return null;
	}
	const result = activeAuthBrowser.result;
	activeAuthBrowser = null;
	return result ?? null;
}

export async function closeBrowserAuth(provider: string): Promise<void> {
	if (
		activeAuthBrowser?.provider === provider &&
		activeAuthBrowser.status === "waiting"
	) {
		activeAuthBrowser.status = "closed";
		try {
			await activeAuthBrowser.context.close();
		} catch {}
		activeAuthBrowser = null;
	}
}
