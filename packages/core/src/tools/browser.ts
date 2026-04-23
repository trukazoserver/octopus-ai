import fs from "node:fs";
import vanillaPuppeteer from "puppeteer-core";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { ToolDefinition, ToolResult } from "./registry.js";

// biome-ignore lint/suspicious/noExplicitAny: Bypassing type mismatch between puppeteer-extra and new puppeteer-core versions
const puppeteer = addExtra(vanillaPuppeteer as any);
puppeteer.use(StealthPlugin());

const BROWSER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;

export class BrowserTool {
	private config: { executablePath: string };
	// biome-ignore lint/suspicious/noExplicitAny: Puppeteer type
	private browser: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: Puppeteer type
	private page: any = null;

	constructor(config: { executablePath: string }) {
		this.config = config;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const stats = await fs.promises.stat(this.config.executablePath);
			return stats.isFile();
		} catch {
			return false;
		}
	}

	async init(): Promise<void> {
		if (this.browser && this.page) {
			return;
		}

		try {
			this.browser = await puppeteer.launch({
				executablePath: this.config.executablePath,
				headless: true,
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-blink-features=AutomationControlled'
				]
			});
			this.page = await this.browser.newPage();
			// Additional stealth techniques
			await this.page.setBypassCSP(true);
			
			// Optional: Set a common user agent
			await this.page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
		} catch (error) {
			this.browser = null;
			this.page = null;
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.browser) {
			await this.browser.close();
			this.browser = null;
			this.page = null;
		}
	}

	createTools(): ToolDefinition[] {
		return [
			{
				name: "browser_navigate",
				description: "Navigate the browser to a specific URL",
				uiIcon: BROWSER_SVG,
				parameters: {
					url: {
						type: "string",
						description: "The URL to navigate to",
						required: true,
					},
				},
				handler: async (
					params: Record<string, unknown>,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const { url } = params;
						if (typeof url !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid url parameter",
							};
						}
						await this.page.goto(url, { waitUntil: "networkidle2" });
						return {
							success: true,
							output: `Successfully navigated to ${url}`,
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
					"Take a screenshot of the current page and return it as base64",
				uiIcon: BROWSER_SVG,
				parameters: {},
				handler: async (): Promise<ToolResult> => {
					try {
						await this.init();
						const screenshot = await this.page.screenshot({
							encoding: "base64",
						});
						return {
							success: true,
							output: `data:image/png;base64,${screenshot}`,
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
				},
				handler: async (
					params: Record<string, unknown>,
				): Promise<ToolResult> => {
					try {
						await this.init();
						const { selector } = params;
						if (typeof selector !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid selector parameter",
							};
						}
						await this.page.waitForSelector(selector, {
							state: "visible",
							timeout: 5000,
						});
						await this.page.click(selector);
						return {
							success: true,
							output: `Successfully clicked element matching selector: ${selector}`,
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
				description: "Type text into an input element using a CSS selector",
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
				): Promise<ToolResult> => {
					try {
						await this.init();
						const { selector, text } = params;
						if (typeof selector !== "string" || typeof text !== "string") {
							return {
								success: false,
								output: "",
								error: "Missing or invalid selector or text parameters",
							};
						}
						await this.page.waitForSelector(selector, {
							state: "visible",
							timeout: 5000,
						});
						await this.page.type(selector, text);
						return {
							success: true,
							output: `Successfully typed text into element matching selector: ${selector}`,
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
				description: "Execute JavaScript code within the context of the page",
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
						const result = await this.page.evaluate(script);
						return {
							success: true,
							output:
								typeof result === "string"
									? result
									: JSON.stringify(result, null, 2) || "undefined",
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
					"Extract the visible text content from the current browser page. Useful for reading articles, examining search results, or scraping data from websites.",
				uiIcon: BROWSER_SVG,
				parameters: {},
				handler: async (): Promise<ToolResult> => {
					try {
						await this.init();
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
						return {
							success: true,
							output: `Page: ${title}\nURL: ${url}\n\n${text || "(empty page)"}`,
						};
					} catch (error) {
						return {
							success: false,
							output: "",
							error:
								error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
		];
	}
}
