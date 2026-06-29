// @ts-nocheck
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium as nativeChromium } from "patchright";
import { chromium as stealthChromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

stealthChromium.use(stealthPlugin());

import {
	UrlSafetyPolicy,
	type UrlSafetyPolicyConfig,
} from "../security/url-safety.js";
import { HumanBehavior } from "./human-behavior.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";

const BROWSER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
const DATADOME_BLOCK_RE =
	/datadome|captcha-delivery|geo\.captcha-delivery\.com|ct\.captcha-delivery\.com|ddcid|ddv|ddjskey|Pardon Our Interruption/i;
const GENERIC_BLOCK_RE =
	/Access denied|Verify you are human|Just a moment|Cloudflare|attention required|captcha|challenge|checking your browser|403 forbidden|unusual traffic|cf-browser-verification|g-recaptcha|h-captcha|cf-turnstile|arkose|funcaptcha|geetest|awswaf|amazon.?waf|capy|lemin|cybersiara|are you human/i;
const CAPTCHA_STILL_VISIBLE_RE =
	/captcha|recaptcha|h-captcha|g-recaptcha|I'm not a robot|I am not a robot|no soy un robot|unusual traffic|tr[aá]fico inusual|verify you are human|verifica que eres humano|are you human|checking your browser|challenge|security check/i;
const TWO_CAPTCHA_CREATE_TASK_URL = "https://api.2captcha.com/createTask";
const TWO_CAPTCHA_GET_RESULT_URL = "https://api.2captcha.com/getTaskResult";
const BROWSER_EVAL_TIMEOUT_MS = 15_000;
const MAX_BROWSER_WAIT_MS = 15_000;
const A11Y_TREE_MAX_NODES = 200;
const A11Y_TREE_MAX_TEXT_LENGTH = 300;
const CAPTCHA_POLL_INTERVAL_MS = 5_000;
const CAPTCHA_SOLVE_TIMEOUT_MS = 120_000;
const DECODO_SCRAPE_URL = "https://scraper-api.decodo.com/v2/scrape";

function isNavigationTimeoutError(error: unknown): boolean {
	return /timeout|timed out/i.test(
		error instanceof Error ? error.message : String(error),
	);
}

const REALISTIC_USER_AGENTS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
	"Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
];

const REALISTIC_VIEWPORTS = [
	{ width: 1920, height: 1080 },
	{ width: 1536, height: 864 },
	{ width: 1440, height: 900 },
	{ width: 1366, height: 768 },
	{ width: 1280, height: 800 },
	{ width: 1280, height: 720 },
	{ width: 1600, height: 900 },
];

const TRACKER_DOMAINS = [
	"google-analytics.com",
	"googletagmanager.com",
	"facebook.net",
	"connect.facebook.net",
	"hotjar.com",
	"intercom.io",
	"crisp.chat",
	"doubleclick.net",
	"adservice.google.com",
	"pagead2.googlesyndication.com",
	"amazon-adsystem.com",
	"adnxs.com",
	"adsrvr.org",
	"bidswitch.net",
	"casalemedia.com",
	"criteo.com",
	"demdex.net",
	"moatads.com",
	"outbrain.com",
	"rubiconproject.com",
	"scorecardresearch.com",
	"serving-sys.com",
	"sharethis.com",
	"taboola.com",
	"tapad.com",
	"quantserve.com",
	"newrelic.com",
	"fullstory.com",
	"log_entries",
	"segment.io",
	"segment.com",
	"amplitude.com",
	"mixpanel.com",
	"pendo.io",
	"clarity.ms",
	"bing.com/widget",
];

const POPUP_COOKIE_SELECTORS = [
	"button:has-text('Aceptar')",
	"button:has-text('Aceptar todo')",
	"button:has-text('Accept')",
	"button:has-text('Accept all')",
	"button:has-text('I agree')",
	"button:has-text('Agree')",
	"button:has-text('OK')",
	"button:has-text('Got it')",
	"button:has-text('Entendido')",
	"button:has-text('Continuar')",
	"button:has-text('Allow')",
	"button:has-text('Allow all')",
	"#accept-cookies",
	"#cookie-accept",
	"#onetrust-accept-btn-handler",
	"#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
	".cookie-accept",
	".accept-cookies",
	"[data-testid='cookie-accept']",
	"[aria-label='Accept cookies']",
	"[class*='accept'][class*='cookie']",
	"[id*='accept'][id*='cookie']",
	"[class*='cookie'][class*='btn']",
];

const POPUP_CLOSE_SELECTORS = [
	"button:has-text('×')",
	"button:has-text('✕')",
	"button:has-text('Close')",
	"button:has-text('Cerrar')",
	"button:has-text('No gracias')",
	"button:has-text('No thanks')",
	"button:has-text('Skip')",
	"button:has-text('Omitir')",
	"button:has-text('Maybe later')",
	"button:has-text('Más tarde')",
	"[aria-label='Close']",
	"[aria-label='Cerrar']",
	"[aria-label='Dismiss']",
	".modal-close",
	".close-button",
	".btn-close",
	"[class*='close'][class*='modal']",
	"[class*='dismiss']",
	"[class*='popup-close']",
	"button[class*='close']",
	"span[class*='close']",
	"a[class*='close']",
];

const LOCALE_TIMEZONE_MAP: Record<
	string,
	{
		locale: string;
		timezoneId: string;
		locales: string[];
		geo?: { latitude: number; longitude: number };
	}
> = {
	"America/New_York": {
		locale: "en-US",
		timezoneId: "America/New_York",
		locales: ["en-US", "en"],
		geo: { latitude: 40.71, longitude: -74.01 },
	},
	"America/Chicago": {
		locale: "en-US",
		timezoneId: "America/Chicago",
		locales: ["en-US", "en"],
		geo: { latitude: 41.88, longitude: -87.63 },
	},
	"America/Los_Angeles": {
		locale: "en-US",
		timezoneId: "America/Los_Angeles",
		locales: ["en-US", "en"],
		geo: { latitude: 34.05, longitude: -118.24 },
	},
	"America/Lima": {
		locale: "es-PE",
		timezoneId: "America/Lima",
		locales: ["es-PE", "es", "en-US", "en"],
		geo: { latitude: -12.05, longitude: -77.04 },
	},
	"America/Mexico_City": {
		locale: "es-MX",
		timezoneId: "America/Mexico_City",
		locales: ["es-MX", "es", "en-US", "en"],
		geo: { latitude: 19.43, longitude: -99.13 },
	},
	"America/Bogota": {
		locale: "es-CO",
		timezoneId: "America/Bogota",
		locales: ["es-CO", "es", "en-US", "en"],
		geo: { latitude: 4.71, longitude: -74.07 },
	},
	"America/Buenos_Aires": {
		locale: "es-AR",
		timezoneId: "America/Buenos_Aires",
		locales: ["es-AR", "es", "en-US", "en"],
		geo: { latitude: -34.6, longitude: -58.38 },
	},
	"Europe/Madrid": {
		locale: "es-ES",
		timezoneId: "Europe/Madrid",
		locales: ["es-ES", "es", "en-US", "en"],
		geo: { latitude: 40.42, longitude: -3.7 },
	},
	"Europe/Berlin": {
		locale: "de-DE",
		timezoneId: "Europe/Berlin",
		locales: ["de-DE", "de", "en-US", "en"],
		geo: { latitude: 52.52, longitude: 13.4 },
	},
	"Europe/London": {
		locale: "en-GB",
		timezoneId: "Europe/London",
		locales: ["en-GB", "en"],
		geo: { latitude: 51.51, longitude: -0.13 },
	},
	"Europe/Paris": {
		locale: "fr-FR",
		timezoneId: "Europe/Paris",
		locales: ["fr-FR", "fr", "en-US", "en"],
		geo: { latitude: 48.86, longitude: 2.35 },
	},
};

const TIMEZONE_KEYS = Object.keys(LOCALE_TIMEZONE_MAP);

// Maps a lowercased ISO-3166 country code (the format Decodo targets, e.g. "us",
// "es") to a timezone key in LOCALE_TIMEZONE_MAP so the browser fingerprint
// (timezone/locale/geolocation) matches the residential IP's country.
const COUNTRY_TO_TIMEZONE: Record<string, string> = {
	us: "America/New_York",
	pe: "America/Lima",
	mx: "America/Mexico_City",
	co: "America/Bogota",
	ar: "America/Buenos_Aires",
	es: "Europe/Madrid",
	de: "Europe/Berlin",
	gb: "Europe/London",
	uk: "Europe/London",
	fr: "Europe/Paris",
};

const STEALTH_INIT_SCRIPT = `
(() => {
	// Overwrite navigator.webdriver
	Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

	// Remove automation indicators
	delete window.__playwright;
	delete window.__pw_manual;
	delete window.__PW_inspect;
	delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
	delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
	delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

	// Override chrome runtime
	if (!window.chrome) {
		window.chrome = {};
	}
	if (!window.chrome.runtime) {
		window.chrome.runtime = { connect: function(){}, sendMessage: function(){} };
	}

	// Override Permissions API
	const originalQuery = window.navigator.permissions?.query;
	if (originalQuery) {
		window.navigator.permissions.query = (parameters) =>
			parameters.name === 'notifications'
				? Promise.resolve({ state: Notification.permission })
				: originalQuery(parameters);
	}

	// Override plugins to look realistic
	Object.defineProperty(navigator, 'plugins', {
		get: () => {
			const plugins = [
				{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
				{ name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
				{ name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
			];
			plugins.refresh = () => {};
			return plugins;
		},
	});

	// Override languages
	Object.defineProperty(navigator, 'languages', {
		get: () => {
			return window.__octopusFpLanguages || [navigator.language || 'en-US', 'en'];
		},
	});

	// Mask WebGL renderer to common hardware
	const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
	WebGLRenderingContext.prototype.getParameter = function(param) {
		if (param === 37445) return 'Intel Inc.';
		if (param === 37446) return 'Intel Iris OpenGL Engine';
		return getParameterOrig.call(this, param);
	};
	if (typeof WebGL2RenderingContext !== 'undefined') {
		const getParameter2Orig = WebGL2RenderingContext.prototype.getParameter;
		WebGL2RenderingContext.prototype.getParameter = function(param) {
			if (param === 37445) return 'Intel Inc.';
			if (param === 37446) return 'Intel Iris OpenGL Engine';
			return getParameter2Orig.call(this, param);
		};
	}

	// Prevent iframe contentWindow detection
	const origGetter = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')?.get;
	if (origGetter) {
		Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
			get: function() {
				const result = origGetter.call(this);
				if (result) {
					try {
						Object.defineProperty(result.navigator, 'webdriver', { get: () => undefined });
					} catch(e) {}
				}
				return result;
			}
		});
	}

	// Override toString for native functions to avoid detection
	const nativeToString = Function.prototype.toString;
	const fnsToPatch = new Map();
	function patchFn(fn, name) {
		if (fnsToPatch.has(fn)) return;
		fnsToPatch.set(fn, name);
	}
	
	const origQuerySelector = Document.prototype.querySelector;
	Document.prototype.querySelector = function(selectors) {
		if (selectors === '#chromedriver-done' || selectors === 'html[data-browserium]') return null;
		return origQuerySelector.call(this, selectors);
	};
	patchFn(Document.prototype.querySelector, 'function querySelector() { [native code] }');

	// Prevent screen fingerprinting variations
	if (window.screen) {
		Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
		Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24 });
	}

	// Override Function.prototype.toString to hide patches
	const fakeToString = function() {
		if (fnsToPatch.has(this)) return fnsToPatch.get(this);
		return nativeToString.call(this);
	};
	fakeToString.toString = () => 'function toString() { [native code] }';
	Function.prototype.toString = fakeToString;
})();
`;

const CAPTCHA_INIT_SCRIPT = `
(() => {
	const state = window.__octopusCaptcha || {
		recaptcha: [],
		hcaptcha: [],
		turnstile: [],
		funcaptcha: [],
		geetest: [],
		callbacks: {},
	};
	window.__octopusCaptcha = state;

	let callbackCounter = 0;
	const rememberCallback = (provider, callback) => {
		if (typeof callback !== 'function') return undefined;
		const id = provider + ':' + (++callbackCounter);
		state.callbacks[id] = callback;
		return id;
	};
	const pushUnique = (bucket, item) => {
		const key = JSON.stringify({
			provider: item.provider,
			sitekey: item.sitekey,
			publicKey: item.publicKey,
			captchaId: item.captchaId,
			action: item.action,
		});
		if (!state[bucket].some((entry) => entry.__key === key)) {
			state[bucket].push({ ...item, __key: key, url: location.href });
		}
	};
	const wrapRender = (objectName, bucket, provider, normalizer) => {
		const api = window[objectName];
		if (!api || typeof api.render !== 'function' || api.render.__octopusWrapped) return;
		const originalRender = api.render;
		api.render = function(container, params = {}, ...rest) {
			try {
				const normalized = normalizer(params, container) || {};
				const callbackId = rememberCallback(provider, params.callback);
				pushUnique(bucket, { provider, callbackId, ...normalized });
			} catch (e) {}
			return originalRender.call(this, container, params, ...rest);
		};
		api.render.__octopusWrapped = true;
	};
	const wrapGeeTest = () => {
		if (typeof window.initGeetest === 'function' && !window.initGeetest.__octopusWrapped) {
			const original = window.initGeetest;
			window.initGeetest = function(config = {}, callback) {
				try {
					pushUnique('geetest', {
						provider: 'geetest',
						version: config.version || 3,
						gt: config.gt,
						challenge: config.challenge,
						captchaId: config.captcha_id || config.captchaId,
						apiServer: config.api_server || config.apiServer,
					});
				} catch (e) {}
				return original.call(this, config, callback);
			};
			window.initGeetest.__octopusWrapped = true;
		}
	};
	const tick = () => {
		wrapRender('grecaptcha', 'recaptcha', 'recaptcha', (params) => ({
			sitekey: params.sitekey,
			size: params.size,
			action: params.action,
			enterprise: false,
		}));
		if (window.grecaptcha?.enterprise && typeof window.grecaptcha.enterprise.render === 'function' && !window.grecaptcha.enterprise.render.__octopusWrapped) {
			const originalEnterpriseRender = window.grecaptcha.enterprise.render;
			window.grecaptcha.enterprise.render = function(container, params = {}, ...rest) {
				try {
					const callbackId = rememberCallback('recaptcha-enterprise', params.callback);
					pushUnique('recaptcha', {
						provider: 'recaptcha-enterprise',
						callbackId,
						sitekey: params.sitekey,
						size: params.size,
						action: params.action,
						enterprise: true,
					});
				} catch (e) {}
				return originalEnterpriseRender.call(this, container, params, ...rest);
			};
			window.grecaptcha.enterprise.render.__octopusWrapped = true;
		}
		wrapRender('hcaptcha', 'hcaptcha', 'hcaptcha', (params) => ({
			sitekey: params.sitekey,
			size: params.size,
			rqdata: params.rqdata,
		}));
		wrapRender('turnstile', 'turnstile', 'turnstile', (params) => ({
			sitekey: params.sitekey,
			action: params.action,
			cData: params.cData,
			chlPageData: params.chlPageData,
		}));
		wrapGeeTest();
	};
	let attempts = 0;
	const timer = setInterval(() => {
		attempts += 1;
		tick();
		if (attempts > 200) clearInterval(timer);
	}, 100);
	tick();
})();
`;

function pickRandom<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

function generateFingerprint(country?: string): {
	userAgent: string;
	viewport: { width: number; height: number };
	screen: {
		width: number;
		height: number;
		availWidth: number;
		availHeight: number;
	};
	platform: string;
	locale: string;
	timezoneId: string;
	locales: string[];
	geo?: { latitude: number; longitude: number };
} {
	const ua = pickRandom(REALISTIC_USER_AGENTS);
	const viewport = pickRandom(REALISTIC_VIEWPORTS);
	const screen = {
		width: viewport.width,
		height: viewport.height,
		availWidth: viewport.width,
		availHeight: viewport.height - Math.floor(Math.random() * 80),
	};
	const platform = ua.includes("Macintosh")
		? "MacIntel"
		: ua.includes("Linux")
			? "Linux x86_64"
			: "Win32";
	// Prefer a timezone that matches the proxy IP's country so the browser's
	// timezone/locale line up with the residential IP geo. Fall back to a random
	// timezone only when no country is configured (e.g. running without a proxy,
	// where the OS/native timezone matches the real IP anyway).
	const normalizedCountry = country?.trim().toLowerCase();
	const tzKey =
		(normalizedCountry && COUNTRY_TO_TIMEZONE[normalizedCountry]) ||
		pickRandom(TIMEZONE_KEYS);
	const tzInfo = LOCALE_TIMEZONE_MAP[tzKey];
	return {
		userAgent: ua,
		viewport,
		screen,
		platform,
		locale: tzInfo.locale,
		timezoneId: tzInfo.timezoneId,
		locales: tzInfo.locales,
		geo: tzInfo.geo,
	};
}

type BrowserProvider = "embedded" | "brightdata" | "decodo";

function isValidBrowserWsUrl(value?: string | null): value is string {
	return typeof value === "string" && /^wss?:\/\//i.test(value.trim());
}

function isValidProxyUrl(value?: string | null): value is string {
	return (
		typeof value === "string" && /^(https?|socks5):\/\//i.test(value.trim())
	);
}

async function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTwoCaptchaApiKey(): string {
	return (
		process.env.TWOCAPTCHA_API_KEY ||
		process.env.TWO_CAPTCHA_API_KEY ||
		process.env.TWOCAPTCHA_TOKEN ||
		""
	).trim();
}

function safePathSegment(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 120) || "default"
	);
}

function originFromUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!/^https?:$/i.test(parsed.protocol)) return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

function hostnameFromUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!/^https?:$/i.test(parsed.protocol)) return null;
		return parsed.hostname;
	} catch {
		return null;
	}
}

function getUrlParam(
	rawUrl: string | undefined,
	names: string[],
): string | undefined {
	if (!rawUrl) return undefined;
	try {
		const parsed = new URL(rawUrl, "https://example.invalid");
		for (const name of names) {
			const value = parsed.searchParams.get(name);
			if (value) return value;
		}
	} catch {}
	return undefined;
}

function parseCookieString(
	cookie: string,
	fallbackUrl: string,
): Record<string, unknown> | null {
	if (!cookie || !cookie.includes("=")) return null;
	const parts = cookie
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean);
	const [nameValue, ...attrs] = parts;
	const eqIndex = nameValue.indexOf("=");
	if (eqIndex <= 0) return null;
	const parsed: Record<string, unknown> = {
		name: nameValue.slice(0, eqIndex),
		value: nameValue.slice(eqIndex + 1),
		path: "/",
		url: fallbackUrl,
	};
	for (const attr of attrs) {
		const [rawKey, rawValue] = attr.split("=", 2);
		const key = rawKey.toLowerCase();
		if (key === "domain" && rawValue) {
			parsed.domain = rawValue.startsWith(".") ? rawValue : `.${rawValue}`;
			parsed.url = undefined;
		} else if (key === "path" && rawValue) {
			parsed.path = rawValue;
		} else if (key === "secure") {
			parsed.secure = true;
		} else if (key === "httponly") {
			parsed.httpOnly = true;
		} else if (key === "samesite" && rawValue) {
			parsed.sameSite = rawValue;
		}
	}
	return parsed;
}

function buildDecodoUsername(
	baseUsername?: string,
	options: Record<string, string | undefined> = {},
): string | undefined {
	if (!baseUsername) return undefined;
	let username = baseUsername.trim();
	if (!username) return undefined;
	const hasTargeting = Boolean(
		options.country ||
			options.city ||
			options.state ||
			options.zip ||
			options.session ||
			options.sessionDuration,
	);
	if (hasTargeting && !username.startsWith("user-"))
		username = `user-${username}`;
	const append = (key: string, value?: string) => {
		if (!value || username.includes(`-${key}-`)) return;
		username += `-${key}-${value.trim().toLowerCase().replace(/\s+/g, "_")}`;
	};
	append("country", options.country);
	append("city", options.city);
	append("state", options.state);
	append("zip", options.zip);
	append("session", options.session);
	append("sessionduration", options.sessionDuration);
	return username;
}

function parseProxyUrl(proxyUrl: string): {
	server: string;
	username?: string;
	password?: string;
	host: string;
	port: number;
	protocol: string;
} | null {
	try {
		const parsed = new URL(proxyUrl);
		if (!/^(https?|socks5):$/i.test(parsed.protocol)) return null;
		const protocol = parsed.protocol.replace(":", "");
		const port = Number(parsed.port || (protocol === "https" ? 443 : 80));
		if (!parsed.hostname || !Number.isFinite(port)) return null;
		return {
			server: `${protocol}://${parsed.hostname}:${port}`,
			username: parsed.username
				? decodeURIComponent(parsed.username)
				: undefined,
			password: parsed.password
				? decodeURIComponent(parsed.password)
				: undefined,
			host: parsed.hostname,
			port,
			protocol,
		};
	} catch {
		return null;
	}
}

export interface BrowserConfig {
	executablePath?: string | null;
	userDataDir?: string;
	headless?: boolean;
	chromiumSandbox?: boolean;
	nativeFingerprint?: boolean;
	stealth?: boolean;
	provider?: "embedded" | "brightdata" | "decodo" | "auto";
	brightDataEnabled?: boolean;
	brightDataWsUrl?: string;
	decodoEnabled?: boolean;
	decodoProxyUrl?: string;
	decodoProxyUsername?: string;
	decodoProxyPassword?: string;
	decodoProxyCountry?: string;
	decodoProxyCity?: string;
	decodoProxyState?: string;
	decodoProxyZip?: string;
	decodoProxySession?: string;
	decodoProxySessionDuration?: string;
	decodoScraperToken?: string;
	decodoScraperUsername?: string;
	decodoScraperPassword?: string;
	solveCaptchas?: boolean;
	captchaProvider?: "2captcha";
	captchaTimeoutMs?: number;
	captchaApiKey?: string;
	persistCookies?: boolean;
	sessionStorageDir?: string;
	sessionTtlHours?: number;
	autoFallbackOnBlock?: boolean;
	blockFallbackProvider?: BrowserProvider;
	confirmBlockWithVision?: boolean;
	blockResources?: string[];
	blockTrackerDomains?: boolean;
	humanBehavior?: boolean;
	autoDismissPopups?: boolean;
	urlPolicy?: UrlSafetyPolicyConfig;
}

interface BrowserBlockDetectionResult {
	detected: boolean;
	output: string;
	fallbackApplied: boolean;
}

interface VerificationState {
	blocked: boolean;
	captchaVisible: boolean;
	url: string;
	title: string;
	textSample: string;
	signals: string[];
}

export class BrowserTool {
	private config: BrowserConfig;
	private browser: unknown = null;
	private context: unknown = null;
	private page: unknown = null;
	private activeProvider: BrowserProvider | null = null;
	private fingerprint: ReturnType<typeof generateFingerprint> | null = null;
	private liveUserAgent: string | null = null;
	private humanSim = new HumanBehavior();
	private urlSafetyPolicy: UrlSafetyPolicy;
	private lastSnapshot: {
		id: string;
		url: string;
		createdAt: number;
		output: string;
		uidToSelector: Map<string, string>;
	} | null = null;
	private imageNetworkIssues: Array<{
		url: string;
		status?: number;
		failure?: string;
		resourceType?: string;
	}> = [];
	private networkDiagnosticsAttached = false;

	constructor(config: BrowserConfig) {
		this.config = config;
		this.urlSafetyPolicy = new UrlSafetyPolicy(config.urlPolicy);
	}

	private chromiumController(): typeof nativeChromium {
		return this.config.stealth === true ? stealthChromium : nativeChromium;
	}

	private resolveProxyCountry(): string | undefined {
		return (
			this.config.decodoProxyCountry ||
			process.env.DECODO_PROXY_COUNTRY ||
			undefined
		);
	}

	private ensureFingerprint(): ReturnType<typeof generateFingerprint> {
		if (!this.fingerprint) {
			this.fingerprint = generateFingerprint(this.resolveProxyCountry());
		}
		return this.fingerprint;
	}

	// Real User-Agent of the launched browser, captured at runtime. Under the
	// default (Patchright + real Chrome) path we intentionally do NOT inject a
	// fake UA, so the fingerprint's random UA would be wrong — this returns the
	// value the page actually presents, which is what 2captcha needs.
	private resolveUserAgent(): string {
		return this.liveUserAgent ?? this.ensureFingerprint().userAgent;
	}

	// 2captcha API key: config first, then env vars (fallback for existing users).
	private resolveCaptchaApiKey(): string {
		return (this.config.captchaApiKey || getTwoCaptchaApiKey()).trim();
	}

	// Decodo scraping API token: config first, then env vars.
	private resolveDecodoScraperToken(): string {
		return (
			this.config.decodoScraperToken ||
			process.env.DECODO_SCRAPER_TOKEN ||
			process.env.DECODO_API_TOKEN ||
			""
		).trim();
	}

	// Decodo scraping API Authorization header (token preferred, else user/pass).
	private resolveDecodoScraperAuthorization(): string {
		const token = this.resolveDecodoScraperToken();
		if (token) return token.startsWith("Basic ") ? token : `Basic ${token}`;
		const username =
			this.config.decodoScraperUsername ||
			process.env.DECODO_SCRAPER_USERNAME ||
			process.env.DECODO_API_USERNAME;
		const password =
			this.config.decodoScraperPassword ||
			process.env.DECODO_SCRAPER_PASSWORD ||
			process.env.DECODO_API_PASSWORD;
		if (username && password) {
			return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
		}
		return "";
	}

	private buildBrowserContextOptions(): Record<string, unknown> {
		const fp = this.ensureFingerprint();
		// Default (Patchright + real Chrome) path: let the browser supply its own
		// User-Agent/headers (Patchright best practice — overriding them creates
		// detectable mismatches). Only couple timezone/locale/geolocation to the
		// proxy IP's country, since IP geo is server-observable and must agree
		// with the browser's reported timezone/locale. When no country is coupled
		// (no proxy), keep fully native so the OS timezone matches the real IP.
		if (this.config.nativeFingerprint !== false) {
			const opts: Record<string, unknown> = { viewport: fp.viewport };
			if (fp.geo) {
				opts.timezoneId = fp.timezoneId;
				opts.locale = fp.locale;
				opts.geolocation = {
					latitude: fp.geo.latitude,
					longitude: fp.geo.longitude,
				};
				opts.permissions = ["geolocation"];
			}
			return opts;
		}
		// Legacy non-native path (nativeFingerprint: false): keeps the injected
		// fingerprint but fixes the geolocation leak (was hardcoded to 0,0 in the
		// Gulf of Guinea) and pins deviceScaleFactor instead of a random value.
		const acceptLangs = fp.locales.join(",");
		const opts: Record<string, unknown> = {
			viewport: fp.viewport,
			userAgent: fp.userAgent,
			locale: fp.locale,
			platform: fp.platform,
			colorScheme: "light",
			deviceScaleFactor: 1,
			hasTouch: false,
			isMobile: false,
			javaScriptEnabled: true,
			timezoneId: fp.timezoneId,
			extraHTTPHeaders: {
				"Accept-Language": `${acceptLangs};q=0.9`,
				DNT: "1",
			},
		};
		if (fp.geo) {
			opts.geolocation = {
				latitude: fp.geo.latitude,
				longitude: fp.geo.longitude,
			};
			opts.permissions = ["geolocation"];
		}
		return opts;
	}

	private async addBrowserInitScripts(): Promise<void> {
		if (!this.context) return;
		const fp = this.ensureFingerprint();
		if (this.config.stealth === true) {
			await this.context.addInitScript((locales) => {
				window.__octopusFpLanguages = locales;
			}, fp.locales);
			await this.context.addInitScript(STEALTH_INIT_SCRIPT);
		}
		await this.context.addInitScript(CAPTCHA_INIT_SCRIPT);
	}

	private invalidateSnapshotCache(): void {
		this.lastSnapshot = null;
	}

	private getSessionConfig(): {
		enabled: boolean;
		storageDir: string;
		ttlHours: number;
	} {
		return {
			enabled: this.config.persistCookies !== false,
			storageDir:
				this.config.sessionStorageDir ||
				join(homedir(), ".octopus", "browser-sessions"),
			ttlHours: Number.isFinite(this.config.sessionTtlHours)
				? Math.max(1, this.config.sessionTtlHours as number)
				: 168,
		};
	}

	private getSessionStatePath(url: string): string | null {
		const host = hostnameFromUrl(url);
		if (!host) return null;
		const session = this.getSessionConfig();
		const provider = safePathSegment(
			this.activeProvider || this.config.provider || "auto",
		);
		return join(
			session.storageDir,
			provider,
			safePathSegment(host),
			"storageState.json",
		);
	}

	private async loadSessionForUrl(url: string): Promise<boolean> {
		const session = this.getSessionConfig();
		if (!session.enabled || !this.context) return false;
		const path = this.getSessionStatePath(url);
		const origin = originFromUrl(url);
		if (!path || !origin) return false;

		try {
			const stats = await fs.promises.stat(path);
			const ageMs = Date.now() - stats.mtimeMs;
			if (ageMs > session.ttlHours * 60 * 60 * 1000) return false;
			const state = JSON.parse(await fs.promises.readFile(path, "utf8"));
			if (Array.isArray(state.cookies) && state.cookies.length > 0) {
				await this.context.addCookies(state.cookies).catch(() => {});
			}
			const originState = Array.isArray(state.origins)
				? state.origins.find(
						(item: { origin?: string }) => item.origin === origin,
					)
				: null;
			if (originState?.localStorage?.length) {
				await this.context.addInitScript(
					({ expectedOrigin, entries }) => {
						try {
							if (location.origin !== expectedOrigin) return;
							for (const entry of entries)
								localStorage.setItem(entry.name, entry.value);
						} catch (e) {}
					},
					{ expectedOrigin: origin, entries: originState.localStorage },
				);
			}
			return true;
		} catch {
			return false;
		}
	}

	// Detects a REAL block/challenge without matching the anti-bot scripts that
	// protected sites (e.g. Etsy, Facebook) embed on every normal page. We never
	// test raw HTML for DataDome — instead we look for definitive challenge
	// signals (the captcha-delivery host/iframe or challenge text in the VISIBLE
	// page) and we suppress any weak match when the page clearly has real content.
	private async analyzeBlockState(): Promise<{
		blocked: boolean;
		dataDome: boolean;
		contentRich: boolean;
	}> {
		if (!this.page)
			return { blocked: false, dataDome: false, contentRich: false };
		try {
			const url = this.page.url();
			const title = await this.page.title().catch(() => "");
			const probe = await this.page
				.evaluate(() => ({
					visible: document.body?.innerText || "",
					textLen: (document.body?.innerText || "").replace(/\s+/g, "").length,
					elementCount: document.querySelectorAll("*").length,
					challengeIframe: !!document.querySelector(
						'iframe[src*="captcha-delivery.com"]',
					),
				}))
				.catch(() => ({
					visible: "",
					textLen: 0,
					elementCount: 0,
					challengeIframe: false,
				}));

			const visibleCombined = `${title}\n${probe.visible}`;
			const onChallengeHost = /captcha-delivery\.com/i.test(url);
			const dataDomeVisible = DATADOME_BLOCK_RE.test(visibleCombined);
			const contentRich = probe.textLen > 800 && probe.elementCount > 80;
			const dataDome =
				onChallengeHost ||
				dataDomeVisible ||
				(probe.challengeIframe && !contentRich);

			// Abundant real content + no definitive challenge signal => not blocked.
			// This is what stops a fully-loaded Etsy page (which always carries
			// DataDome script tags) from being misread as a DataDome challenge.
			if (
				contentRich &&
				!onChallengeHost &&
				!dataDomeVisible &&
				!probe.challengeIframe
			) {
				return { blocked: false, dataDome: false, contentRich };
			}

			const generic = GENERIC_BLOCK_RE.test(visibleCombined);
			return { blocked: dataDome || generic, dataDome, contentRich };
		} catch {
			return { blocked: false, dataDome: false, contentRich: false };
		}
	}

	private async isCurrentPageBlocked(): Promise<boolean> {
		const state = await this.analyzeBlockState();
		return state.blocked;
	}

	/**
	 * Web search via the real browser, used as a fallback when the web_search
	 * API (Z.ai) is out of quota. Tries Google, then Bing, then DuckDuckGo. On a
	 * block (CAPTCHA/challenge), it clears the host session and retries once
	 * before moving to the next engine. Reuses the stealth browser, session
	 * persistence, proxy/fallback provider and block detection already in place.
	 */
	private async searchViaBrowser(
		query: string,
		engines: string[],
		maxResults: number,
	): Promise<{
		engine: string | null;
		results: Array<{ title: string; url: string }>;
		blocked: boolean;
		retried: boolean;
		error?: string;
	}> {
		const engineBuilders: Array<{
			name: string;
			url: (q: string) => string;
		}> = [
			{
				name: "google",
				url: (q) =>
					`https://www.google.com/search?q=${encodeURIComponent(q)}&hl=es&num=20`,
			},
			{
				name: "bing",
				url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
			},
			{
				name: "duckduckgo",
				url: (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
			},
		];
		const wanted =
			engines.length > 0 ? engines : ["google", "bing", "duckduckgo"];
		const ordered = engineBuilders.filter((e) => wanted.includes(e.name));
		let lastError = "";

		for (const engine of ordered) {
			const target = engine.url(query);
			let blocked = false;
			let retried = false;
			try {
				await this.gotoWithSession(target, {
					waitUntil: "domcontentloaded",
					timeout: 30000,
				});
				await this.randomDelay(800, 2200);
				blocked = await this.isCurrentPageBlocked();
				if (blocked) {
					// Clear the host session and retry once on a clean session.
					retried = true;
					await this.clearCookiesForCurrentHost();
					await this.gotoWithSession(target, {
						waitUntil: "domcontentloaded",
						timeout: 30000,
					});
					await this.randomDelay(800, 2200);
					blocked = await this.isCurrentPageBlocked();
					if (blocked) {
						lastError = `${engine.name} returned a block/challenge after retry`;
						continue;
					}
				}
				const results = await this.extractSerpResults(maxResults);
				if (results.length > 0) {
					return { engine: engine.name, results, blocked, retried };
				}
				lastError = `${engine.name} returned no parseable results`;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}
		}
		return {
			engine: null,
			results: [],
			blocked: false,
			retried: false,
			error: lastError,
		};
	}

	private async clearCookiesForCurrentHost(): Promise<void> {
		if (!this.context || !this.page) return;
		try {
			const host = hostnameFromUrl(this.page.url());
			if (!host) return;
			// clearCookies accepts a URL filter (domain/path) in Playwright.
			await (
				this.context as {
					clearCookies: (filter?: { domain?: string }) => Promise<void>;
				}
			).clearCookies({ domain: host });
		} catch {
			// Best-effort; not all contexts support filtered clearing.
		}
	}

	/** Extract {title, url} search-result links from a SERP page. */
	private async extractSerpResults(
		maxResults: number,
	): Promise<Array<{ title: string; url: string }>> {
		if (!this.page) return [];
		const raw = await this.page
			.evaluate(() => {
				const internalHints = [
					"google.",
					"bing.",
					"duckduckgo",
					"youtube.com",
					"googleapis.",
					"gstatic.",
					"msn.",
				];
				const out: Array<{ title: string; url: string }> = [];
				const seen = new Set<string>();
				const anchors = Array.from(document.querySelectorAll("a[href]"));
				for (const a of anchors) {
					let href = (a as HTMLAnchorElement).href;
					if (!href) continue;
					const heading = a.querySelector("h3, h2") as HTMLElement | null;
					const text = (
						heading?.innerText ||
						(a as HTMLElement).innerText ||
						a.getAttribute("aria-label") ||
						""
					)
						.replace(/\s+/g, " ")
						.trim();
					if (!text || text.length < 5) continue;
					const rect = (a as HTMLElement).getBoundingClientRect();
					if (rect.width === 0 || rect.height === 0) continue;
					try {
						const u = new URL(href);
						// Google wraps results as /url?q=<real>; unwrap to the target.
						if (u.pathname === "/url") {
							const q = u.searchParams.get("q");
							if (q) href = new URL(q).href;
						}
						const finalHost = new URL(href).hostname;
						if (internalHints.some((h) => finalHost.includes(h))) continue;
					} catch {
						continue;
					}
					if (seen.has(href)) continue;
					seen.add(href);
					out.push({ title: text.slice(0, 160), url: href });
					if (out.length >= Math.max(maxResults * 2, 20)) break;
				}
				return out;
			})
			.catch(() => []);
		return raw.slice(0, maxResults);
	}

	private async saveSessionForCurrentPage(): Promise<boolean> {
		const session = this.getSessionConfig();
		if (!session.enabled || !this.context || !this.page) return false;
		const url = this.page.url();
		const path = this.getSessionStatePath(url);
		if (!path || (await this.isCurrentPageBlocked())) return false;
		try {
			await fs.promises.mkdir(dirname(path), { recursive: true });
			await this.context.storageState({ path });
			return true;
		} catch {
			return false;
		}
	}

	private async gotoWithSession(
		url: string,
		options: Record<string, unknown> = {},
	): Promise<unknown> {
		await this.urlSafetyPolicy.assertAllowedAsync(
			url,
			"Browser navigation URL",
		);
		await this.loadSessionForUrl(url);
		this.invalidateSnapshotCache();
		this.resetImageNetworkIssues();
		const response = await this.page.goto(url, options);
		const finalUrl = this.page.url();
		if (
			typeof finalUrl === "string" &&
			finalUrl &&
			finalUrl !== "about:blank"
		) {
			await this.urlSafetyPolicy.assertAllowedAsync(
				finalUrl,
				"Browser redirect URL",
			);
		}
		return response;
	}

	private async waitForImageElements(timeoutMs = 5000): Promise<void> {
		if (!this.page) return;
		if (typeof this.page.waitForFunction !== "function") return;
		await this.page
			.waitForFunction(
				() => Array.from(document.images).every((img) => img.complete),
				undefined,
				{ timeout: timeoutMs },
			)
			.catch(() => {});
	}

	private resetImageNetworkIssues(): void {
		this.imageNetworkIssues = [];
	}

	private recordImageNetworkIssue(issue: {
		url: string;
		status?: number;
		failure?: string;
		resourceType?: string;
	}): void {
		if (!issue.url) return;
		this.imageNetworkIssues.push(issue);
		if (this.imageNetworkIssues.length > 25) this.imageNetworkIssues.shift();
	}

	private setupNetworkDiagnostics(): void {
		if (!this.page || this.networkDiagnosticsAttached) return;
		this.networkDiagnosticsAttached = true;
		this.page.on("requestfailed", (request: unknown) => {
			try {
				const resourceType = request.resourceType?.();
				if (resourceType !== "image") return;
				this.recordImageNetworkIssue({
					url: request.url?.() || "",
					failure: request.failure?.()?.errorText || "request failed",
					resourceType,
				});
			} catch {}
		});
		this.page.on("response", (response: unknown) => {
			try {
				const request = response.request?.();
				const resourceType = request?.resourceType?.();
				if (resourceType !== "image") return;
				const status = response.status?.();
				if (typeof status !== "number" || status < 400) return;
				this.recordImageNetworkIssue({
					url: response.url?.() || request?.url?.() || "",
					status,
					resourceType,
				});
			} catch {}
		});
	}

	private summarizeImageNetworkIssues(): string {
		if (this.imageNetworkIssues.length === 0) return "";
		const sample = this.imageNetworkIssues
			.slice(-5)
			.map((issue) => {
				const reason = issue.status
					? `HTTP ${issue.status}`
					: issue.failure || "failed";
				return `${reason}: ${issue.url}`;
			})
			.join(" | ");
		return `\nImage network issues: ${this.imageNetworkIssues.length}. ${sample}`;
	}

	private async summarizeImageElements(): Promise<string> {
		if (!this.page) return "";
		if (typeof this.page.evaluate !== "function") return "";
		const images = await this.page
			.evaluate(() =>
				Array.from(document.images).map((img) => ({
					src: img.currentSrc || img.src,
					alt: img.alt || "",
					complete: img.complete,
					naturalWidth: img.naturalWidth,
					naturalHeight: img.naturalHeight,
				})),
			)
			.catch(() => []);
		if (!Array.isArray(images) || images.length === 0)
			return this.summarizeImageNetworkIssues();

		const loaded = images.filter(
			(img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0,
		).length;
		const broken = images.filter(
			(img) =>
				img.complete && (img.naturalWidth === 0 || img.naturalHeight === 0),
		);
		const loading = images.length - loaded - broken.length;
		const brokenSample = broken
			.slice(0, 5)
			.map((img) => img.src)
			.filter(Boolean);
		const brokenOutput = brokenSample.length
			? ` Broken sample: ${brokenSample.join(", ")}`
			: "";
		return `\nImages: ${loaded}/${images.length} loaded, ${broken.length} broken, ${loading} still loading.${brokenOutput}${this.summarizeImageNetworkIssues()}`;
	}

	private getTwoCaptchaProxyConfig(): Record<string, unknown> | null {
		const proxyAddress =
			process.env.TWOCAPTCHA_PROXY_ADDRESS ||
			process.env.TWO_CAPTCHA_PROXY_ADDRESS;
		const proxyPort =
			process.env.TWOCAPTCHA_PROXY_PORT || process.env.TWO_CAPTCHA_PROXY_PORT;
		if (!proxyAddress || !proxyPort)
			return this.getDecodoTwoCaptchaProxyConfig();
		const port = Number(proxyPort);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(
				"Invalid TWOCAPTCHA_PROXY_PORT; expected integer 1-65535",
			);
		}
		const proxy: Record<string, unknown> = {
			proxyType:
				process.env.TWOCAPTCHA_PROXY_TYPE ||
				process.env.TWO_CAPTCHA_PROXY_TYPE ||
				"HTTP",
			proxyAddress,
			proxyPort: port,
		};
		const login =
			process.env.TWOCAPTCHA_PROXY_LOGIN || process.env.TWO_CAPTCHA_PROXY_LOGIN;
		const password =
			process.env.TWOCAPTCHA_PROXY_PASSWORD ||
			process.env.TWO_CAPTCHA_PROXY_PASSWORD;
		if (login) proxy.proxyLogin = login;
		if (password) proxy.proxyPassword = password;
		return proxy;
	}

	private async createTwoCaptchaTask(
		task: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const clientKey = this.resolveCaptchaApiKey();
		if (!clientKey) {
			throw new Error(
				"TWOCAPTCHA_API_KEY is not configured. Set it with manage_env or the process environment.",
			);
		}

		const createResponse = await fetch(TWO_CAPTCHA_CREATE_TASK_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientKey, task }),
		});
		const createJson = await createResponse.json().catch(() => ({}));
		if (!createResponse.ok || createJson.errorId) {
			throw new Error(
				createJson.errorDescription ||
					`2captcha createTask failed with HTTP ${createResponse.status}`,
			);
		}
		const taskId = createJson.taskId;
		if (!taskId) throw new Error("2captcha createTask did not return taskId");

		const timeoutMs = Number.isFinite(this.config.captchaTimeoutMs)
			? (this.config.captchaTimeoutMs as number)
			: CAPTCHA_SOLVE_TIMEOUT_MS;
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			await sleep(CAPTCHA_POLL_INTERVAL_MS);
			const resultResponse = await fetch(TWO_CAPTCHA_GET_RESULT_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ clientKey, taskId }),
			});
			const resultJson = await resultResponse.json().catch(() => ({}));
			if (!resultResponse.ok || resultJson.errorId) {
				throw new Error(
					resultJson.errorDescription ||
						`2captcha getTaskResult failed with HTTP ${resultResponse.status}`,
				);
			}
			if (resultJson.status === "ready") return resultJson.solution || {};
			if (resultJson.status !== "processing") {
				throw new Error(
					`2captcha returned unexpected status: ${resultJson.status || "unknown"}`,
				);
			}
		}
		throw new Error(`2captcha solve timed out after ${timeoutMs}ms`);
	}

	private async detectCaptchaChallenges(): Promise<
		Array<Record<string, unknown>>
	> {
		if (!this.page) return [];
		return this.page.evaluate(() => {
			const challenges = [];
			const seen = new Set();
			const add = (challenge) => {
				if (!challenge?.kind) return;
				const key = [
					challenge.kind,
					challenge.websiteKey,
					challenge.publicKey,
					challenge.gt,
					challenge.challenge,
					challenge.captchaUrl,
					challenge.selector,
				]
					.filter(Boolean)
					.join("|");
				if (seen.has(key)) return;
				seen.add(key);
				challenges.push({ websiteURL: location.href, ...challenge });
			};
			const param = (raw, names) => {
				try {
					const url = new URL(raw, location.href);
					for (const name of names) {
						const value = url.searchParams.get(name);
						if (value) return value;
					}
				} catch (e) {}
				return undefined;
			};
			const selectorFor = (el) => {
				if (!el) return undefined;
				if (el.id) return `#${CSS.escape(el.id)}`;
				const tag = el.tagName?.toLowerCase?.() || "div";
				const attr = [
					"name",
					"data-sitekey",
					"data-capy-sitekey",
					"data-lemin-captcha-id",
				].find((name) => el.getAttribute?.(name));
				if (attr)
					return `${tag}[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
				return tag;
			};

			const captured = window.__octopusCaptcha || {};
			for (const item of captured.recaptcha || []) {
				if (item.sitekey)
					add({
						kind: item.enterprise
							? "recaptcha-v2-enterprise"
							: item.action
								? "recaptcha-v3"
								: "recaptcha-v2",
						websiteKey: item.sitekey,
						isInvisible: item.size === "invisible",
						pageAction: item.action,
						callbackId: item.callbackId,
						enterprise: Boolean(item.enterprise),
					});
			}
			for (const item of captured.hcaptcha || []) {
				if (item.sitekey)
					add({
						kind: "hcaptcha",
						websiteKey: item.sitekey,
						isInvisible: item.size === "invisible",
						rqdata: item.rqdata,
						callbackId: item.callbackId,
					});
			}
			for (const item of captured.turnstile || []) {
				if (item.sitekey)
					add({
						kind: "turnstile",
						websiteKey: item.sitekey,
						action: item.action,
						cData: item.cData,
						chlPageData: item.chlPageData,
						callbackId: item.callbackId,
					});
			}
			for (const item of captured.geetest || []) {
				if (item.captchaId)
					add({ kind: "geetest-v4", captchaId: item.captchaId });
				else if (item.gt && item.challenge)
					add({
						kind: "geetest-v3",
						gt: item.gt,
						challenge: item.challenge,
						apiServer: item.apiServer,
					});
			}

			for (const el of document.querySelectorAll(
				".g-recaptcha[data-sitekey], [data-sitekey].g-recaptcha",
			)) {
				add({
					kind: "recaptcha-v2",
					websiteKey: el.getAttribute("data-sitekey"),
					isInvisible: el.getAttribute("data-size") === "invisible",
					selector: selectorFor(el),
				});
			}
			for (const el of document.querySelectorAll(
				".h-captcha[data-sitekey], [data-sitekey].h-captcha",
			)) {
				add({
					kind: "hcaptcha",
					websiteKey: el.getAttribute("data-sitekey"),
					isInvisible: el.getAttribute("data-size") === "invisible",
					selector: selectorFor(el),
				});
			}
			for (const el of document.querySelectorAll(
				".cf-turnstile[data-sitekey], [data-sitekey].cf-turnstile",
			)) {
				add({
					kind: "turnstile",
					websiteKey: el.getAttribute("data-sitekey"),
					action: el.getAttribute("data-action"),
					cData: el.getAttribute("data-cdata"),
					selector: selectorFor(el),
				});
			}
			for (const iframe of document.querySelectorAll("iframe[src]")) {
				const src = iframe.getAttribute("src") || "";
				if (/recaptcha\/api2\/anchor|google\.com\/recaptcha/i.test(src))
					add({
						kind: "recaptcha-v2",
						websiteKey: param(src, ["k", "sitekey"]),
						selector: selectorFor(iframe),
					});
				if (/hcaptcha\.com/i.test(src))
					add({
						kind: "hcaptcha",
						websiteKey: param(src, ["sitekey", "k"]),
						selector: selectorFor(iframe),
					});
				if (/challenges\.cloudflare\.com|turnstile/i.test(src))
					add({
						kind: "turnstile",
						websiteKey: param(src, ["sitekey", "k"]),
						action: param(src, ["action"]),
						cData: param(src, ["cData", "cdata"]),
						chlPageData: param(src, ["chlPageData", "pagedata"]),
						selector: selectorFor(iframe),
					});
				if (/arkoselabs|funcaptcha/i.test(src))
					add({
						kind: "funcaptcha",
						publicKey: param(src, ["public_key", "pkey", "pk"]),
						apiSubdomain: (() => {
							try {
								return new URL(src, location.href).hostname;
							} catch {
								return undefined;
							}
						})(),
						selector: selectorFor(iframe),
					});
				if (/captcha-delivery|datadome/i.test(src))
					add({
						kind: "datadome",
						captchaUrl: src,
						selector: selectorFor(iframe),
					});
			}
			const fcToken = document.querySelector(
				'input[name="fc-token"], input[id*="fc-token"]',
			);
			if (fcToken)
				add({
					kind: "funcaptcha",
					publicKey:
						fcToken.getAttribute("data-pkey") ||
						fcToken.value?.match(/pk=([^|]+)/)?.[1],
					selector: selectorFor(fcToken),
				});
			for (const el of document.querySelectorAll(
				"[data-pkey], [data-public-key]",
			)) {
				add({
					kind: "funcaptcha",
					publicKey:
						el.getAttribute("data-pkey") || el.getAttribute("data-public-key"),
					selector: selectorFor(el),
				});
			}
			for (const el of document.querySelectorAll(
				"[data-capy-sitekey], [data-capy-key]",
			)) {
				add({
					kind: "capy",
					websiteKey:
						el.getAttribute("data-capy-sitekey") ||
						el.getAttribute("data-capy-key"),
					selector: selectorFor(el),
				});
			}
			for (const el of document.querySelectorAll(
				"[data-lemin-captcha-id], [data-lemin-div-id]",
			)) {
				add({
					kind: "lemin",
					captchaId: el.getAttribute("data-lemin-captcha-id"),
					divId: el.getAttribute("data-lemin-div-id") || el.id,
					selector: selectorFor(el),
				});
			}
			const bodyText = document.documentElement.innerHTML.slice(0, 250000);
			const geetestV3 = bodyText.match(
				/gt["']?\s*[:=]\s*["']([^"']+)["'][\s\S]{0,500}?challenge["']?\s*[:=]\s*["']([^"']+)["']/i,
			);
			if (geetestV3)
				add({ kind: "geetest-v3", gt: geetestV3[1], challenge: geetestV3[2] });
			const geetestV4 = bodyText.match(
				/captcha_id["']?\s*[:=]\s*["']([^"']+)["']/i,
			);
			if (geetestV4) add({ kind: "geetest-v4", captchaId: geetestV4[1] });
			const cyber = bodyText.match(
				/SlideMasterUrlId["']?\s*[:=]\s*["']([^"']+)["']/i,
			);
			if (cyber) add({ kind: "cybersiara", slideMasterUrlId: cyber[1] });
			const amazon = bodyText.match(
				/(?:challengeScript|captchaScript|jsapiScript|awswaf|AwsWaf|amazon-waf)/i,
			);
			if (amazon) {
				add({
					kind: "amazon-waf",
					websiteKey: bodyText.match(
						/websiteKey["']?\s*[:=]\s*["']([^"']+)["']/i,
					)?.[1],
					iv: bodyText.match(/iv["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1],
					context: bodyText.match(
						/context["']?\s*[:=]\s*["']([^"']+)["']/i,
					)?.[1],
					jsapiScript: Array.from(document.scripts)
						.map((s) => s.src)
						.find((src) => /awswaf|captcha|challenge/i.test(src)),
				});
			}
			const captchaImage = Array.from(
				document.querySelectorAll("img[src], canvas"),
			).find((el) => {
				const text = `${el.getAttribute?.("src") || ""} ${el.getAttribute?.("alt") || ""} ${el.getAttribute?.("aria-label") || ""}`;
				const rect = el.getBoundingClientRect();
				return (
					rect.width > 20 &&
					rect.height > 20 &&
					/captcha|verification|security code/i.test(text)
				);
			});
			if (captchaImage) {
				const input = Array.from(
					document.querySelectorAll('input:not([type="hidden"]), textarea'),
				).find((el) => {
					const text = `${el.getAttribute("name") || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""}`;
					return /captcha|code|verification|security/i.test(text);
				});
				add({
					kind: "image-to-text",
					selector: selectorFor(captchaImage),
					inputSelector: selectorFor(input),
					comment: "Solve the visual captcha shown in the image.",
				});
			}
			return challenges.filter((challenge) => {
				if (
					[
						"recaptcha-v2",
						"recaptcha-v2-enterprise",
						"recaptcha-v3",
						"hcaptcha",
						"turnstile",
					].includes(challenge.kind)
				)
					return Boolean(challenge.websiteKey);
				if (challenge.kind === "funcaptcha")
					return Boolean(challenge.publicKey);
				if (challenge.kind === "datadome") return Boolean(challenge.captchaUrl);
				return true;
			});
		});
	}

	private buildTwoCaptchaTask(
		challenge: Record<string, unknown>,
	): Record<string, unknown> | null {
		const websiteURL = String(challenge.websiteURL || this.page?.url?.() || "");
		const websiteKey = challenge.websiteKey
			? String(challenge.websiteKey)
			: undefined;
		const proxy = this.getTwoCaptchaProxyConfig();
		const withProxy = (
			proxylessType: string,
			task: Record<string, unknown>,
		) => {
			if (!proxy) return { type: proxylessType, ...task };
			return {
				type: proxylessType.replace("Proxyless", ""),
				...task,
				...proxy,
			};
		};
		const fp = this.ensureFingerprint();

		switch (challenge.kind) {
			case "recaptcha-v2":
				return withProxy("RecaptchaV2TaskProxyless", {
					websiteURL,
					websiteKey,
					isInvisible: Boolean(challenge.isInvisible),
					userAgent: this.resolveUserAgent(),
				});
			case "recaptcha-v2-enterprise":
				return withProxy("RecaptchaV2EnterpriseTaskProxyless", {
					websiteURL,
					websiteKey,
					isInvisible: Boolean(challenge.isInvisible),
					userAgent: this.resolveUserAgent(),
					enterprisePayload: challenge.enterprisePayload,
				});
			case "recaptcha-v3":
				return {
					type: "RecaptchaV3TaskProxyless",
					websiteURL,
					websiteKey,
					minScore: 0.3,
					pageAction: challenge.pageAction,
					isEnterprise: Boolean(challenge.enterprise),
					apiDomain: challenge.apiDomain,
				};
			case "hcaptcha":
				return withProxy("HCaptchaTaskProxyless", {
					websiteURL,
					websiteKey,
					isInvisible: Boolean(challenge.isInvisible),
					rqdata: challenge.rqdata,
					userAgent: this.resolveUserAgent(),
				});
			case "turnstile":
				return withProxy("TurnstileTaskProxyless", {
					websiteURL,
					websiteKey,
					action: challenge.action,
					data: challenge.cData,
					pagedata: challenge.chlPageData,
					userAgent: this.resolveUserAgent(),
				});
			case "funcaptcha":
				return withProxy("FunCaptchaTaskProxyless", {
					websiteURL,
					websitePublicKey: challenge.publicKey,
					funcaptchaApiJSSubdomain: challenge.apiSubdomain,
					data: challenge.data,
					userAgent: this.resolveUserAgent(),
				});
			case "geetest-v3":
				return withProxy("GeeTestTaskProxyless", {
					websiteURL,
					gt: challenge.gt,
					challenge: challenge.challenge,
					geetestApiServerSubdomain: challenge.apiServer,
					userAgent: this.resolveUserAgent(),
				});
			case "geetest-v4":
				return withProxy("GeeTestTaskProxyless", {
					websiteURL,
					version: 4,
					initParameters: { captcha_id: challenge.captchaId },
					userAgent: this.resolveUserAgent(),
				});
			case "capy":
				return withProxy("CapyTaskProxyless", {
					websiteURL,
					websiteKey,
					userAgent: this.resolveUserAgent(),
				});
			case "lemin":
				return withProxy("LeminTaskProxyless", {
					websiteURL,
					captchaId: challenge.captchaId,
					divId: challenge.divId,
					userAgent: this.resolveUserAgent(),
				});
			case "cybersiara":
				return withProxy("AntiCyberSiAraTaskProxyless", {
					websiteURL,
					SlideMasterUrlId: challenge.slideMasterUrlId,
					userAgent: this.resolveUserAgent(),
				});
			case "amazon-waf":
				return withProxy("AmazonTaskProxyless", {
					websiteURL,
					websiteKey,
					iv: challenge.iv,
					context: challenge.context,
					jsapiScript: challenge.jsapiScript,
					challengeScript: challenge.challengeScript,
					captchaScript: challenge.captchaScript,
				});
			case "datadome":
				if (!proxy)
					throw new Error(
						"DataDome via 2captcha requires TWOCAPTCHA_PROXY_ADDRESS and TWOCAPTCHA_PROXY_PORT so the worker uses the same proxy/IP family.",
					);
				return {
					type: "DataDomeSliderTask",
					websiteURL,
					captchaUrl: challenge.captchaUrl,
					userAgent: this.resolveUserAgent(),
					...proxy,
				};
			default:
				return null;
		}
	}

	private async solveImageToTextCaptcha(
		challenge: Record<string, unknown>,
	): Promise<{ applied: boolean; solution: Record<string, unknown> }> {
		if (!challenge.selector)
			throw new Error("Image captcha selector was not detected");
		const image = await this.page
			.locator(String(challenge.selector))
			.first()
			.screenshot({ type: "png" });
		const solution = await this.createTwoCaptchaTask({
			type: "ImageToTextTask",
			body: image.toString("base64"),
			comment: challenge.comment || "Solve the captcha text in the image.",
		});
		const text = String(solution.text || "");
		if (text && challenge.inputSelector) {
			await this.page
				.fill(String(challenge.inputSelector), text)
				.catch(async () => {
					await this.page.evaluate(
						({ selector, value }) => {
							const el = document.querySelector(selector) as
								| HTMLInputElement
								| HTMLTextAreaElement
								| null;
							if (!el) return;
							el.value = value;
							el.dispatchEvent(new Event("input", { bubbles: true }));
							el.dispatchEvent(new Event("change", { bubbles: true }));
						},
						{ selector: String(challenge.inputSelector), value: text },
					);
				});
			return { applied: true, solution };
		}
		return { applied: false, solution };
	}

	private async applyCaptchaSolution(
		challenge: Record<string, unknown>,
		solution: Record<string, unknown>,
	): Promise<boolean> {
		if (!this.page) return false;
		if (challenge.kind === "datadome" && solution.cookie) {
			const cookie = parseCookieString(
				String(solution.cookie),
				this.page.url(),
			);
			if (cookie) {
				await this.context.addCookies([cookie]);
				await this.page
					.reload({ waitUntil: "domcontentloaded", timeout: 30000 })
					.catch(() => {});
				return true;
			}
		}

		const token =
			solution.gRecaptchaResponse || solution.token || solution.code;
		if (token) {
			await this.page.evaluate(
				({ kind, token, callbackId, solution }) => {
					const ensureField = (selector, name) => {
						let el = document.querySelector(selector) as
							| HTMLInputElement
							| HTMLTextAreaElement
							| null;
						if (!el) {
							el = document.createElement("textarea");
							el.name = name;
							el.style.display = "none";
							document.body.appendChild(el);
						}
						el.value = token;
						el.dispatchEvent(new Event("input", { bubbles: true }));
						el.dispatchEvent(new Event("change", { bubbles: true }));
					};
					if (kind === "hcaptcha") {
						ensureField(
							'textarea[name="h-captcha-response"], input[name="h-captcha-response"]',
							"h-captcha-response",
						);
						ensureField(
							'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]',
							"g-recaptcha-response",
						);
					} else if (kind === "turnstile") {
						ensureField(
							'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
							"cf-turnstile-response",
						);
						ensureField(
							'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]',
							"g-recaptcha-response",
						);
					} else if (kind === "funcaptcha") {
						ensureField(
							'input[name="fc-token"], textarea[name="fc-token"]',
							"fc-token",
						);
					} else {
						ensureField(
							'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]',
							"g-recaptcha-response",
						);
					}
					const callbacks = window.__octopusCaptcha?.callbacks || {};
					if (callbackId && typeof callbacks[callbackId] === "function")
						callbacks[callbackId](token);
					window.__octopusLastCaptchaSolution = { kind, token, solution };
				},
				{
					kind: challenge.kind,
					token: String(token),
					callbackId: challenge.callbackId,
					solution,
				},
			);
			return true;
		}

		if (
			challenge.kind === "geetest-v3" ||
			challenge.kind === "geetest-v4" ||
			challenge.kind === "amazon-waf" ||
			challenge.kind === "capy" ||
			challenge.kind === "lemin" ||
			challenge.kind === "cybersiara"
		) {
			await this.page.evaluate(
				({ kind, solution }) => {
					window.__octopusLastCaptchaSolution = { kind, solution };
					const fields = {
						geetest_challenge: solution.challenge,
						geetest_validate: solution.validate,
						geetest_seccode: solution.seccode,
						captcha_output: solution.captcha_output,
						pass_token: solution.pass_token,
						lot_number: solution.lot_number,
						gen_time: solution.gen_time,
						captcha_voucher: solution.captcha_voucher,
						existing_token: solution.existing_token,
						captchakey: solution.captchakey,
						challengekey: solution.challengekey,
						answer: solution.answer,
						respKey: solution.respKey,
					};
					for (const [name, value] of Object.entries(fields)) {
						if (!value) continue;
						let el = document.querySelector(
							`[name="${name}"]`,
						) as HTMLInputElement | null;
						if (!el) {
							el = document.createElement("input");
							el.type = "hidden";
							el.name = name;
							document.body.appendChild(el);
						}
						el.value = String(value);
						el.dispatchEvent(new Event("change", { bubbles: true }));
					}
				},
				{ kind: challenge.kind, solution },
			);
			return true;
		}

		return false;
	}

	private async getVerificationState(): Promise<VerificationState> {
		if (!this.page) {
			return {
				blocked: true,
				captchaVisible: false,
				url: "",
				title: "",
				textSample: "browser page unavailable",
				signals: ["browser page unavailable"],
			};
		}

		try {
			return await this.page.evaluate((captchaPattern: string) => {
				const text = (document.body?.innerText || "")
					.replace(/\s+/g, " ")
					.trim();
				const combined = `${document.title} ${text}`;
				const captchaRe = new RegExp(captchaPattern, "i");
				const signals: string[] = [];
				const visible = (el: Element): boolean => {
					const rect = (el as HTMLElement).getBoundingClientRect();
					const style = window.getComputedStyle(el);
					return (
						rect.width > 0 &&
						rect.height > 0 &&
						style.display !== "none" &&
						style.visibility !== "hidden" &&
						style.opacity !== "0"
					);
				};
				const captchaSelectors = [
					'iframe[src*="recaptcha"]',
					'iframe[src*="hcaptcha"]',
					'iframe[src*="captcha"]',
					'iframe[src*="challenge"]',
					".g-recaptcha",
					".h-captcha",
					"[data-sitekey]",
					"[data-captcha-id]",
					"[data-lemin-captcha-id]",
					"[class*=captcha i]",
					"[id*=captcha i]",
				];
				let captchaVisible = false;
				for (const selector of captchaSelectors) {
					try {
						if (Array.from(document.querySelectorAll(selector)).some(visible)) {
							captchaVisible = true;
							signals.push(`visible selector: ${selector}`);
							break;
						}
					} catch {}
				}
				if (captchaRe.test(combined))
					signals.push("challenge text still present");
				const blocked = captchaVisible || captchaRe.test(combined);
				return {
					blocked,
					captchaVisible,
					url: location.href,
					title: document.title,
					textSample: text.slice(0, 700),
					signals,
				};
			}, CAPTCHA_STILL_VISIBLE_RE.source);
		} catch (error) {
			return {
				blocked: true,
				captchaVisible: false,
				url: "",
				title: "",
				textSample: error instanceof Error ? error.message : String(error),
				signals: ["verification state unavailable"],
			};
		}
	}

	private formatVerificationState(state: VerificationState): string {
		return [
			`verifiedClear=${!state.blocked && !state.captchaVisible}`,
			`captchaVisible=${state.captchaVisible}`,
			`url=${state.url}`,
			`title=${state.title}`,
			`signals=${state.signals.join(", ") || "none"}`,
			`textSample=${state.textSample.replace(/\s+/g, " ").slice(0, 300)}`,
		].join("; ");
	}

	private async solveCaptchasOnCurrentPage(
		options: { includeDataDome?: boolean } = {},
	): Promise<Record<string, unknown>> {
		const challenges = await this.detectCaptchaChallenges();
		const result: {
			detected: number;
			solved: number;
			applied: number;
			verified: boolean;
			skipped: Array<Record<string, unknown>>;
			details: Array<Record<string, unknown>>;
			postSolveState?: VerificationState;
		} = {
			detected: challenges.length,
			solved: 0,
			applied: 0,
			verified: challenges.length === 0,
			skipped: [],
			details: [],
		};
		for (const challenge of challenges) {
			if (
				challenge.kind === "datadome" &&
				!options.includeDataDome &&
				!this.getTwoCaptchaProxyConfig()
			) {
				result.skipped.push({
					kind: challenge.kind,
					reason:
						"DataDome needs a configured proxy for 2captcha; fallback browser provider is preferred.",
				});
				continue;
			}
			try {
				let applied = false;
				let solution: Record<string, unknown>;
				if (challenge.kind === "image-to-text") {
					const imageResult = await this.solveImageToTextCaptcha(challenge);
					applied = imageResult.applied;
					solution = imageResult.solution;
				} else {
					const task = this.buildTwoCaptchaTask(challenge);
					if (!task) {
						result.skipped.push({
							kind: challenge.kind,
							reason:
								"No automatic 2captcha task builder for this detected challenge.",
						});
						continue;
					}
					solution = await this.createTwoCaptchaTask(task);
					applied = await this.applyCaptchaSolution(challenge, solution);
				}
				result.solved += 1;
				if (applied) result.applied += 1;
				result.details.push({ kind: challenge.kind, applied });
			} catch (error) {
				result.skipped.push({
					kind: challenge.kind,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (result.applied > 0) {
			await this.page
				.waitForLoadState("networkidle", { timeout: 8000 })
				.catch(() => {});
			await this.page.waitForTimeout(1500).catch(() => {});
			result.postSolveState = await this.getVerificationState();
			result.verified =
				!result.postSolveState.blocked && !result.postSolveState.captchaVisible;
			if (result.verified) await this.saveSessionForCurrentPage();
		} else if (challenges.length > 0) {
			result.postSolveState = await this.getVerificationState();
			result.verified =
				!result.postSolveState.blocked && !result.postSolveState.captchaVisible;
		}
		return result;
	}

	async updateConfig(config: BrowserConfig): Promise<void> {
		const previous = JSON.stringify(this.config);
		this.config = { ...this.config, ...config };
		this.urlSafetyPolicy = new UrlSafetyPolicy(this.config.urlPolicy);
		if (JSON.stringify(this.config) !== previous) {
			await this.close();
		}
	}

	async isAvailable(): Promise<boolean> {
		if (
			this.config.provider === "brightdata" &&
			this.isBrightDataEnabled() &&
			this.getBrightDataWsUrl()
		)
			return true;
		if (this.config.provider === "decodo" && !this.getDecodoProxyConfig()) {
			return false;
		}
		if (this.config.executablePath) {
			try {
				const stats = await fs.promises.stat(this.config.executablePath);
				return stats.isFile();
			} catch {
				return false;
			}
		}
		return false;
	}

	private async autoAcceptCookies(): Promise<void> {
		if (!this.page) return;
		try {
			const keywords = [
				"accept all cookies",
				"accept all",
				"accept cookies",
				"allow all",
				"allow all cookies",
				"agree",
				"agree and continue",
				"okay",
				"ok",
				"got it",
				"i agree",
				"consent",
				"aceptar todo",
				"aceptar todas",
				"aceptar cookies",
				"aceptar",
				"permitir",
				"godkänn alla",
				"godkänn",
				"acceptera alla",
				"acceptera",
				"jag godkänner",
				"alle akzeptieren",
				"akzeptieren",
				"alle cookies akzeptieren",
				"zustimmen",
				"tout accepter",
				"accepter tout",
				"accepter",
				"j'accepte",
				"aceitar tudo",
				"aceitar todos",
				"aceitar",
				"accetta tutto",
				"accetta tutti",
				"accetta",
				"alles accepteren",
				"accepteren",
				"alle cookies accepteren",
				"zaakceptuj wszystkie",
				"akceptuję",
			];

			for (const kw of keywords) {
				try {
					const locators = await this.page
						.getByRole("button", { name: new RegExp(kw, "i") })
						.all();
					for (const loc of locators) {
						if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
							await loc.click({ force: true, timeout: 2000 }).catch(() => {});
							await this.page.waitForTimeout(1000);
							return;
						}
					}
				} catch {
					/* try next keyword */
				}
			}

			await this.page
				.evaluate(() => {
					const consentPatterns =
						/accept|agree|consent|godkänn|akzeptieren|accepter|aceitar|accetta|accepteren|aceptar|permitir|allow|okay|got it/i;
					const candidates = Array.from(
						document.querySelectorAll(
							'button, a, [role="button"], input[type="submit"]',
						),
					);
					for (const el of candidates) {
						const text = (el.textContent || "").trim();
						const rect = (el as HTMLElement).getBoundingClientRect();
						if (
							text.length > 2 &&
							text.length < 50 &&
							rect.width > 0 &&
							rect.height > 0 &&
							consentPatterns.test(text)
						) {
							(el as HTMLElement).click();
							return;
						}
					}
				})
				.catch(() => {});
			await this.page.waitForTimeout(500);

			await this.dismissAllPopups();
		} catch (e) {
			// Ignore error — cookies might not exist on this page
		}
	}

	private async connectWithTimeout(
		url: string,
		timeoutMs = 30000,
	): Promise<unknown> {
		return this.chromiumController().connectOverCDP(url, {
			timeout: timeoutMs,
		});
	}

	private isBrightDataEnabled(): boolean {
		return this.config.brightDataEnabled !== false;
	}

	private getBrightDataWsUrl(): string | undefined {
		if (!this.isBrightDataEnabled()) return undefined;
		for (const value of [
			this.config.brightDataWsUrl,
			process.env.BRIGHTDATA_WS_URL,
		]) {
			if (isValidBrowserWsUrl(value)) return value.trim();
		}
		return undefined;
	}

	private isDecodoEnabled(): boolean {
		return this.config.decodoEnabled !== false;
	}

	private getDecodoProxyConfig():
		| {
				server: string;
				username?: string;
				password?: string;
				host: string;
				port: number;
				protocol: string;
		  }
		| undefined {
		if (!this.isDecodoEnabled()) return undefined;
		const explicitUrl =
			this.config.decodoProxyUrl || process.env.DECODO_PROXY_URL;
		const server =
			this.config.decodoProxyUrl || process.env.DECODO_PROXY_SERVER;
		const rawUsername =
			this.config.decodoProxyUsername ||
			process.env.DECODO_PROXY_USERNAME ||
			process.env.DECODO_PROXY_USER;
		const password =
			this.config.decodoProxyPassword ||
			process.env.DECODO_PROXY_PASSWORD ||
			process.env.DECODO_PROXY_PASS;
		if (!explicitUrl && !server && !rawUsername && !password) return undefined;
		if (isValidProxyUrl(explicitUrl)) {
			const parsed = parseProxyUrl(explicitUrl.trim());
			if (parsed) return parsed;
		}

		const username = buildDecodoUsername(rawUsername, {
			country:
				this.config.decodoProxyCountry || process.env.DECODO_PROXY_COUNTRY,
			city: this.config.decodoProxyCity || process.env.DECODO_PROXY_CITY,
			state: this.config.decodoProxyState || process.env.DECODO_PROXY_STATE,
			zip: this.config.decodoProxyZip || process.env.DECODO_PROXY_ZIP,
			session:
				this.config.decodoProxySession || process.env.DECODO_PROXY_SESSION,
			sessionDuration:
				this.config.decodoProxySessionDuration ||
				process.env.DECODO_PROXY_SESSION_DURATION,
		});
		if ((rawUsername || password) && (!username || !password)) return undefined;
		const protocol = (
			process.env.DECODO_PROXY_PROTOCOL || "http"
		).toLowerCase();
		const serverUrl = isValidProxyUrl(server)
			? server.trim()
			: `${protocol}://${server || "gate.decodo.com:7000"}`;
		const parsed = parseProxyUrl(serverUrl);
		if (!parsed) return undefined;
		return {
			...parsed,
			username: parsed.username || username,
			password: parsed.password || password,
		};
	}

	private getDecodoTwoCaptchaProxyConfig(): Record<string, unknown> | null {
		const proxy = this.getDecodoProxyConfig();
		if (!proxy?.username || !proxy.password) return null;
		return {
			proxyType: proxy.protocol === "socks5" ? "SOCKS5" : "HTTP",
			proxyAddress: proxy.host,
			proxyPort: proxy.port,
			proxyLogin: proxy.username,
			proxyPassword: proxy.password,
		};
	}

	private async setupResourceBlocking(): Promise<void> {
		if (!this.context) return;
		const blockResources = this.config.blockResources || ["font"];
		const blockTrackers = this.config.blockTrackerDomains !== false;
		if (blockResources.length === 0 && !blockTrackers) return;

		const blockedTypes = new Set(blockResources);
		await this.context.route("**/*", async (route, request) => {
			if (blockTrackers) {
				const url = request.url().toLowerCase();
				for (const domain of TRACKER_DOMAINS) {
					if (url.includes(domain)) {
						await route.abort();
						return;
					}
				}
			}
			if (blockedTypes.has(request.resourceType())) {
				await route.abort();
				return;
			}
			await route.continue();
		});
	}

	private randomDelay(minMs = 300, maxMs = 1500): Promise<void> {
		const ms = minMs + Math.random() * (maxMs - minMs);
		return sleep(ms);
	}

	private async humanClick(selector: string): Promise<void> {
		if (!this.page) throw new Error("No page available");
		const useHuman = this.config.humanBehavior !== false;

		if (useHuman) {
			try {
				const element = this.page.locator(selector).first();
				const box = await element.boundingBox();
				if (box) {
					const x = box.x + box.width * (0.2 + Math.random() * 0.6);
					const y = box.y + box.height * (0.2 + Math.random() * 0.6);
					await this.humanMouseMove(x, y);
					await this.randomDelay(50, 200);
					await this.page.mouse.click(x, y);
					return;
				}
			} catch {}
		}

		try {
			await this.page.locator(selector).first().click({ timeout: 5000 });
		} catch {
			try {
				await this.page
					.locator(selector)
					.first()
					.click({ force: true, timeout: 5000 });
			} catch {
				await this.page.evaluate((sel: string) => {
					const el = document.querySelector(sel) as HTMLElement;
					if (el) el.click();
					else throw new Error("Element not found in DOM");
				}, selector);
			}
		}
	}

	private async humanMouseMove(
		targetX: number,
		targetY: number,
	): Promise<void> {
		if (!this.page) return;
		const from = this.humanSim.mousePosition;
		// Use last known position or random start
		const startX =
			from.x || Math.random() * (this.fingerprint?.viewport?.width || 800);
		const startY =
			from.y || Math.random() * (this.fingerprint?.viewport?.height || 600);
		const path = this.humanSim.generateMousePath(
			startX,
			startY,
			targetX,
			targetY,
		);
		for (const point of path) {
			await this.page.mouse.move(point.x, point.y);
			await sleep(point.delayMs);
		}
	}

	private async humanType(selector: string, text: string): Promise<void> {
		if (!this.page) throw new Error("No page available");
		const useHuman = this.config.humanBehavior !== false;

		await this.page
			.evaluate((sel: string) => {
				const el = document.querySelector(sel) as HTMLElement;
				if (el) el.focus();
			}, selector)
			.catch(() => {});

		if (useHuman && text.length <= 200) {
			const loc = this.page.locator(selector).first();
			await loc.fill("", { force: true, timeout: 3000 }).catch(() => {});
			const sequence = this.humanSim.generateTypingSequence(text);
			for (const step of sequence) {
				if (step.char === "Backspace") {
					await this.page.keyboard.press("Backspace");
				} else {
					await this.page.keyboard.type(step.char, { delay: 0 });
				}
				await sleep(step.delayMs);
			}
		} else {
			try {
				await this.page
					.locator(selector)
					.first()
					.fill(text, { force: true, timeout: 5000 });
			} catch {
				await this.page.evaluate(
					(sel: string, val: string) => {
						const el = document.querySelector(sel) as
							| HTMLInputElement
							| HTMLTextAreaElement;
						if (el) {
							el.value = val;
							el.dispatchEvent(new Event("input", { bubbles: true }));
							el.dispatchEvent(new Event("change", { bubbles: true }));
						} else {
							throw new Error("Element not found in DOM");
						}
					},
					selector,
					text,
				);
			}
		}
	}

	private async dismissAllPopups(): Promise<number> {
		if (!this.page || this.config.autoDismissPopups === false) return 0;
		let dismissed = 0;

		try {
			const allSelectors = [
				...POPUP_COOKIE_SELECTORS,
				...POPUP_CLOSE_SELECTORS,
			];
			for (const selector of allSelectors) {
				try {
					const element = this.page.locator(selector).first;
					if (await element.isVisible({ timeout: 300 }).catch(() => false)) {
						await element.click({ force: true, timeout: 2000 }).catch(() => {});
						dismissed++;
						await this.randomDelay(300, 600);
					}
				} catch {}
			}

			if (dismissed > 0) {
				console.log(
					`[BrowserTool] Auto-dismissed ${dismissed} popup(s)/banner(s)`,
				);
			} else {
				await this.page.keyboard.press("Escape").catch(() => {});
			}
		} catch {}

		return dismissed;
	}

	private async setupDialogHandlers(): Promise<void> {
		if (!this.page || !this.context) return;
		this.page.on("dialog", async (dialog: unknown) => {
			console.log(
				`[BrowserTool] Auto-dismissing ${dialog.type()} dialog: ${dialog.message()?.slice(0, 100)}`,
			);
			await dialog.dismiss().catch(() => {});
		});
		this.context.on("page", async (newPage: unknown) => {
			console.log(
				`[BrowserTool] Auto-closing unexpected new tab: ${newPage.url()?.slice(0, 80)}`,
			);
			await sleep(1000);
			await newPage.close().catch(() => {});
		});
	}

	private resolveChromiumSandboxEnabled(): boolean {
		if (typeof this.config.chromiumSandbox === "boolean")
			return this.config.chromiumSandbox;
		const envValue = process.env.OCTOPUS_CHROMIUM_SANDBOX?.trim().toLowerCase();
		if (envValue === "true" || envValue === "1" || envValue === "yes")
			return true;
		if (envValue === "false" || envValue === "0" || envValue === "no")
			return false;

		// Chrome on Linux commonly fails under root/containerized runtimes unless
		// --no-sandbox is used. On Windows/macOS and Linux non-root, keep the
		// sandbox enabled so Chrome does not show the unsupported flag banner.
		if (
			process.platform === "linux" &&
			typeof process.getuid === "function" &&
			process.getuid() === 0
		)
			return false;
		return true;
	}

	private shouldRetryWithoutChromiumSandbox(error: unknown): boolean {
		if (process.platform !== "linux") return false;
		const message = error instanceof Error ? error.message : String(error);
		return /sandbox|setuid|namespace|zygote|No usable sandbox|Operation not permitted/i.test(
			message,
		);
	}

	private async launchEmbeddedBrowser(
		provider: "embedded" | "decodo" = "embedded",
	): Promise<void> {
		if (!this.config.executablePath) {
			throw new Error("No embedded browser executable path is configured");
		}
		const fp = this.ensureFingerprint();
		const decodoProxy =
			provider === "decodo" ? this.getDecodoProxyConfig() : undefined;
		if (provider === "decodo" && !decodoProxy) {
			throw new Error(
				"Decodo proxy is not configured. Set DECODO_PROXY_URL or DECODO_PROXY_USERNAME/DECODO_PROXY_PASSWORD.",
			);
		}

		// Persistent browser profile — cookies, localStorage, IndexedDB all persist automatically
		const userDataDir = this.config.userDataDir
			? resolve(this.config.userDataDir)
			: join(homedir(), ".octopus", "browser-profile", provider);
		await fs.promises.mkdir(userDataDir, { recursive: true }).catch(() => {});
		// Clear stale profile locks so Chrome doesn't redirect to a ghost
		// "existing session" (which makes Playwright lose control and the page
		// fall back to about:blank on every navigation).
		for (const lockName of [
			"lockfile",
			"SingletonLock",
			"SingletonSocket",
			"SingletonCookie",
		]) {
			await fs.promises
				.rm(join(userDataDir, lockName), { force: true })
				.catch(() => {});
		}

		const chromiumSandbox = this.resolveChromiumSandboxEnabled();
		console.log(
			`[BrowserTool] Launching ${provider === "decodo" ? "Decodo proxied" : "embedded"} persistent browser (profile: ${userDataDir}) viewport: ${fp.viewport.width}x${fp.viewport.height}; chromiumSandbox=${chromiumSandbox}; nativeFingerprint=${this.config.nativeFingerprint !== false}; stealth=${this.config.stealth === true}`,
		);

		const contextOptions = this.buildBrowserContextOptions();
		const launchArgs =
			this.config.nativeFingerprint !== false
				? [
						"--disable-dev-shm-usage",
						`--window-size=${fp.viewport.width},${fp.viewport.height}`,
					]
				: [
						"--disable-dev-shm-usage",
						"--disable-infobars",
						"--disable-extensions",
						`--window-size=${fp.viewport.width},${fp.viewport.height}`,
					];
		const launchOptions = {
			executablePath: this.config.executablePath,
			headless: this.config.headless ?? false,
			chromiumSandbox,
			ignoreDefaultArgs: ["--enable-automation"],
			...(decodoProxy
				? {
						proxy: {
							server: decodoProxy.server,
							username: decodoProxy.username,
							password: decodoProxy.password,
						},
					}
				: {}),
			args: launchArgs,
			...contextOptions,
		};
		try {
			this.context = await this.chromiumController().launchPersistentContext(
				userDataDir,
				launchOptions,
			);
		} catch (error) {
			if (!chromiumSandbox || !this.shouldRetryWithoutChromiumSandbox(error))
				throw error;
			console.warn(
				`[BrowserTool] Chromium sandbox failed on Linux; retrying without sandbox: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.context = await this.chromiumController().launchPersistentContext(
				userDataDir,
				{
					...launchOptions,
					chromiumSandbox: false,
				},
			);
		}

		this.browser = this.context.browser() || null;

		await this.addBrowserInitScripts();
		await this.setupResourceBlocking();
		// Persistent context may have existing pages; reuse or create
		const pages = this.context.pages();
		this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
		await this.page.setViewportSize(fp.viewport);
		this.setupNetworkDiagnostics();
		await this.setupDialogHandlers();
		this.activeProvider = provider;
	}

	private async getPageStateSummary(): Promise<string> {
		if (!this.page) return "(browser page unavailable)";
		try {
			const state = await this.page.evaluate(() => {
				const text = (document.body?.innerText || "")
					.replace(/\s+/g, " ")
					.trim();
				const listingLinks = Array.from(
					document.querySelectorAll('a[href*="/listing/"]'),
				)
					.map((anchor: unknown) => {
						const href = anchor.href || anchor.getAttribute("href") || "";
						const id = href.match(/\/listing\/(\d+)/)?.[1] || null;
						const img = anchor.querySelector("img");
						const title = (
							anchor.innerText ||
							anchor.getAttribute("aria-label") ||
							img?.alt ||
							""
						)
							.replace(/\s+/g, " ")
							.trim();
						const rect = anchor.getBoundingClientRect();
						return {
							title: title.slice(0, 120),
							href,
							listingId: id,
							visible: rect.width > 0 && rect.height > 0,
						};
					})
					.filter(
						(item: unknown, index, arr: unknown[]) =>
							item.listingId &&
							arr.findIndex((other) => other.listingId === item.listingId) ===
								index,
					)
					.slice(0, 8);
				const inputs = Array.from(
					document.querySelectorAll("input, textarea, select"),
				)
					.map((el: unknown) => ({
						tag: el.tagName.toLowerCase(),
						type: el.type || "",
						placeholder: el.placeholder || "",
						value: String(el.value || "").slice(0, 80),
						name: el.name || "",
					}))
					.slice(0, 8);
				const buttons = Array.from(
					document.querySelectorAll('button, [role="button"], a'),
				)
					.map((el: unknown) => {
						const rect = el.getBoundingClientRect();
						return {
							text: (el.innerText || el.getAttribute("aria-label") || "")
								.replace(/\s+/g, " ")
								.trim()
								.slice(0, 100),
							tag: el.tagName.toLowerCase(),
							href: el.href || "",
							visible: rect.width > 0 && rect.height > 0,
						};
					})
					.filter((item: unknown) => item.visible && item.text)
					.slice(0, 12);
				const imageCount = Array.from(document.images).filter((img: unknown) =>
					/etsystatic|jpg|jpeg|png|webp/i.test(img.currentSrc || img.src || ""),
				).length;
				const pageKind =
					/datadome|captcha|pardon our interruption|access denied|verify you are human/i.test(
						`${document.title} ${text}`,
					)
						? "blocked"
						: /\/listing\/\d+/.test(location.href)
							? "product"
							: /\/search/.test(location.href) || listingLinks.length > 0
								? "search"
								: "unknown";
				return {
					url: location.href,
					title: document.title,
					pageKind,
					textSample: text.slice(0, 900),
					listingCount: listingLinks.length,
					imageCount,
					inputs,
					buttons,
					listings: listingLinks,
				};
			});
			return JSON.stringify(state, null, 2).slice(0, 6000);
		} catch (error) {
			return `(page state unavailable: ${error instanceof Error ? error.message : String(error)})`;
		}
	}

	private async getAccessibilityTree(): Promise<string> {
		if (!this.page) return "(browser page unavailable)";
		try {
			const snapshot = await this.page.accessibility.snapshot();
			if (!snapshot) return "(empty accessibility tree)";

			const lines: string[] = [];
			let uidCounter = 0;
			const uidMap = new Map<unknown, string>();

			const walk = (node: unknown, depth: number): void => {
				if (!node) return;
				if (lines.length >= A11Y_TREE_MAX_NODES) return;

				const role = node.role || "unknown";
				const name = node.name || "";
				const value = node.value || "";
				const disabled = node.disabled ? " [disabled]" : "";
				const checked =
					node.checked === true
						? " [checked]"
						: node.checked === "mixed"
							? " [mixed]"
							: "";
				const expanded =
					node.expanded === true
						? " [expanded]"
						: node.expanded === false
							? " [collapsed]"
							: "";
				const required = node.required ? " [required]" : "";
				const level = node.level ? ` level=${node.level}` : "";
				const description = node.description
					? ` description="${node.description}"`
					: "";

				const uid = `uid-${uidCounter}`;
				uidCounter++;
				uidMap.set(node, uid);

				const indent = "  ".repeat(depth);
				let line = `${indent}[${uid}] ${role}`;

				if (name) {
					const displayName =
						name.length > A11Y_TREE_MAX_TEXT_LENGTH
							? `${name.slice(0, A11Y_TREE_MAX_TEXT_LENGTH)}…`
							: name;
					line += ` name="${displayName}"`;
				}
				if (value) {
					const displayValue =
						value.length > A11Y_TREE_MAX_TEXT_LENGTH
							? `${value.slice(0, A11Y_TREE_MAX_TEXT_LENGTH)}…`
							: value;
					line += ` value="${displayValue}"`;
				}
				if (level) line += level;
				if (description) line += description;
				if (disabled) line += disabled;
				if (checked) line += checked;
				if (expanded) line += expanded;
				if (required) line += required;

				lines.push(line);

				if (node.children) {
					for (const child of node.children) {
						walk(child, depth + 1);
					}
				}
			};

			walk(snapshot, 0);
			return lines.join("\n");
		} catch (error) {
			return `(accessibility tree unavailable: ${error instanceof Error ? error.message : String(error)})`;
		}
	}

	private async buildSnapshotWithUidMap(): Promise<{
		output: string;
		uidToSelector: Map<string, string>;
	}> {
		if (!this.page) {
			return { output: "(browser page unavailable)", uidToSelector: new Map() };
		}

		const uidToSelector = new Map<string, string>();

		const result = await this.page.evaluate(() => {
			interface A11yNode {
				role: string;
				name: string;
				value: string;
				tag: string;
				selector: string;
				href: string;
				placeholder: string;
				inputType: string;
				disabled: boolean;
				required: boolean;
				checked: boolean | string;
				children: A11yNode[];
			}

			const nodes: Array<{ uid: string; node: A11yNode }> = [];
			let uidCounter = 0;

			const getSelector = (el: Element): string => {
				if (el.id) return `#${CSS.escape(el.id)}`;
				const tag = el.tagName.toLowerCase();
				if (el.className && typeof el.className === "string") {
					const classes = el.className
						.split(" ")
						.filter((c: string) => c.trim().length > 0)
						.slice(0, 2);
					if (classes.length > 0) {
						const sel = `${tag}.${classes.map((c: string) => CSS.escape(c)).join(".")}`;
						if (document.querySelectorAll(sel).length === 1) return sel;
					}
				}
				let path = "";
				let current: Element | null = el;
				while (current && current.tagName !== "HTML") {
					let index = 1;
					let sibling = current.previousElementSibling;
					while (sibling) {
						if (sibling.tagName === current.tagName) index++;
						sibling = sibling.previousElementSibling;
					}
					path = `${current.tagName.toLowerCase()}:nth-of-type(${index}) > ${path}`;
					current = current.parentElement;
				}
				return path.replace(/ > $/, "").trim();
			};

			const isVisible = (el: Element): boolean => {
				const style = window.getComputedStyle(el);
				if (
					style.display === "none" ||
					style.visibility === "hidden" ||
					style.opacity === "0"
				)
					return false;
				const rect = el.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			};

			const getRole = (el: Element): string => {
				const explicitRole = el.getAttribute("role");
				if (explicitRole) return explicitRole;
				const tag = el.tagName.toLowerCase();
				const roleMap: Record<string, string> = {
					a: "link",
					button: "button",
					input:
						(el as HTMLInputElement).type === "checkbox"
							? "checkbox"
							: (el as HTMLInputElement).type === "radio"
								? "radio"
								: (el as HTMLInputElement).type === "submit"
									? "button"
									: (el as HTMLInputElement).type === "range"
										? "slider"
										: "textbox",
					textarea: "textbox",
					select: "combobox",
					option: "option",
					details: "group",
					summary: "button",
					dialog: "dialog",
					table: "table",
					tr: "row",
					td: "cell",
					th: "columnheader",
					thead: "rowgroup",
					tbody: "rowgroup",
					ul: "list",
					ol: "list",
					li: "listitem",
					nav: "navigation",
					main: "main",
					header: "banner",
					footer: "contentinfo",
					aside: "complementary",
					section: "region",
					article: "article",
					form: "form",
					fieldset: "group",
					h1: "heading",
					h2: "heading",
					h3: "heading",
					h4: "heading",
					h5: "heading",
					h6: "heading",
					img: "img",
					svg: "img",
					progress: "progressbar",
					meter: "meter",
				};
				return roleMap[tag] || "generic";
			};

			const getName = (el: Element): string => {
				const ariaLabel = el.getAttribute("aria-label");
				if (ariaLabel) return ariaLabel;
				const ariaLabelledBy = el.getAttribute("aria-labelledby");
				if (ariaLabelledBy) {
					const labelEl = document.getElementById(ariaLabelledBy);
					if (labelEl) return (labelEl.textContent || "").trim();
				}
				if (
					el instanceof HTMLInputElement ||
					el instanceof HTMLTextAreaElement ||
					el instanceof HTMLSelectElement
				) {
					if (
						el.type === "submit" ||
						el.type === "button" ||
						el.type === "reset"
					)
						return el.value || "";
					const labels = (el as { labels?: unknown[] }).labels;
					if (labels && labels.length > 0)
						return Array.from(labels)
							.map((l: unknown) => (l.textContent || "").trim())
							.join(" ");
					const placeholder = el.placeholder;
					if (placeholder) return placeholder;
					const name = el.name;
					if (name) return name;
				}
				const tag = el.tagName.toLowerCase();
				if (tag === "img") return el.getAttribute("alt") || "";
				if (tag === "a") {
					const text = (el.textContent || "").trim();
					if (text) return text;
					return el.getAttribute("title") || "";
				}
				if (tag === "button")
					return (
						(el.textContent || "").trim() || el.getAttribute("title") || ""
					);
				const text = (el.textContent || "").trim();
				if (text && text.length < 200) return text;
				return el.getAttribute("title") || "";
			};

			const walk = (el: Element): void => {
				if (nodes.length >= 200) return;
				if (!isVisible(el)) return;

				const tag = el.tagName.toLowerCase();
				const skipTags = new Set([
					"script",
					"style",
					"noscript",
					"meta",
					"link",
					"head",
					"br",
					"hr",
					"wbr",
				]);
				if (skipTags.has(tag)) return;

				const role = getRole(el);
				const name = getName(el);

				const isLeafOrInteractable =
					[
						"link",
						"button",
						"textbox",
						"checkbox",
						"radio",
						"combobox",
						"slider",
						"progressbar",
						"meter",
						"option",
						"switch",
						"searchbox",
						"spinbutton",
						"heading",
						"dialog",
						"alert",
						"alertdialog",
						"status",
						"img",
					].includes(role) ||
					el.getAttribute("role") !== null ||
					el.getAttribute("tabindex") !== null ||
					el instanceof HTMLInputElement ||
					el instanceof HTMLButtonElement ||
					el instanceof HTMLSelectElement ||
					el instanceof HTMLTextAreaElement ||
					el instanceof HTMLAnchorElement ||
					(el as HTMLElement).onclick !== null;

				const uid = `uid-${uidCounter}`;
				uidCounter++;

				const node: A11yNode = {
					role,
					name: name.slice(0, 300),
					value: "",
					tag,
					selector: getSelector(el),
					href: el instanceof HTMLAnchorElement ? el.href : "",
					placeholder:
						el instanceof HTMLInputElement
							? el.placeholder || ""
							: el instanceof HTMLTextAreaElement
								? el.placeholder || ""
								: "",
					inputType: el instanceof HTMLInputElement ? el.type : "",
					disabled: (el as HTMLInputElement).disabled || false,
					required: (el as HTMLInputElement).required || false,
					checked: (el as HTMLInputElement).checked ?? "",
					children: [],
				};

				if (
					el instanceof HTMLInputElement ||
					el instanceof HTMLTextAreaElement
				) {
					node.value = (el.value || "").slice(0, 300);
				} else if (el instanceof HTMLSelectElement) {
					node.value = el.value || "";
				}

				nodes.push({ uid, node });

				if (!isLeafOrInteractable && el.children) {
					for (const child of Array.from(el.children)) {
						walk(child);
					}
				} else if (
					isLeafOrInteractable &&
					role !== "link" &&
					role !== "button" &&
					role !== "heading" &&
					role !== "img" &&
					el.children
				) {
					const hasTextContent =
						(el.textContent || "").trim().length > 0 &&
						el.childNodes.length === 1 &&
						el.childNodes[0].nodeType === Node.TEXT_NODE;
					if (!hasTextContent && el.children.length > 0) {
						for (const child of Array.from(el.children)) {
							walk(child);
						}
					}
				}
			};

			walk(document.body || document.documentElement);
			return nodes;
		});

		const lines: string[] = [];
		for (const { uid, node } of result) {
			uidToSelector.set(uid, node.selector);
			let line = `[${uid}] ${node.role}`;
			if (node.name) line += ` name="${node.name}"`;
			if (node.value) line += ` value="${node.value}"`;
			if (node.inputType && node.role === "textbox")
				line += ` type="${node.inputType}"`;
			if (node.placeholder && !node.name)
				line += ` placeholder="${node.placeholder}"`;
			if (node.href && node.role === "link")
				line += ` href="${node.href.slice(0, 200)}"`;
			if (node.disabled) line += " [disabled]";
			if (node.required) line += " [required]";
			if (node.checked === true) line += " [checked]";
			if (node.checked === "mixed") line += " [mixed]";
			lines.push(line);
		}

		const title = await this.page.title().catch(() => "");
		const url = this.page.url();
		const snapshotId = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const output = `Snapshot ID: ${snapshotId}\nURL: ${url}\nTitle: ${title}\n${lines.join("\n")}`;
		this.lastSnapshot = {
			id: snapshotId,
			url,
			createdAt: Date.now(),
			output,
			uidToSelector,
		};
		return { output, uidToSelector, snapshotId };
	}

	private async getUidSelector(uid: string): Promise<{
		selector?: string;
		snapshotOutput: string;
		fromCache: boolean;
	}> {
		const currentUrl = this.page?.url?.() || "";
		const cached = this.lastSnapshot;
		if (
			cached &&
			cached.url === currentUrl &&
			Date.now() - cached.createdAt < 60_000
		) {
			return {
				selector: cached.uidToSelector.get(uid),
				snapshotOutput: cached.output,
				fromCache: true,
			};
		}
		const { output, uidToSelector } = await this.buildSnapshotWithUidMap();
		return {
			selector: uidToSelector.get(uid),
			snapshotOutput: output,
			fromCache: false,
		};
	}

	private async migrateToProvider(
		provider: BrowserProvider,
		url?: string,
	): Promise<void> {
		if (provider === "brightdata" && !this.getBrightDataWsUrl()) {
			throw new Error(
				this.isBrightDataEnabled()
					? "BRIGHTDATA_WS_URL is not configured"
					: "Bright Data is disabled in browser configuration",
			);
		}
		if (
			(provider === "embedded" || provider === "decodo") &&
			!this.config.executablePath
		) {
			throw new Error("No embedded browser executable path is configured");
		}
		if (provider === "decodo" && !this.getDecodoProxyConfig()) {
			throw new Error(
				this.isDecodoEnabled()
					? "Decodo proxy is not configured"
					: "Decodo is disabled in browser configuration",
			);
		}

		const currentUrl = url || this.page?.url?.();
		const oldProvider = this.config.provider;
		await this.close();
		this.config.provider = provider;
		try {
			await this.init();
		} finally {
			this.config.provider = oldProvider;
		}

		if (currentUrl && currentUrl !== "about:blank") {
			await this.gotoWithSession(currentUrl, {
				waitUntil: "networkidle",
				timeout: 30000,
			}).catch(() => {});
		}
	}

	private getConfiguredFallbackProvider(): BrowserProvider {
		return this.config.blockFallbackProvider ?? "decodo";
	}

	private getFallbackAvailability(provider: BrowserProvider): {
		available: boolean;
		reason?: string;
	} {
		if (provider === "brightdata") {
			if (!this.isBrightDataEnabled())
				return { available: false, reason: "Bright Data is disabled" };
			if (!this.getBrightDataWsUrl())
				return {
					available: false,
					reason: "BRIGHTDATA_WS_URL is not configured",
				};
			return { available: true };
		}
		if (provider === "decodo") {
			if (!this.isDecodoEnabled())
				return { available: false, reason: "Decodo is disabled" };
			if (!this.config.executablePath)
				return {
					available: false,
					reason: "No embedded browser executable path is configured",
				};
			if (!this.getDecodoProxyConfig())
				return { available: false, reason: "Decodo proxy is not configured" };
			return { available: true };
		}

		if (!this.config.executablePath)
			return {
				available: false,
				reason: "No embedded browser executable path is configured",
			};
		return { available: true };
	}

	private getProviderLabel(provider: BrowserProvider): string {
		if (provider === "brightdata") return "Bright Data";
		if (provider === "decodo") return "Decodo residential proxy";
		return "embedded browser";
	}

	private getLocalMediaPath(filename: string): string {
		return join(homedir(), ".octopus", "media", filename);
	}

	private buildScreenshotOutput(
		screenshot: Buffer,
		mediaInfo: { url: string; filename: string },
		context: ToolContext,
		reason: string,
	): string {
		const localPath = this.getLocalMediaPath(mediaInfo.filename);
		const lines = [
			`${reason} Screenshot saved: ![Screenshot](${mediaInfo.url})`,
			`Local media path (INTERNAL — only for vision analysis; do NOT show this raw filesystem path to the user. To display the screenshot to the user, use the markdown image URL above, which renders inline): ${JSON.stringify(localPath)}`,
		];

		if (context.agent?.usesZaiVisionToolForImages) {
			lines.push(
				"[ZAI VISION REQUIRED] Analyze this screenshot with a Z.AI Vision MCP tool before deciding the next browser action. Use the local path above with the parameter name exposed by the available vision tool schema.",
			);
			return lines.join("\n");
		}

		lines.push(
			"The screenshot above is attached to your context as an image — inspect it visually to judge the page (layout, broken images, overflow, contrast, responsiveness) before deciding the next action. If you spot a flaw, fix the source and re-screenshot to confirm.",
		);
		return lines.join("\n");
	}

	private extractMediaUrlFromOutput(output: string): string | null {
		const match = output.match(/\/api\/media\/file\/[^\s)\]]+/);
		return match ? match[0] : null;
	}

	private async captureScreenshotForAnalysis(
		context: ToolContext,
		description: string,
		reason: string,
		options: Record<string, unknown> = {},
	): Promise<string> {
		const screenshot = await this.page.screenshot({
			fullPage: options.fullPage === true,
			type: "png",
		});
		const mediaInfo = await context.media.save(
			screenshot,
			"image/png",
			description,
		);
		return this.buildScreenshotOutput(screenshot, mediaInfo, context, reason);
	}

	async init(): Promise<void> {
		if (this.browser && this.page) {
			try {
				if (this.browser.isConnected() && !this.page.isClosed()) {
					return;
				}
			} catch (e) {
				// Proceed to reset
			}

			try {
				await this.close();
			} catch (e) {}

			this.browser = null;
			this.context = null;
			this.page = null;
		}

		try {
			if (
				this.config.provider === "brightdata" &&
				!this.isBrightDataEnabled()
			) {
				throw new Error("Bright Data is disabled in browser configuration");
			}
			if (this.config.provider === "decodo" && !this.isDecodoEnabled()) {
				throw new Error("Decodo is disabled in browser configuration");
			}
			const wsUrl = this.getBrightDataWsUrl();
			const useBrightData =
				this.config.provider === "brightdata" ||
				(this.config.provider === "auto" &&
					!this.config.executablePath &&
					wsUrl);

			if (this.config.provider === "decodo") {
				await this.launchEmbeddedBrowser("decodo");
			} else if (useBrightData && wsUrl) {
				console.log(
					"Connecting to Bright Data Scraping Browser via Playwright...",
				);

				// Try connecting with a 30s timeout; retry once if it fails
				let lastBrightDataError: unknown = null;
				for (let attempt = 1; attempt <= 2; attempt++) {
					try {
						this.browser = await this.connectWithTimeout(wsUrl, 30000);
						this.activeProvider = "brightdata";
						console.log(
							`Bright Data connected successfully on attempt ${attempt}.`,
						);
						lastBrightDataError = null;
						break;
					} catch (e) {
						lastBrightDataError = e;
						console.log(
							`Bright Data connection attempt ${attempt} failed: ${e instanceof Error ? e.message : e}`,
						);
						await new Promise((r) => setTimeout(r, 2000)); // Wait 2s before retry
					}
				}
				if (!this.browser && lastBrightDataError) {
					if (this.config.executablePath) {
						console.log(
							"Bright Data unavailable; falling back to embedded browser.",
						);
						await this.launchEmbeddedBrowser();
					} else {
						throw lastBrightDataError;
					}
				}

				if (!this.context || !this.page) {
					this.context = this.browser.contexts()[0];
					if (!this.context) {
						const fp = this.ensureFingerprint();
						console.log(
							`[BrowserTool] Creating new Bright Data context with UA: ${fp.userAgent.slice(0, 60)}... viewport: ${fp.viewport.width}x${fp.viewport.height}`,
						);
						this.context = await this.browser.newContext(
							this.buildBrowserContextOptions(),
						);
						await this.addBrowserInitScripts();
						await this.setupResourceBlocking();
					}
					this.page = this.context.pages()[0];
					if (!this.page) {
						this.page = await this.context.newPage();
					}
					this.setupNetworkDiagnostics();
					await this.setupDialogHandlers();
				}
			} else if (this.config.executablePath) {
				await this.launchEmbeddedBrowser("embedded");
			} else {
				throw new Error(
					"No browser provider available (no executable path and no Bright Data URL)",
				);
			}

			this.page.setDefaultNavigationTimeout(60000);
			this.page.setDefaultTimeout(15000);
			// Capture the browser's real UA once the page exists (used by the
			// 2captcha solver). On the default Patchright path we don't inject a
			// UA, so this is the source of truth.
			try {
				this.liveUserAgent = await this.page.evaluate(
					() => navigator.userAgent,
				);
			} catch {
				this.liveUserAgent = null;
			}
		} catch (error) {
			this.browser = null;
			this.context = null;
			this.page = null;
			this.activeProvider = null;
			throw error;
		}
	}

	private async detectBlockAndFallback(
		context?: ToolContext,
	): Promise<BrowserBlockDetectionResult | null> {
		if (!this.page) return null;

		try {
			const blockState = await this.analyzeBlockState();
			const isDataDomeBlocked = blockState.dataDome;
			const isBlocked = blockState.blocked;

			if (!isBlocked) return null;

			console.log(
				"[BrowserTool] Potential block detected. Checking auto fallback...",
			);
			const outputParts = [
				isDataDomeBlocked
					? "DataDome CAPTCHA detected. Do not solve it manually; use the configured browser fallback if it is enabled."
					: "Potential page block or verification challenge detected after navigation.",
			];

			const fallbackProvider = this.getConfiguredFallbackProvider();
			const fallbackLabel = this.getProviderLabel(fallbackProvider);
			const fallbackAvailability =
				this.getFallbackAvailability(fallbackProvider);

			if (this.config.autoFallbackOnBlock === false) {
				outputParts.push(
					"Automatic browser fallback is disabled in configuration.",
				);
				return {
					detected: true,
					output: outputParts.join("\n\n"),
					fallbackApplied: false,
				};
			}

			if ((this.config.confirmBlockWithVision ?? true) && context) {
				const screenshotOutput = await this.captureScreenshotForAnalysis(
					context,
					"Potential block screenshot",
					"Potential block detected.",
				);
				outputParts.push(screenshotOutput);
				console.log("[BrowserTool] Block screenshot saved for analysis.");
			}

			if ((this.config.solveCaptchas ?? true) && this.resolveCaptchaApiKey()) {
				console.log(
					"[BrowserTool] Attempting 2captcha solve for detected challenge...",
				);
				const captchaResult = await this.solveCaptchasOnCurrentPage({
					includeDataDome: isDataDomeBlocked,
				});
				if ((captchaResult.applied as number) > 0) {
					if (captchaResult.verified === true) {
						outputParts.push(
							`2captcha applied ${captchaResult.applied} challenge(s), and the verification challenge is no longer visible. Read the page again before taking further action.`,
						);
						return {
							detected: true,
							output: outputParts.join("\n\n"),
							fallbackApplied: false,
						};
					}
					outputParts.push(
						`2captcha applied ${captchaResult.applied} challenge(s), but the page still appears blocked. Do not claim the CAPTCHA was solved. Current verification state: ${this.formatVerificationState(captchaResult.postSolveState as VerificationState)}`,
					);
				}
				if (
					Array.isArray(captchaResult.skipped) &&
					captchaResult.skipped.length > 0
				) {
					outputParts.push(
						`2captcha could not apply an automatic solution: ${JSON.stringify(captchaResult.skipped)}`,
					);
				}
			}

			if (this.activeProvider === fallbackProvider) {
				outputParts.push(
					`Configured fallback provider (${fallbackLabel}) is already active.`,
				);
				return {
					detected: true,
					output: outputParts.join("\n\n"),
					fallbackApplied: false,
				};
			}

			if (fallbackAvailability.available) {
				console.log(
					`[BrowserTool] Migrating to ${fallbackLabel} due to ${isDataDomeBlocked ? "DataDome captcha" : "block"}...`,
				);
				try {
					await this.migrateToProvider(fallbackProvider);
				} catch (error) {
					outputParts.push(
						`${fallbackLabel} fallback failed: ${error instanceof Error ? error.message : String(error)}.`,
					);
					return {
						detected: true,
						output: outputParts.join("\n\n"),
						fallbackApplied: false,
					};
				}
				outputParts.push(
					isDataDomeBlocked
						? `Automatic ${fallbackLabel} fallback was applied for DataDome and the original URL was retried. Read the page again before deciding the next action.`
						: `Automatic ${fallbackLabel} fallback was applied and the original URL was retried. Read the page again before deciding the next action.`,
				);
				return {
					detected: true,
					output: outputParts.join("\n\n"),
					fallbackApplied: true,
				};
			}
			outputParts.push(
				`Configured fallback provider (${fallbackLabel}) is unavailable: ${fallbackAvailability.reason ?? "unknown reason"}.`,
			);
			return {
				detected: true,
				output: outputParts.join("\n\n"),
				fallbackApplied: false,
			};
		} catch (e) {
			return null;
		}
	}

	private async ensureNoBlock(
		context?: ToolContext,
	): Promise<BrowserBlockDetectionResult | null> {
		return this.detectBlockAndFallback(context);
	}

	async close(): Promise<void> {
		if (this.context) {
			await this.context.close().catch(() => {});
		}
		if (this.browser) {
			await this.browser.close().catch(() => {});
			this.browser = null;
			this.context = null;
			this.page = null;
			this.activeProvider = null;
			this.fingerprint = null;
			this.networkDiagnosticsAttached = false;
			this.resetImageNetworkIssues();
		}
	}

	createTools(): ToolDefinition[] {
		return [
			{
				name: "browser_restart",
				description:
					"Restart the browser session. Use this if the browser is unresponsive or if you encounter 'Target closed' or 'detached Frame' errors.",
				uiIcon: BROWSER_SVG,
				parameters: {},
				handler: async (): Promise<ToolResult> => {
					try {
						await this.close();
						await this.init();
						return {
							success: true,
							output: "Successfully restarted the browser session.",
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_solve_captchas",
				description:
					"Attempt configured 2captcha handling for supported CAPTCHA challenges, then verify whether the challenge is actually gone. Never treat token application as success unless the returned verification state says verifiedClear=true.",
				uiIcon: BROWSER_SVG,
				parameters: {},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection?.fallbackApplied) {
							return {
								success: true,
								output: blockDetection.output,
							};
						}
						const result = await this.solveCaptchasOnCurrentPage({
							includeDataDome: true,
						});
						await this.page.waitForTimeout(1000).catch(() => {});
						const postSolveState =
							(result.postSolveState as VerificationState | undefined) ??
							(await this.getVerificationState());
						const status =
							result.verified === true
								? "CAPTCHA verification appears clear."
								: "CAPTCHA verification still appears visible or blocked. Do not claim it was solved; ask for manual completion or use a non-Google/source-specific alternative.";
						return {
							success: true,
							output: `2captcha attempt: detected ${result.detected}, providerSolved ${result.solved}, applied ${result.applied}, verifiedClear ${result.verified === true}. ${status}\nVerification state: ${this.formatVerificationState(postSolveState)}\nDetails: ${JSON.stringify({ details: result.details, skipped: result.skipped }, null, 2)}\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "decodo_scrape",
				description:
					"Use Decodo Web Scraping API for advanced scraping when normal Playwright navigation is blocked, slow, or unnecessary. Supports premium proxy pool, JavaScript rendering, markdown output, screenshots, XHR capture, geo, headers, cookies, and target templates. Requires DECODO_SCRAPER_TOKEN or DECODO_API_TOKEN.",
				uiIcon: BROWSER_SVG,
				parameters: {
					url: {
						type: "string",
						description:
							"Target URL to scrape. Required unless using a Decodo target template with query.",
					},
					query: {
						type: "string",
						description:
							"Search/query value for Decodo target templates that accept query.",
					},
					target: {
						type: "string",
						description:
							"Optional Decodo target template, e.g. google_search, amazon_search, youtube_search.",
					},
					renderJs: {
						type: "boolean",
						description:
							"If true, request JavaScript-rendered HTML via Decodo headless=html.",
					},
					screenshot: {
						type: "boolean",
						description:
							"If true, request screenshot response via Decodo headless=png.",
					},
					markdown: {
						type: "boolean",
						description: "If true, ask Decodo to convert HTML to Markdown.",
					},
					xhr: {
						type: "boolean",
						description:
							"If true, include XHR/fetch requests captured by Decodo.",
					},
					geo: {
						type: "string",
						description:
							"Optional Decodo geo location, e.g. United States, Spain.",
					},
					proxyPool: {
						type: "string",
						description:
							"Decodo proxy_pool: premium for anti-bot pages, standard for simpler pages. Defaults to premium.",
					},
					parse: {
						type: "boolean",
						description:
							"If true, use Decodo structured parser where target template supports it.",
					},
					sessionId: {
						type: "string",
						description:
							"Optional Decodo session_id to reuse the same IP for related requests.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
				): Promise<ToolResult> => {
					try {
						const authorization = this.resolveDecodoScraperAuthorization();
						if (!authorization) {
							return {
								success: false,
								output: "",
								error:
									"Decodo scraping credentials are not configured. Set DECODO_SCRAPER_TOKEN/DECODO_API_TOKEN or DECODO_SCRAPER_USERNAME/DECODO_SCRAPER_PASSWORD.",
							};
						}
						const url = typeof params.url === "string" ? params.url.trim() : "";
						const query =
							typeof params.query === "string" ? params.query.trim() : "";
						if (!url && !query) {
							return {
								success: false,
								output: "",
								error: "Missing url or query parameter",
							};
						}
						const body: Record<string, unknown> = {
							proxy_pool:
								typeof params.proxyPool === "string"
									? params.proxyPool
									: "premium",
						};
						if (url) {
							await this.urlSafetyPolicy.assertAllowedAsync(
								url,
								"Decodo scrape URL",
							);
							body.url = url;
						}
						if (query) body.query = query;
						if (typeof params.target === "string" && params.target.trim())
							body.target = params.target.trim();
						if (params.screenshot === true) body.headless = "png";
						else if (params.renderJs === true) body.headless = "html";
						if (params.markdown === true) body.markdown = true;
						if (params.xhr === true) body.xhr = true;
						if (params.parse === true) body.parse = true;
						if (typeof params.geo === "string" && params.geo.trim())
							body.geo = params.geo.trim();
						if (typeof params.sessionId === "string" && params.sessionId.trim())
							body.session_id = params.sessionId.trim();

						const response = await fetch(DECODO_SCRAPE_URL, {
							method: "POST",
							headers: {
								accept: "application/json",
								"content-type": "application/json",
								authorization,
							},
							body: JSON.stringify(body),
						});
						const responseText = await response.text();
						let json: unknown;
						try {
							json = responseText ? JSON.parse(responseText) : {};
						} catch {
							json = { raw: responseText };
						}
						if (!response.ok) {
							return {
								success: false,
								output: JSON.stringify(json, null, 2),
								error: `Decodo scrape failed with HTTP ${response.status}`,
							};
						}
						return {
							success: true,
							output: `Decodo scrape result:\n${JSON.stringify(json, null, 2).slice(0, 60000)}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_etsy_task",
				description:
					"Optional fallback for Etsy product discovery when manual navigation stalls: direct search URL, capture search results, select/open the first listing, capture product page, extract/deduplicate product image URLs, and return a completion contract. Prefer normal step-by-step browser navigation plus browser_observe unless the user asks for the compact flow or repeated actions are failing.",
				uiIcon: BROWSER_SVG,
				parameters: {
					query: {
						type: "string",
						description:
							"Search query to run on Etsy, e.g. 'camisetas para el dia de la madre'.",
						required: true,
					},
					imageLimit: {
						type: "number",
						description:
							"Maximum product image URLs to return. Defaults to 10.",
					},
					captureSearch: {
						type: "boolean",
						description:
							"Capture the Etsy search results page. Defaults to true.",
					},
					captureProduct: {
						type: "boolean",
						description: "Capture the product page. Defaults to true.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					const query =
						typeof params.query === "string" ? params.query.trim() : "";
					if (!query) {
						return {
							success: false,
							output: "",
							error: "Missing or invalid query parameter",
						};
					}

					const imageLimit =
						typeof params.imageLimit === "number"
							? Math.max(1, Math.min(params.imageLimit, 30))
							: 10;
					const captureSearch = params.captureSearch !== false;
					const captureProduct = params.captureProduct !== false;
					const result: Record<string, unknown> = {
						success: false,
						status: "partial",
						query,
						search: {
							url: "",
							title: "",
							resultCount: 0,
							candidates: [],
						},
						product: null,
						images: [],
						completion: {
							done: false,
							reason: "Not started",
							requiredArtifacts: {
								searchCaptured: false,
								productOpened: false,
								productCaptured: false,
								imagesExtracted: false,
							},
						},
						blockers: [],
					};

					try {
						await this.init();
						const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(query)}&ref=search_bar`;
						await this.gotoWithSession(searchUrl, {
							waitUntil: "domcontentloaded",
							timeout: 30000,
						}).catch(() => {});
						let blockDetection = await this.detectBlockAndFallback(context);
						await this.autoAcceptCookies();
						if (!blockDetection?.detected)
							await this.saveSessionForCurrentPage();
						result.search.url = this.page.url();
						result.search.title = await this.page.title().catch(() => "");
						if (blockDetection?.output)
							result.blockers.push(blockDetection.output);

						if (captureSearch) {
							try {
								const searchShot = await this.captureScreenshotForAnalysis(
									context,
									"Etsy search results",
									"Etsy search results captured.",
								);
								result.search.screenshot =
									this.extractMediaUrlFromOutput(searchShot);
								result.completion.requiredArtifacts.searchCaptured = Boolean(
									result.search.screenshot,
								);
							} catch (error) {
								result.search.screenshotError =
									error instanceof Error ? error.message : String(error);
							}
						}

						const candidates = await this.page.evaluate(() => {
							const seen = new Set();
							return Array.from(
								document.querySelectorAll('a[href*="/listing/"]'),
							)
								.map((anchor: unknown) => {
									const href = anchor.href || anchor.getAttribute("href") || "";
									const match = href.match(/\/listing\/(\d+)/);
									if (!match) return null;
									const rect = anchor.getBoundingClientRect();
									const img = anchor.querySelector("img");
									const text = (
										anchor.innerText ||
										anchor.getAttribute("aria-label") ||
										img?.alt ||
										""
									)
										.replace(/\s+/g, " ")
										.trim();
									return {
										url: new URL(href, location.href).href,
										listingId: match[1],
										title: text.slice(0, 180),
										visible: rect.width > 0 && rect.height > 0,
										hasImage: Boolean(img),
									};
								})
								.filter(Boolean)
								.filter((item: unknown) => {
									if (seen.has(item.listingId)) return false;
									seen.add(item.listingId);
									return item.visible || item.hasImage;
								})
								.slice(0, 20)
								.map((item: unknown, index) => ({ ...item, rank: index + 1 }));
						});

						result.search.candidates = candidates;
						result.search.resultCount = candidates.length;
						result.search.firstProduct = candidates[0] || null;

						if (!candidates[0]) {
							result.status = blockDetection?.detected
								? "blocked"
								: "no_results";
							result.completion.reason =
								"No Etsy listing links were found on the search page.";
							return {
								success: true,
								output: `Etsy task result:\n${JSON.stringify(result, null, 2)}`,
							};
						}

						const first = candidates[0];
						await this.gotoWithSession(first.url, {
							waitUntil: "domcontentloaded",
							timeout: 30000,
						}).catch(() => {});
						blockDetection = await this.detectBlockAndFallback(context);
						await this.autoAcceptCookies();
						if (!blockDetection?.detected)
							await this.saveSessionForCurrentPage();
						await this.page.waitForTimeout(800).catch(() => {});

						const finalUrl = this.page.url();
						const productTitle = await this.page.title().catch(() => "");
						const listingId = (finalUrl.match(/\/listing\/(\d+)/) ||
							first.url.match(/\/listing\/(\d+)/))?.[1];
						result.product = {
							url: finalUrl,
							title: productTitle,
							listingId,
							selectedResult: first,
						};
						result.completion.requiredArtifacts.productOpened =
							/\/listing\/\d+/.test(finalUrl) || Boolean(listingId);
						if (blockDetection?.output)
							result.blockers.push(blockDetection.output);

						if (captureProduct) {
							try {
								const productShot = await this.captureScreenshotForAnalysis(
									context,
									"Etsy product page",
									"Etsy product page captured.",
								);
								result.product.screenshot =
									this.extractMediaUrlFromOutput(productShot);
								result.completion.requiredArtifacts.productCaptured = Boolean(
									result.product.screenshot,
								);
							} catch (error) {
								result.product.screenshotError =
									error instanceof Error ? error.message : String(error);
							}
						}

						const images = await this.page.evaluate(
							({ imageLimit }) => {
								const byKey = new Map();
								const normalizeUrl = (raw: string) => {
									if (!raw || typeof raw !== "string") return null;
									if (raw.startsWith("data:") || raw.startsWith("blob:"))
										return null;
									try {
										return new URL(raw.trim(), location.href).href;
									} catch {
										return null;
									}
								};
								const parseSrcset = (srcset: string) =>
									(srcset || "")
										.split(",")
										.map((part) => {
											const [url, descriptor] = part.trim().split(/\s+/, 2);
											const width = descriptor?.endsWith("w")
												? Number.parseInt(descriptor, 10)
												: 0;
											return {
												url: normalizeUrl(url),
												width: Number.isFinite(width) ? width : 0,
											};
										})
										.filter((item) => item.url);
								const assetKey = (url: string) =>
									url
										.replace(/il_\d+xN/g, "il_SIZE")
										.replace(/il_fullxfull/g, "il_SIZE")
										.replace(/[?#].*$/, "");
								const add = (
									raw: string,
									meta: Record<string, unknown> = {},
								) => {
									const url = normalizeUrl(raw);
									if (!url || !/i\.etsystatic\.com/i.test(url)) return;
									if (/avatar|shop|logo|icon|badge|tracking|pixel/i.test(url))
										return;
									const key = assetKey(url);
									const normalizedUrl = url.replace(/il_\d+xN/g, "il_1140xN");
									const existing = byKey.get(key);
									const score =
										(meta.width || 0) +
										(/il_fullxfull|il_1140xN|il_1080xN|il_794xN/i.test(url)
											? 5000
											: 0) +
										(meta.source === "json" ? 1000 : 0);
									if (!existing || score > existing.score) {
										byKey.set(key, {
											url,
											normalizedUrl,
											width: meta.width || 0,
											height: meta.height || 0,
											alt: (meta.alt || "").slice(0, 180),
											source: meta.source || "img",
											confidence:
												/il_fullxfull|il_1140xN|il_1080xN|il_794xN/i.test(url)
													? "high"
													: "medium",
											score,
										});
									}
								};

								for (const img of Array.from(document.images) as unknown[]) {
									const rect = img.getBoundingClientRect?.() || {
										width: 0,
										height: 0,
									};
									const meta = {
										width: Math.max(img.naturalWidth || 0, rect.width || 0),
										height: Math.max(img.naturalHeight || 0, rect.height || 0),
										alt: img.alt || img.getAttribute("aria-label") || "",
										source: "gallery-img",
									};
									add(img.currentSrc || img.src, meta);
									for (const candidate of parseSrcset(img.srcset))
										add(candidate.url, {
											...meta,
											width: candidate.width || meta.width,
											source: "srcset",
										});
									for (const attr of [
										"data-src",
										"data-original",
										"data-full",
										"data-zoom-image",
										"data-image-url",
									])
										add(img.getAttribute(attr), meta);
								}
								for (const source of Array.from(
									document.querySelectorAll("source[srcset]"),
								) as unknown[]) {
									for (const candidate of parseSrcset(
										source.getAttribute("srcset"),
									))
										add(candidate.url, {
											width: candidate.width,
											source: "srcset",
										});
								}
								for (const meta of Array.from(
									document.querySelectorAll(
										'meta[property="og:image"], meta[name="twitter:image"]',
									),
								) as unknown[]) {
									add(meta.getAttribute("content"), {
										width: 1200,
										source: "og",
									});
								}
								const urlRe =
									/https?:\/\/i\.etsystatic\.com\/[^\s"'<>\\)]+(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?/gi;
								for (const script of Array.from(document.scripts).slice(
									0,
									120,
								) as unknown[]) {
									const text = script.textContent || "";
									if (!/etsystatic|image|photo|listing/i.test(text)) continue;
									for (const match of text.matchAll(urlRe))
										add(match[0], { width: 1000, source: "json" });
								}
								return Array.from(byKey.values())
									.sort((a: unknown, b: unknown) => b.score - a.score)
									.slice(0, imageLimit)
									.map((item: unknown, index) => ({
										index: index + 1,
										url: item.normalizedUrl || item.url,
										originalUrl: item.url,
										width: item.width,
										height: item.height,
										alt: item.alt,
										source: item.source,
										confidence: item.confidence,
									}));
							},
							{ imageLimit },
						);

						result.images = images;
						result.completion.requiredArtifacts.imagesExtracted =
							images.length > 0;
						const required = result.completion.requiredArtifacts;
						result.success =
							required.searchCaptured &&
							required.productOpened &&
							required.imagesExtracted;
						result.status = result.success
							? "completed"
							: images.length > 0
								? "partial"
								: result.blockers.length > 0
									? "blocked"
									: "images_not_found";
						result.completion.done =
							result.status === "completed" ||
							(result.status === "partial" && images.length > 0);
						result.completion.reason = result.completion.done
							? "Search/product evidence and product image URLs are available; answer the user now without more browser tools."
							: "The flow could not gather enough product evidence or images.";

						return {
							success: true,
							output: `Etsy task result:\n${JSON.stringify(result, null, 2)}\n\nIf completion.done is true or images are present, answer the user now and do not call more browser tools.`,
						};
					} catch (error) {
						result.status = "blocked";
						result.blockers.push(
							error instanceof Error ? error.message : String(error),
						);
						result.completion.reason = "Unexpected browser_etsy_task failure.";
						return {
							success: true,
							output: `Etsy task result:\n${JSON.stringify(result, null, 2)}`,
						};
					}
				},
			},
			{
				name: "browser_observe",
				description:
					"Observe the current browser page. Returns both an accessibility tree snapshot and a page state summary. Use browser_snapshot instead if you only need the a11y tree. Use this when you need both the a11y tree and the legacy page state info (inputs, buttons, listings, etc.).",
				uiIcon: BROWSER_SVG,
				parameters: {},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						const blockOutput = blockDetection?.output
							? `${blockDetection.output}\n\n`
							: "";
						const { output: snapshotOutput } =
							await this.buildSnapshotWithUidMap();
						return {
							success: true,
							output: `${blockOutput}Page observation:\n\nAccessibility tree:\n${snapshotOutput}\n\n---\n\nLegacy page state:\n${await this.getPageStateSummary()}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_navigate",
				description:
					"Navigate the browser to an http(s) URL. Do not use this for local file paths or file:/// URLs; use browser_open_file instead. Returns an accessibility tree snapshot of the loaded page. If navigation ends at about:blank, treat it as an unloaded or blocked navigation.",
				uiIcon: BROWSER_SVG,
				parameters: {
					url: {
						type: "string",
						description: "The URL to navigate to",
						required: true,
					},
					waitUntil: {
						type: "string",
						description:
							"Load state to wait for: load (default for local previews), domcontentloaded, or networkidle.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						const { url, waitUntil } = params;
						if (typeof url !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid url parameter",
							};
						}
						try {
							const parsedUrl = new URL(url);
							if (parsedUrl.protocol === "file:") {
								return {
									success: false,
									output: "",
									error:
										"Local files must be opened with browser_open_file using the file path, not browser_navigate with file://.",
								};
							}
						} catch {
							// Let Playwright and URL safety produce the actionable error for non-URL input.
						}
						await this.init();
						const loadState = [
							"domcontentloaded",
							"load",
							"networkidle",
						].includes(waitUntil as string)
							? (waitUntil as "domcontentloaded" | "load" | "networkidle")
							: "load";
						const initialUrl = this.page.url();
						let navigationWarning = "";
						try {
							await this.gotoWithSession(url, {
								waitUntil: loadState,
								timeout: 30000,
							});
						} catch (error) {
							const currentUrl = this.page.url();
							if (
								isNavigationTimeoutError(error) &&
								currentUrl &&
								currentUrl !== "about:blank" &&
								currentUrl !== initialUrl
							) {
								navigationWarning = `\nNavigation warning: ${error instanceof Error ? error.message : String(error)}`;
							} else {
								return {
									success: false,
									output: "",
									error: error instanceof Error ? error.message : String(error),
								};
							}
						}

						if (this.config.humanBehavior !== false) {
							await this.randomDelay(800, 2500);
						}

						const blockDetection = await this.detectBlockAndFallback(context);

						await this.autoAcceptCookies();
						if (!blockDetection?.detected)
							await this.saveSessionForCurrentPage();
						const title = await this.page.title().catch(() => "(unknown)");
						const finalUrl = this.page.url();
						if (!finalUrl || finalUrl === "about:blank") {
							return {
								success: false,
								output: "",
								error: `Navigation did not load a page; current URL is ${finalUrl || "unknown"}.`,
							};
						}

						// PDF: Chromium's PDF viewer renders the file but exposes no
						// text in the DOM, so a snapshot would be empty. Steer the agent
						// to pdf_read, which extracts text (+ OCR) directly from the file.
						const contentType = await this.page
							.evaluate(() => document.contentType)
							.catch(() => "");
						const isPdf =
							contentType === "application/pdf" ||
							/\.pdf(\?|#|$)/i.test(finalUrl);
						if (isPdf) {
							return {
								success: true,
								output: `Navigated to ${finalUrl}, which is a PDF. The browser cannot extract PDF text. Use the \`pdf_read\` tool with source="${finalUrl}" to read its content (it also OCRs scanned pages).`,
								metadata: { pdf: true, url: finalUrl, title },
							};
						}

						const blockOutput = blockDetection?.output
							? `\n\n${blockDetection.output}`
							: "";

						const { output: snapshotOutput } =
							await this.buildSnapshotWithUidMap();
						return {
							success: true,
							output: `Successfully navigated. Page title: "${title}" | Current URL: ${finalUrl}${navigationWarning}${blockOutput}\n\nAccessibility tree snapshot:\n${snapshotOutput}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_search",
				description:
					"Search the web using the real browser (Google -> Bing -> DuckDuckGo). Use as the fallback when the web_search API tool is out of quota or unavailable. Returns a list of {title,url} results. On a CAPTCHA/block it clears the session, retries once, then falls to the next engine. After getting results, use browser_navigate (or webReader/pdf_read) to read the pages.",
				uiIcon: BROWSER_SVG,
				parameters: {
					query: {
						type: "string",
						description: "The search query.",
						required: true,
					},
					maxResults: {
						type: "number",
						description: "Maximum number of results to return (default 8).",
						required: false,
					},
					engines: {
						type: "array",
						description:
							"Ordered engine names to try. Any of 'google','bing','duckduckgo'. Default: ['google','bing','duckduckgo'].",
						required: false,
					},
				},
				handler: async (
					params: Record<string, unknown>,
				): Promise<ToolResult> => {
					try {
						const query = String(params.query ?? "").trim();
						if (!query) {
							return {
								success: false,
								output: "",
								error: "Missing 'query' parameter.",
							};
						}
						const maxResults = Number(params.maxResults) || 8;
						const engines = Array.isArray(params.engines)
							? (params.engines.filter(
									(e) => typeof e === "string",
								) as string[])
							: [];
						await this.init();
						const outcome = await this.searchViaBrowser(
							query,
							engines,
							maxResults,
						);
						const lines = outcome.results.map(
							(r, i) => `${i + 1}. ${r.title}\n   ${r.url}`,
						);
						const header = outcome.engine
							? `Search via ${outcome.engine}${
									outcome.retried ? " (after retry on a clean session)" : ""
								}; ${outcome.results.length} result(s).${
									outcome.blocked ? " (page still showed block signals)" : ""
								}`
							: `Search produced no results on any engine. Last issue: ${
									outcome.error || "unknown"
								}`;
						return {
							success: true,
							output: `${header}\n\n${lines.join("\n\n")}`,
							metadata: {
								engine: outcome.engine,
								count: outcome.results.length,
								blocked: outcome.blocked,
								retried: outcome.retried,
								query,
							},
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_open_file",
				description:
					"Open a host-local file for previewing. Pass an absolute or relative file path as-is, not a file:/// URL. Success requires Current URL to start with file:///. If the result is about:blank or a policy error occurs, report the blocker and do not retry by injecting the HTML with browser_eval.",
				uiIcon: BROWSER_SVG,
				parameters: {
					path: {
						type: "string",
						description:
							"Absolute or relative path to the local file to preview (e.g. D:/folder/page.html or /home/user/page.html)",
						required: true,
					},
					waitUntil: {
						type: "string",
						description:
							"Load state to wait for: load (default for local previews), domcontentloaded, or networkidle.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					_context: ToolContext,
				): Promise<ToolResult> => {
					try {
						const filePath = params.path;
						if (typeof filePath !== "string" || !filePath.trim()) {
							return {
								success: false,
								output: "",
								error: "Missing or invalid path parameter",
							};
						}
						if (/^file:\/\//i.test(filePath.trim())) {
							return {
								success: false,
								output: "",
								error:
									"Pass the local file path as-is, not a file:/// URL. Example: D:/folder/page.html",
							};
						}
						const resolved = resolve(filePath);
						if (!fs.existsSync(resolved)) {
							return {
								success: false,
								output: "",
								error: `File not found: ${resolved}`,
							};
						}
						const fileUrl = pathToFileURL(resolved).href;
						await this.init();
						const loadState = [
							"domcontentloaded",
							"load",
							"networkidle",
						].includes(params.waitUntil as string)
							? (params.waitUntil as
									| "domcontentloaded"
									| "load"
									| "networkidle")
							: "load";
						this.invalidateSnapshotCache();
						this.resetImageNetworkIssues();
						let navigationWarning = "";
						try {
							await this.page.goto(fileUrl, {
								waitUntil: loadState,
								timeout: 30000,
							});
						} catch (error) {
							const currentUrl = this.page.url();
							if (
								isNavigationTimeoutError(error) &&
								currentUrl &&
								currentUrl.startsWith("file:")
							) {
								navigationWarning = `\nNavigation warning: ${error instanceof Error ? error.message : String(error)}`;
							} else {
								return {
									success: false,
									output: "",
									error: error instanceof Error ? error.message : String(error),
								};
							}
						}
						const title = await this.page.title().catch(() => "(unknown)");
						const finalUrl = this.page.url();
						if (!finalUrl || finalUrl === "about:blank") {
							return {
								success: false,
								output: "",
								error: `Local file did not load; current URL is ${finalUrl || "unknown"}.`,
							};
						}
						if (!finalUrl.startsWith("file:")) {
							return {
								success: false,
								output: "",
								error: `Local file navigation left the file URL and ended at ${finalUrl}.`,
							};
						}
						await this.waitForImageElements();
						const imageOutput = await this.summarizeImageElements();
						const { output: snapshotOutput } =
							await this.buildSnapshotWithUidMap();
						return {
							success: true,
							output: `Opened local file: ${resolved}\nPage title: "${title}" | Current URL: ${finalUrl}${navigationWarning}${imageOutput}\n\nAccessibility tree snapshot:\n${snapshotOutput}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_screenshot",
				description:
					"Take a screenshot of the current page and save it to the media system. Returns the saved media URL instead of a raw base64 string; use browser_read_page, the accessibility tree, or an available vision tool to inspect it.",
				uiIcon: BROWSER_SVG,
				parameters: {
					fullPage: {
						type: "boolean",
						description:
							"If true, capture the full scrollable page instead of only the viewport.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (
							blockDetection?.output.includes("DataDome") &&
							!blockDetection.fallbackApplied
						) {
							return {
								success: true,
								output: blockDetection.output,
							};
						}
						await this.waitForImageElements();
						const imageOutput = await this.summarizeImageElements();
						const screenshotOutput = await this.captureScreenshotForAnalysis(
							context,
							params.fullPage === true
								? "Full page browser screenshot"
								: "Browser screenshot",
							params.fullPage === true
								? "Full page browser screenshot captured."
								: "Browser screenshot captured.",
							{ fullPage: params.fullPage === true },
						);
						const blockOutput = blockDetection?.output
							? `${blockDetection.output}\n\n`
							: "";
						return {
							success: true,
							output: `${blockOutput}Successfully took a screenshot.${imageOutput} ${screenshotOutput}\n\nAccessibility tree at screenshot:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_click_text",
				description:
					"Click an element on the page by its visible text. Much more reliable than CSS selectors.",
				uiIcon: BROWSER_SVG,
				parameters: {
					text: {
						type: "string",
						description:
							"The visible text of the element to click (e.g. 'Accept All Cookies', 'Search')",
						required: true,
					},
					exact: {
						type: "boolean",
						description:
							"If true, matches the exact text. If false, matches if the element contains the text. Defaults to false.",
					},
					waitForNavigation: {
						type: "boolean",
						description:
							"If true, the tool will wait for the page to navigate and fully load after clicking.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection) {
							return { success: true, output: blockDetection.output };
						}
						const { text, exact = false, waitForNavigation } = params;
						if (typeof text !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid text parameter",
							};
						}

						const clickAction = async () => {
							try {
								await this.page
									.getByText(text, { exact: exact as boolean })
									.first()
									.click({ force: true, timeout: 5000 });
							} catch (e) {
								console.log(
									`getByText click failed for "${text}", falling back to JS DOM click...`,
								);
								await this.page.evaluate(
									(txt: string, isExact: boolean) => {
										const elements = Array.from(document.querySelectorAll("*"));
										const target = elements.find((el) => {
											const elText = (el.textContent || "").trim();
											return isExact ? elText === txt : elText.includes(txt);
										});
										if (target && target instanceof HTMLElement) {
											target.click();
										} else {
											throw new Error(`Element with text "${txt}" not found`);
										}
									},
									text,
									exact as boolean,
								);
							}
						};

						if (waitForNavigation) {
							await Promise.all([
								this.page
									.waitForNavigation({
										waitUntil: "networkidle",
										timeout: 30000,
									})
									.catch(() => {}),
								clickAction(),
							]);
						} else {
							await clickAction();
						}
						this.invalidateSnapshotCache();

						return {
							success: true,
							output: `Successfully clicked element with text "${text}".\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_scroll",
				description:
					"Scroll the page up or down to see content that is out of view.",
				uiIcon: BROWSER_SVG,
				parameters: {
					direction: {
						type: "string",
						description: "The direction to scroll ('down' or 'up')",
						required: true,
					},
					amount: {
						type: "number",
						description: "The amount of pixels to scroll. Defaults to 500.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection) {
							return { success: true, output: blockDetection.output };
						}
						const { direction, amount = 500 } = params;
						if (direction !== "down" && direction !== "up") {
							return {
								success: false,
								output: "",
								error: "Direction must be 'down' or 'up'",
							};
						}

						const getScrollState = async () =>
							this.page.evaluate(() => ({
								x: window.scrollX,
								y: window.scrollY,
								docTop: document.documentElement?.scrollTop || 0,
								bodyTop: document.body?.scrollTop || 0,
								height:
									document.documentElement?.scrollHeight ||
									document.body?.scrollHeight ||
									0,
								viewport: window.innerHeight,
							}));
						const beforeScroll = await getScrollState();
						const scrollPixels =
							direction === "down" ? (amount as number) : -(amount as number);
						if (
							this.config.humanBehavior !== false &&
							Math.abs(scrollPixels) > 100
						) {
							const steps = Math.ceil(
								Math.abs(scrollPixels) / (150 + Math.random() * 250),
							);
							const perStep = scrollPixels / steps;
							for (let i = 0; i < steps; i++) {
								const variation = perStep + (Math.random() - 0.5) * 30;
								await this.page.mouse.wheel(0, variation);
								await this.page
									.evaluate((px) => window.scrollBy(0, px), variation)
									.catch(() => {});
								await this.randomDelay(80, 250);
								if (Math.random() < 0.08 && direction === "down") {
									const backtrack = -(30 + Math.random() * 60);
									await this.page.mouse.wheel(0, backtrack);
									await this.page
										.evaluate((px) => window.scrollBy(0, px), backtrack)
										.catch(() => {});
									await this.randomDelay(50, 150);
								}
							}
						} else {
							await this.page.mouse.wheel(0, scrollPixels);
							await this.page
								.evaluate((px) => window.scrollBy(0, px), scrollPixels)
								.catch(() => {});
						}
						await this.randomDelay(300, 600);
						const afterScroll = await getScrollState();
						const movedBy = Math.round(
							(afterScroll.y || afterScroll.docTop || afterScroll.bodyTop) -
								(beforeScroll.y || beforeScroll.docTop || beforeScroll.bodyTop),
						);
						this.invalidateSnapshotCache();

						return {
							success: true,
							output: `Scroll requested ${direction} by ${Math.abs(scrollPixels)} pixels; actual page delta: ${movedBy}px (from y=${Math.round(beforeScroll.y)} to y=${Math.round(afterScroll.y)}, documentHeight=${Math.round(afterScroll.height)}, viewport=${Math.round(afterScroll.viewport)}).\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_click",
				description: "Click an element on the page using a CSS selector",
				uiIcon: BROWSER_SVG,
				parameters: {
					selector: {
						type: "string",
						description: "The CSS selector of the element to click",
						required: true,
					},
					waitForNavigation: {
						type: "boolean",
						description:
							"If true, the tool will wait for the page to navigate and fully load (networkidle) after clicking.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection) {
							return { success: true, output: blockDetection.output };
						}
						const { selector, waitForNavigation } = params;
						if (typeof selector !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid selector parameter",
							};
						}

						if (waitForNavigation) {
							await Promise.all([
								this.page
									.waitForLoadState("networkidle", { timeout: 15000 })
									.catch(() => {}),
								this.humanClick(selector),
							]);
							await this.autoAcceptCookies();
							await this.saveSessionForCurrentPage();
							this.invalidateSnapshotCache();
							return {
								success: true,
								output: `Successfully clicked element matching selector: ${selector} and waited for navigation to complete.\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
							};
						}
						await this.humanClick(selector);
						await this.autoAcceptCookies();
						await this.saveSessionForCurrentPage();
						this.invalidateSnapshotCache();
						return {
							success: true,
							output: `Successfully clicked element matching selector: ${selector}\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_type",
				description:
					"Type text into an input element using a CSS selector. If you are typing into a search bar, and pressing 'Enter' via browser_press_key fails to submit the search, you SHOULD try using browser_click on the search magnifier icon instead.",
				uiIcon: BROWSER_SVG,
				parameters: {
					selector: {
						type: "string",
						description: "The CSS selector of the input element",
						required: true,
					},
					text: {
						type: "string",
						description: "The text to type",
						required: true,
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection) {
							return { success: true, output: blockDetection.output };
						}
						const { selector, text } = params;
						if (typeof selector !== "string" || typeof text !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid selector or text parameters",
							};
						}

						await this.humanType(selector, text);
						this.invalidateSnapshotCache();

						return {
							success: true,
							output: `Successfully typed text into element matching selector: ${selector}\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_get_elements",
				description:
					"Extract a list of interactable elements (buttons, links, inputs) currently visible on the page, including their text and guaranteed CSS selectors. Use this when you are unsure what selector to use for clicking or typing.",
				uiIcon: BROWSER_SVG,
				parameters: {},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection) {
							return { success: true, output: blockDetection.output };
						}
						const elementsJSON = await this.page.evaluate(() => {
							const items: Array<{
								type: string;
								text: string;
								selector: string;
							}> = [];

							const getUniqueSelector = (el: Element): string => {
								if (el.id) return `#${el.id}`;
								if (el.className && typeof el.className === "string") {
									const classes = el.className
										.split(" ")
										.filter((c) => c.trim().length > 0)
										.slice(0, 2);
									if (classes.length > 0) {
										const sel = `${el.tagName.toLowerCase()}.${classes.join(".")}`;
										if (document.querySelectorAll(sel).length === 1) return sel;
									}
								}
								let path = "";
								let current: Element | null = el;
								while (current && current.tagName !== "HTML") {
									let index = 1;
									let sibling = current.previousElementSibling;
									while (sibling) {
										if (sibling.tagName === current.tagName) index++;
										sibling = sibling.previousElementSibling;
									}
									path = `${current.tagName.toLowerCase()}:nth-of-type(${index}) ${path}`;
									current = current.parentElement;
								}
								return path.trim();
							};

							const interactables = Array.from(
								document.querySelectorAll(
									'button, a, [role="button"], input, textarea, select',
								),
							);

							for (const el of interactables) {
								const style = window.getComputedStyle(el);
								if (
									style.display === "none" ||
									style.visibility === "hidden" ||
									style.opacity === "0"
								)
									continue;

								const rect = el.getBoundingClientRect();
								if (rect.width === 0 || rect.height === 0) continue;

								const tag = el.tagName.toLowerCase();
								let text = (el.textContent || "").replace(/\s+/g, " ").trim();

								if (tag === "input" || tag === "textarea") {
									const input = el as HTMLInputElement;
									text = `[Input Type: ${input.type || "text"}] Placeholder: ${input.placeholder || "none"} | Value: ${input.value || "empty"}`;
								}

								if (text.length > 0 || tag === "input") {
									items.push({
										type: tag,
										text: text.substring(0, 100),
										selector: getUniqueSelector(el),
									});
								}
							}

							return JSON.stringify(items.slice(0, 100), null, 2);
						});

						return {
							success: true,
							output: `Found interactable elements:\n\n${elementsJSON}\n\nAccessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_press_key",
				description:
					"Press a specific keyboard key (e.g., 'Enter', 'Escape', 'Tab', 'ArrowDown').",
				uiIcon: BROWSER_SVG,
				parameters: {
					key: {
						type: "string",
						description:
							"The name of the key to press (e.g., 'Enter', 'Escape')",
						required: true,
					},
					waitForNavigation: {
						type: "boolean",
						description:
							"If true, the tool will wait for the page to navigate and fully load (networkidle) after pressing the key.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection) {
							return { success: true, output: blockDetection.output };
						}
						const { key, waitForNavigation } = params;
						if (typeof key !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid key parameter",
							};
						}

						if (waitForNavigation) {
							await Promise.all([
								this.page
									.waitForLoadState("networkidle", { timeout: 15000 })
									.catch(() => {}),
								this.page.keyboard.press(key),
							]);
							this.invalidateSnapshotCache();
							return {
								success: true,
								output: `Successfully pressed key: ${key} and waited for navigation to complete.\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
							};
						}
						await this.page.keyboard.press(key);
						this.invalidateSnapshotCache();
						return {
							success: true,
							output: `Successfully pressed key: ${key}\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_wait",
				description:
					"Wait for a specified number of milliseconds or for network activity to settle.",
				uiIcon: BROWSER_SVG,
				parameters: {
					milliseconds: {
						type: "number",
						description:
							"Amount of time to wait in milliseconds. If not provided, it waits for networkidle.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const { milliseconds } = params;

						if (typeof milliseconds === "number") {
							const safeMilliseconds = Math.max(
								0,
								Math.min(milliseconds, MAX_BROWSER_WAIT_MS),
							);
							await this.page.waitForTimeout(safeMilliseconds);
							const blockDetection = await this.ensureNoBlock(context);
							return {
								success: true,
								output: `${blockDetection?.output || `Successfully waited for ${safeMilliseconds} milliseconds.`}\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
							};
						}
						await this.page
							.waitForLoadState("networkidle", { timeout: 15000 })
							.catch(() => {});
						const blockDetection = await this.ensureNoBlock(context);
						return {
							success: true,
							output: `${blockDetection?.output || "Successfully waited for network activity to settle."}\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_eval",
				description:
					"Execute small JavaScript snippets in the current page for inspection or interaction. Do not use this to load, replace, or manually inject an entire local HTML document; use browser_open_file for local files.",
				uiIcon: BROWSER_SVG,
				parameters: {
					script: {
						type: "string",
						description:
							"The JavaScript code to execute. Return value will be returned to the tool output.",
						required: true,
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const { script } = params;
						if (typeof script !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid script parameter",
							};
						}
						const blockDetection = await this.ensureNoBlock(context);
						if (
							blockDetection?.output.includes("DataDome") &&
							!blockDetection.fallbackApplied
						) {
							return {
								success: true,
								output: blockDetection.output,
							};
						}
						const result = await withTimeout(
							this.page.evaluate(script),
							BROWSER_EVAL_TIMEOUT_MS,
							"browser_eval",
						);
						const blockOutput = blockDetection?.output
							? `${blockDetection.output}\n\n`
							: "";
						const serialized =
							typeof result === "string"
								? result
								: JSON.stringify(result, null, 2) || "undefined";
						return {
							success: true,
							output: `${blockOutput}${serialized}\n\nUpdated accessibility tree:\n${(await this.buildSnapshotWithUidMap()).output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_extract_images",
				description:
					"Extract and deduplicate image URLs from the current page without clicking thumbnails. Use this first for product galleries. It inspects img/currentSrc/srcset, picture/source, anchors, inline/background images, common data attributes, OpenGraph, JSON-LD, and embedded scripts; prefers larger product-like images.",
				uiIcon: BROWSER_SVG,
				parameters: {
					limit: {
						type: "number",
						description:
							"Maximum number of image candidates to return. Defaults to 20.",
					},
					minWidth: {
						type: "number",
						description:
							"Minimum displayed or natural width to prefer. Defaults to 120.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (
							blockDetection?.output.includes("DataDome") &&
							!blockDetection.fallbackApplied
						) {
							return { success: true, output: blockDetection.output };
						}

						const limit =
							typeof params.limit === "number"
								? Math.max(1, Math.min(params.limit, 80))
								: 20;
						const minWidth =
							typeof params.minWidth === "number"
								? Math.max(0, params.minWidth)
								: 120;
						const result = await this.page.evaluate(
							({ limit, minWidth }) => {
								const imageExtRe = /\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i;
								const urlImageRe =
									/https?:\/\/[^\s"'<>\\)]+(?:png|jpe?g|webp|gif|avif)(?:\?[^\s"'<>\\)]*)?/gi;
								const byUrl = new Map();
								const base = document.baseURI || location.href;

								const normalizeUrl = (raw) => {
									if (!raw || typeof raw !== "string") return null;
									let value = raw.trim();
									if (
										!value ||
										value.startsWith("data:") ||
										value.startsWith("blob:")
									)
										return null;
									value = value
										.replace(/^url\(["']?/, "")
										.replace(/["']?\)$/, "")
										.trim();
									try {
										return new URL(value, base).href;
									} catch {
										return null;
									}
								};

								const parseSrcset = (srcset) => {
									if (!srcset || typeof srcset !== "string") return [];
									return srcset
										.split(",")
										.map((part) => {
											const [url, descriptor] = part.trim().split(/\s+/, 2);
											const width = descriptor?.endsWith("w")
												? Number.parseInt(descriptor, 10)
												: 0;
											return {
												url: normalizeUrl(url),
												width: Number.isFinite(width) ? width : 0,
											};
										})
										.filter((item) => item.url);
								};

								const add = (rawUrl, meta = {}) => {
									const url = normalizeUrl(rawUrl);
									if (!url) return;
									const existing = byUrl.get(url) || {
										url,
										sources: [],
										score: 0,
										width: 0,
										height: 0,
										alt: "",
									};
									existing.sources = Array.from(
										new Set([...existing.sources, ...(meta.sources || [])]),
									);
									existing.width = Math.max(
										existing.width || 0,
										meta.width || 0,
									);
									existing.height = Math.max(
										existing.height || 0,
										meta.height || 0,
									);
									if (meta.alt && !existing.alt)
										existing.alt = String(meta.alt).slice(0, 180);
									let score = existing.score || 0;
									if (imageExtRe.test(url)) score += 2;
									if (
										(meta.width || 0) >= minWidth ||
										(meta.height || 0) >= minWidth
									)
										score += 3;
									if ((meta.width || 0) >= 600 || (meta.height || 0) >= 600)
										score += 3;
									if (
										/listing|product|image|photo|il_\d+x|i\.etsystatic\.com/i.test(
											url,
										)
									)
										score += 4;
									if (
										/avatar|logo|icon|sprite|favicon|badge|tracking|pixel/i.test(
											url,
										)
									)
										score -= 6;
									if (meta.source === "json" || meta.source === "og")
										score += 2;
									existing.score = Math.max(existing.score || 0, score);
									byUrl.set(url, existing);
								};

								for (const img of Array.from(document.images)) {
									const rect = img.getBoundingClientRect?.() || {
										width: 0,
										height: 0,
									};
									const meta = {
										sources: ["img"],
										source: "img",
										width: Math.max(img.naturalWidth || 0, rect.width || 0),
										height: Math.max(img.naturalHeight || 0, rect.height || 0),
										alt: img.alt || img.getAttribute("aria-label") || "",
									};
									add(img.currentSrc || img.src, meta);
									for (const attr of [
										"data-src",
										"data-original",
										"data-full",
										"data-full-image",
										"data-zoom-image",
										"data-image",
										"data-image-url",
									]) {
										add(img.getAttribute(attr), {
											...meta,
											sources: [`img:${attr}`],
										});
									}
									for (const candidate of parseSrcset(img.srcset)) {
										add(candidate.url, {
											...meta,
											sources: ["img:srcset"],
											width: candidate.width || meta.width,
										});
									}
								}

								for (const source of Array.from(
									document.querySelectorAll("picture source, source[srcset]"),
								)) {
									for (const candidate of parseSrcset(
										source.getAttribute("srcset"),
									)) {
										add(candidate.url, {
											sources: ["source:srcset"],
											source: "source",
											width: candidate.width,
										});
									}
								}

								for (const meta of Array.from(
									document.querySelectorAll(
										'meta[property="og:image"], meta[name="twitter:image"], meta[property="og:image:secure_url"]',
									),
								)) {
									add(meta.getAttribute("content"), {
										sources: ["meta"],
										source: "og",
										width: 1200,
										height: 800,
									});
								}

								for (const a of Array.from(
									document.querySelectorAll("a[href]"),
								)) {
									const href = a.getAttribute("href");
									if (href && imageExtRe.test(href))
										add(href, { sources: ["anchor"], source: "anchor" });
								}

								for (const el of Array.from(
									document.querySelectorAll("[style]"),
								)) {
									const style = el.getAttribute("style") || "";
									for (const match of style.matchAll(
										/url\(["']?([^"')]+)["']?\)/gi,
									)) {
										add(match[1], {
											sources: ["inline-style"],
											source: "style",
										});
									}
								}

								for (const script of Array.from(document.scripts).slice(
									0,
									80,
								)) {
									const text = script.textContent || "";
									if (
										!/image|photo|jpg|jpeg|png|webp|avif|etsystatic/i.test(text)
									)
										continue;
									for (const match of text.matchAll(urlImageRe)) {
										add(match[0], {
											sources: ["script"],
											source: "json",
											width: 1000,
											height: 1000,
										});
									}
								}

								const images = Array.from(byUrl.values())
									.filter((img) => img.score > -2)
									.sort(
										(a, b) =>
											b.score - a.score ||
											b.width * b.height - a.width * a.height,
									)
									.slice(0, limit)
									.map((img, index) => ({ index: index + 1, ...img }));

								return {
									title: document.title,
									url: location.href,
									count: images.length,
									images,
								};
							},
							{ limit, minWidth },
						);

						const blockOutput = blockDetection?.output
							? `${blockDetection.output}\n\n`
							: "";
						return {
							success: true,
							output: `${blockOutput}Extracted ${result.count} image candidates from ${result.url}\nPage: ${result.title}\n\n${JSON.stringify(result.images, null, 2)}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_snapshot",
				description:
					"Take an accessibility tree snapshot of the current page. Returns a structured view of all visible interactive elements with unique UIDs (uid-0, uid-1, etc.) that can be used with browser_click_uid and browser_fill_uid. ALWAYS prefer this over browser_get_elements or browser_read_page for understanding the page structure and deciding next actions.",
				uiIcon: BROWSER_SVG,
				parameters: {},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						const blockOutput = blockDetection?.output
							? `${blockDetection.output}\n\n`
							: "";

						const { output } = await this.buildSnapshotWithUidMap();
						return {
							success: true,
							output: `${blockOutput}Accessibility tree snapshot:\n${output}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_click_uid",
				description:
					"Click an element on the page using its accessibility tree UID (from browser_snapshot). This is the PRIMARY way to click elements - always prefer this over browser_click with CSS selectors. Use browser_snapshot first to get the UID, then click with it.",
				uiIcon: BROWSER_SVG,
				parameters: {
					uid: {
						type: "string",
						description:
							"The UID of the element to click (e.g. 'uid-5'), obtained from browser_snapshot",
						required: true,
					},
					waitForNavigation: {
						type: "boolean",
						description:
							"If true, wait for page navigation to complete after clicking. Defaults to false.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection) {
							return { success: true, output: blockDetection.output };
						}
						const { uid, waitForNavigation } = params;
						if (typeof uid !== "string" || !/^uid-\d+$/.test(uid)) {
							return {
								success: false,
								output: "",
								error: `Invalid uid parameter: "${uid}". Must match pattern uid-N (e.g. uid-0, uid-5). Run browser_snapshot first.`,
							};
						}

						const { selector, snapshotOutput, fromCache } =
							await this.getUidSelector(uid);
						if (!selector) {
							return {
								success: false,
								output: "",
								error: `UID "${uid}" not found in current accessibility tree. The page may have changed. Run browser_snapshot again to get fresh UIDs.\n\nCurrent snapshot:\n${snapshotOutput}`,
							};
						}

						const clickAction = async () => {
							await this.humanClick(selector);
						};

						if (waitForNavigation) {
							await Promise.all([
								this.page
									.waitForLoadState("networkidle", { timeout: 15000 })
									.catch(() => {}),
								clickAction(),
							]);
							await this.autoAcceptCookies();
							await this.saveSessionForCurrentPage();
						} else {
							await clickAction();
							await this.autoAcceptCookies();
							await this.saveSessionForCurrentPage();
						}
						this.invalidateSnapshotCache();

						const { output: newSnapshot } =
							await this.buildSnapshotWithUidMap();
						return {
							success: true,
							output: `Clicked element ${uid} (selector: ${selector}, ${fromCache ? "cached snapshot" : "fresh snapshot"}).${waitForNavigation ? " Waited for navigation." : ""}\n\nUpdated accessibility tree:\n${newSnapshot}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_fill_uid",
				description:
					"Fill text into an input/textarea element using its accessibility tree UID (from browser_snapshot). This is the PRIMARY way to fill form fields - always prefer this over browser_type with CSS selectors. Use browser_snapshot first to get the UID, then fill with it.",
				uiIcon: BROWSER_SVG,
				parameters: {
					uid: {
						type: "string",
						description:
							"The UID of the input element (e.g. 'uid-3'), obtained from browser_snapshot",
						required: true,
					},
					value: {
						type: "string",
						description: "The text value to fill into the element",
						required: true,
					},
					submit: {
						type: "boolean",
						description:
							"If true, press Enter after filling the value (useful for search bars). Defaults to false.",
					},
				},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (blockDetection) {
							return { success: true, output: blockDetection.output };
						}
						const { uid, value, submit } = params;
						if (typeof uid !== "string" || !/^uid-\d+$/.test(uid)) {
							return {
								success: false,
								output: "",
								error: `Invalid uid parameter: "${uid}". Must match pattern uid-N (e.g. uid-0, uid-5). Run browser_snapshot first.`,
							};
						}
						if (typeof value !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid value parameter",
							};
						}

						const { selector, snapshotOutput, fromCache } =
							await this.getUidSelector(uid);
						if (!selector) {
							return {
								success: false,
								output: "",
								error: `UID "${uid}" not found in current accessibility tree. The page may have changed. Run browser_snapshot again to get fresh UIDs.\n\nCurrent snapshot:\n${snapshotOutput}`,
							};
						}

						try {
							await this.humanType(selector, value);
						} catch {
							await this.page.evaluate(
								(sel: string, val: string) => {
									const el = document.querySelector(sel) as
										| HTMLInputElement
										| HTMLTextAreaElement;
									if (el) {
										el.value = val;
										el.dispatchEvent(new Event("input", { bubbles: true }));
										el.dispatchEvent(new Event("change", { bubbles: true }));
									} else {
										throw new Error("Element not found in DOM");
									}
								},
								selector,
								value,
							);
						}

						if (submit) {
							await this.page.keyboard.press("Enter");
							await this.page
								.waitForLoadState("networkidle", { timeout: 15000 })
								.catch(() => {});
							await this.autoAcceptCookies();
							await this.saveSessionForCurrentPage();
							this.invalidateSnapshotCache();
							const { output: newSnapshot } =
								await this.buildSnapshotWithUidMap();
							return {
								success: true,
								output: `Filled "${value}" into element ${uid} (selector: ${selector}, ${fromCache ? "cached snapshot" : "fresh snapshot"}) and submitted with Enter.\n\nUpdated accessibility tree:\n${newSnapshot}`,
							};
						}

						this.invalidateSnapshotCache();
						const { output: newSnapshot } =
							await this.buildSnapshotWithUidMap();
						return {
							success: true,
							output: `Filled "${value}" into element ${uid} (selector: ${selector}, ${fromCache ? "cached snapshot" : "fresh snapshot"}).\n\nUpdated accessibility tree:\n${newSnapshot}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
			{
				name: "browser_read_page",
				description:
					"Extract visible text content from the current browser page. Use when page text is needed or navigation result is ambiguous. It does not return images; use browser_extract_images for product/page images.",
				uiIcon: BROWSER_SVG,
				parameters: {},
				handler: async (
					params: Record<string, unknown>,
					context: ToolContext,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const blockDetection = await this.ensureNoBlock(context);
						if (
							blockDetection?.output.includes("DataDome") &&
							!blockDetection.fallbackApplied
						) {
							return {
								success: true,
								output: blockDetection.output,
							};
						}
						const text = await this.page.evaluate(`
							(() => {
								const clone = document.body.cloneNode(true);
								for (const el of clone.querySelectorAll('script, style, noscript, svg, img')) {
									el.remove();
								}
								return (clone.innerText || '')
									.replace(/\\n{3,}/g, '\\n\\n')
									.trim()
									.slice(0, 15000);
							})()
						`);
						const title = await this.page.title();
						const url = this.page.url();
						const blockOutput = blockDetection?.output
							? `${blockDetection.output}\n\n`
							: "";
						return {
							success: true,
							output: `${blockOutput}Page: ${title}\nURL: ${url}\n\n${text || "(empty page)"}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
		];
	}
}
