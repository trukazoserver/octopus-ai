import puppeteer from "puppeteer-core";
import fs from "fs";
import type { ToolDefinition, ToolResult } from "./registry.js";

export class BrowserTool {
  private config: { executablePath: string };
  private browser: any = null;
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
      });
      this.page = await this.browser.newPage();
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
        parameters: {
          url: { type: "string", description: "The URL to navigate to", required: true },
        },
        handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
          try {
            await this.init();
            const { url } = params;
            if (typeof url !== "string") {
              return { success: false, output: "", error: "Missing or invalid url parameter" };
            }
            await this.page.goto(url, { waitUntil: "networkidle2" });
            return { success: true, output: `Successfully navigated to ${url}` };
          } catch (error) {
            return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
          }
        },
      },
      {
        name: "browser_screenshot",
        description: "Take a screenshot of the current page and return it as base64",
        parameters: {},
        handler: async (): Promise<ToolResult> => {
          try {
            await this.init();
            const screenshot = await this.page.screenshot({ encoding: "base64" });
            return { success: true, output: `data:image/png;base64,${screenshot}` };
          } catch (error) {
            return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
          }
        },
      },
      {
        name: "browser_click",
        description: "Click an element on the page using a CSS selector",
        parameters: {
          selector: { type: "string", description: "The CSS selector of the element to click", required: true },
        },
        handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
          try {
            await this.init();
            const { selector } = params;
            if (typeof selector !== "string") {
              return { success: false, output: "", error: "Missing or invalid selector parameter" };
            }
            await this.page.waitForSelector(selector, { state: "visible", timeout: 5000 });
            await this.page.click(selector);
            return { success: true, output: `Successfully clicked element matching selector: ${selector}` };
          } catch (error) {
            return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
          }
        },
      },
      {
        name: "browser_type",
        description: "Type text into an input element using a CSS selector",
        parameters: {
          selector: { type: "string", description: "The CSS selector of the input element", required: true },
          text: { type: "string", description: "The text to type", required: true },
        },
        handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
          try {
            await this.init();
            const { selector, text } = params;
            if (typeof selector !== "string" || typeof text !== "string") {
              return { success: false, output: "", error: "Missing or invalid selector or text parameters" };
            }
            await this.page.waitForSelector(selector, { state: "visible", timeout: 5000 });
            await this.page.type(selector, text);
            return { success: true, output: `Successfully typed text into element matching selector: ${selector}` };
          } catch (error) {
            return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
          }
        },
      },
      {
        name: "browser_eval",
        description: "Execute JavaScript code within the context of the page",
        parameters: {
          script: { type: "string", description: "The JavaScript code to execute. Return value will be returned to the tool output.", required: true },
        },
        handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
          try {
            await this.init();
            const { script } = params;
            if (typeof script !== "string") {
              return { success: false, output: "", error: "Missing or invalid script parameter" };
            }
            const result = await this.page.evaluate(script);
            return {
              success: true,
              output: typeof result === "string" ? result : JSON.stringify(result, null, 2) || "undefined",
            };
          } catch (error) {
            return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
          }
        },
      },
    ];
  }
}
