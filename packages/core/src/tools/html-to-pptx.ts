import { chromium } from "playwright";
import pptxgen from "pptxgenjs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { isPathInsideAny, assertRealPathInside, expandHome } from "../utils/path-safety.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";

const SLIDE_WIDTH_INCH = 13.333;
const SLIDE_HEIGHT_INCH = 7.5;

export function createHtmlToPptxTools(
	allowedPaths: string[],
	workspaceDir: string,
): ToolDefinition[] {
	const resolvePath = (filePath: string): string => {
		const expanded = expandHome(filePath);
		if (isAbsolute(expanded)) {
			return resolve(expanded);
		}
		return resolve(workspaceDir, expanded);
	};

	return [
		{
			name: "html_to_pptx",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 8h18M8 21h8M12 17v4"/></svg>`,
			description:
				"Render an HTML file into a polished .pptx presentation. Each element matching the slide selector (default '.slide') is captured as a full-resolution image and placed as a full-slide background. This gives you COMPLETE control over layout, typography, colors, image placement, and visual design using standard HTML/CSS — no rigid templates or schemas. Before calling this tool: (1) Write your slides as an HTML file where each slide is a div with class 'slide' sized to 1280x720px (16:9). (2) Use any CSS you want: grid, flexbox, absolute positioning, gradients, Google Fonts, SVGs, background images. (3) For each slide, decide whether the background image needs text embedded in the image itself (use codex_generate_image with text in the prompt) or whether you will overlay text with HTML/CSS (generate images WITHOUT text). (4) Call this tool pointing to your HTML file. (5) The tool renders each slide in headless Chromium at 2x DPI and composes a clean PPTX. (6) The resulting PPTX will NOT show as 'damaged' in PowerPoint because it contains only images — no complex OOXML objects.",
			parameters: {
				htmlPath: {
					type: "string",
					description:
						"Path to the HTML file containing your slides. Each slide should be a div with class 'slide' (or use slideSelector to customize). Workspace-relative or absolute path.",
					required: true,
				},
				outputPath: {
					type: "string",
					description:
						"Output .pptx path. Workspace-relative or absolute path.",
					required: true,
				},
				slideSelector: {
					type: "string",
					description:
						"CSS selector for slide elements. Default: '.slide'. Each matching element should be 1280x720px for 16:9 output.",
					required: false,
				},
				width: {
					type: "number",
					description:
						"Slide width in pixels. Default: 1280 (for 16:9).",
					required: false,
				},
				height: {
					type: "number",
					description:
						"Slide height in pixels. Default: 720 (for 16:9).",
					required: false,
				},
				scale: {
					type: "number",
					description:
						"Device scale factor for higher resolution. Default: 2 (retina). Use 3 for ultra-high-res.",
					required: false,
				},
				waitFor: {
					type: "string",
					description:
						"CSS selector to wait for before capturing (e.g. 'img.loaded' or '.ready'). Optional.",
					required: false,
				},
				title: {
					type: "string",
					description: "Presentation title metadata.",
					required: false,
				},
				notes: {
					type: "string",
					description:
						"JSON array of speaker notes strings, one per slide. Optional.",
					required: false,
				},
			},
			handler: async (
				params: Record<string, unknown>,
				_context: ToolContext,
			): Promise<ToolResult> => {
				const htmlPath = resolvePath(String(params.htmlPath));
				const outputPath = resolvePath(String(params.outputPath));
				const slideSelector = String(params.slideSelector || ".slide");
				const width = Number(params.width || 1280);
				const height = Number(params.height || 720);
				const scale = Number(params.scale || 2);
				const waitFor = params.waitFor
					? String(params.waitFor)
					: undefined;
				const title = params.title ? String(params.title) : "Presentation";

				const roots = allowedPaths.map((p) => expandHome(p));
				if (!isPathInsideAny(htmlPath, roots)) {
					return {
						success: false,
						output: "",
						error: `HTML path '${htmlPath}' is not within allowed paths`,
					};
				}
				await assertRealPathInside(htmlPath, roots);
				if (!isPathInsideAny(outputPath, [workspaceDir, ...roots])) {
					return {
						success: false,
						output: "",
						error: `Output path '${outputPath}' is not within allowed paths`,
					};
				}
				await mkdir(dirname(outputPath), { recursive: true });

				const htmlContent = await readFile(htmlPath, "utf8");
				if (!htmlContent.trim()) {
					return {
						success: false,
						output: "",
						error: "HTML file is empty",
					};
				}

				let browser;
				try {
					browser = await chromium.launch({
						headless: true,
						args: ["--no-sandbox", "--disable-setuid-sandbox"],
					});
					const context = await browser.newContext({
						viewport: { width, height },
						deviceScaleFactor: scale,
					});
					const page = await context.newPage();

					const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;
					await page.goto(fileUrl, { waitUntil: "networkidle" });

					if (waitFor) {
						await page
							.waitForSelector(waitFor, { timeout: 15_000 })
							.catch(() => {});
					}

					await page.waitForTimeout(500);

					const slideLocator = page.locator(slideSelector);
					const slideCount = await slideLocator.count();

					if (slideCount === 0) {
						await browser.close();
						return {
							success: false,
							output: "",
							error: `No elements found matching selector '${slideSelector}'. Ensure each slide is a <div class="slide"> in your HTML.`,
						};
					}

					const screenshotDir = join(
						dirname(outputPath),
						".html-slide-captures",
					);
					await mkdir(screenshotDir, { recursive: true });

					const screenshots: string[] = [];
					const safeSelector = slideSelector.replace(/'/g, "\\'");

					for (let i = 0; i < slideCount; i++) {
						const screenshotPath = join(
							screenshotDir,
							`slide-${String(i + 1).padStart(3, "0")}.png`,
						);

						await page.evaluate(
							`var _ss='${safeSelector}',_si=${i};var _els=document.querySelectorAll(_ss);_els.forEach(function(e){e.style.display='none';});if(_els[_si]){_els[_si].style.display='flex';}`,
						);

						await page.waitForTimeout(300);

						await page.screenshot({
							path: screenshotPath,
							fullPage: false,
							clip: { x: 0, y: 0, width, height },
						});
						screenshots.push(screenshotPath);
					}

					await browser.close();
					browser = null;

					const PptxGen = pptxgen as unknown as { new (): any };
					const pptx = new PptxGen();
					pptx.defineLayout({
						name: "HTML_SLIDE",
						width: SLIDE_WIDTH_INCH,
						height: SLIDE_HEIGHT_INCH,
					});
					pptx.layout = "HTML_SLIDE";
					pptx.title = title;

					const notesArray: string[] = (() => {
						if (!params.notes) return [];
						try {
							return JSON.parse(String(params.notes));
						} catch {
							return String(params.notes).split("\n");
						}
					})();

					for (let i = 0; i < screenshots.length; i++) {
						const slide = pptx.addSlide();
						slide.background = { path: screenshots[i] };

						if (notesArray[i]) {
							slide.addNotes(notesArray[i]);
						}
					}

					await pptx.writeFile({ fileName: outputPath });

					return {
						success: true,
						output: `PPTX created: ${outputPath}\nSlides: ${screenshots.length}\nResolution: ${width}x${height} @ ${scale}x (${width * scale}x${height * scale}px per slide)\nEach slide is a full-resolution rendered image from your HTML design.\nNext: run office_inspect and office_convert_preview to validate, then import_media_file to publish.`,
					};
				} catch (error) {
					if (browser) await browser.close().catch(() => {});
					return {
						success: false,
						output: "",
						error: error instanceof Error
							? error.message
							: String(error),
					};
				}
			},
		},
	];
}
