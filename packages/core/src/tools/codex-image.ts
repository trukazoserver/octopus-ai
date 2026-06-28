/**
 * codex_generate_image — generate images via the OpenAI Codex backend using the
 * ChatGPT-account access_token (same auth as the Codex text provider). Mirrors
 * the Codex CLI image endpoint: POST {codex}/images/generations.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { ConfigLoader } from "../config/loader.js";
import { mediaContext } from "./media.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const CODEX_BASE_URL =
	process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex";

/**
 * Default workspace root (matches the filesystem tools' default). Overridable
 * via OCTOPUS_WORKSPACE_DIR for tests / non-standard installs.
 */
const WORKSPACE_DIR =
	process.env.OCTOPUS_WORKSPACE_DIR || join(homedir(), ".octopus", "workspace");

const IMAGE_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

export function createCodexImageTools(): ToolDefinition[] {
	return [
		{
			name: "codex_generate_image",
			description:
				"Generate one or more images from a text prompt using the OpenAI Codex backend (your ChatGPT/Codex account). Requires Codex login. By default returns the saved image URL(s) in the Octopus media library. For images that must appear in a generated HTML/site, pass `path` so the image is saved next to the HTML and referenced by relative path — do NOT embed images as base64 data URIs in HTML, it bloats the file and breaks the conversation context.",
			uiIcon: IMAGE_SVG,
			parameters: {
				prompt: {
					type: "string",
					description: "A description of the image(s) to generate.",
					required: true,
				},
				model: {
					type: "string",
					description: "Image model (default: gpt-image-2).",
					required: false,
				},
				size: {
					type: "string",
					description:
						"Image size, e.g. '1024x1024', '1024x1536', 'auto' (default: 1024x1024).",
					required: false,
				},
				n: {
					type: "number",
					description: "Number of images to generate (default: 1, max 4).",
					required: false,
				},
				quality: {
					type: "string",
					description: "auto | low | medium | high (default: auto).",
					required: false,
				},
				path: {
					type: "string",
					description:
						"Optional destination path relative to the Octopus workspace (e.g. 'boda/assets/hero.png'). When set, the image is written there (next to a generated HTML) and the tool returns that relative path (forward slashes) for use in <img src=\"...\">. If n>1, an index suffix is added before the extension. Omit to save to the media library instead.",
					required: false,
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const prompt = String(params.prompt ?? "").trim();
				if (!prompt) {
					return { success: false, output: "", error: "Missing 'prompt'." };
				}
				const model = String(params.model ?? "gpt-image-2");
				const size = String(params.size ?? "1024x1024");
				const n = Math.min(Math.max(Number(params.n ?? 1) || 1, 1), 4);
				const quality = String(params.quality ?? "auto");
				const destPath = params.path ? String(params.path).trim() : "";

				// Credentials live under the openai provider (Codex login).
				const openai = new ConfigLoader().load().ai.providers.openai;
				const accessToken = openai.accessToken;
				const accountId = openai.accountId;
				if (!accessToken || openai.authMode !== "codex") {
					return {
						success: false,
						output: "",
						error:
							"Codex login is required. Sign in with your OpenAI account first.",
					};
				}

				const headers: Record<string, string> = {
					Authorization: `Bearer ${accessToken.replace(/^Bearer\s+/i, "")}`,
					"content-type": "application/json",
					originator: "codex_cli_rs",
				};
				if (accountId) headers.chatgpt_account_id = accountId;

				let response: Response;
				try {
					response = await fetch(`${CODEX_BASE_URL}/images/generations`, {
						method: "POST",
						headers,
						body: JSON.stringify({ prompt, model, n, size, quality }),
						// Image generation can take a while (high-quality gpt-image
						// runs reach ~60-120s), but a hung request must not pin the
						// agent turn forever. 180s is generous; an abort surfaces as
						// a normal tool error the model can retry by calling again.
						signal: AbortSignal.timeout(180000),
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const aborted = /aborted|timeout|timed out|TimeoutError/i.test(msg);
					console.error(
						`[codex-image] request failed (prompt=${prompt.slice(0, 80)}): ${msg}`,
					);
					return {
						success: false,
						output: "",
						error: aborted
							? "Codex image request timed out (no response in 180s). The service may be overloaded — retry shortly."
							: `Codex image request failed: ${msg}`,
					};
				}
				if (!response.ok) {
					const text = await response.text().catch(() => response.statusText);
					console.error(
						`[codex-image] API error ${response.status} (prompt=${prompt.slice(0, 80)}): ${text.slice(0, 300)}`,
					);
					return {
						success: false,
						output: "",
						error: `Codex image API error (${response.status}): ${text.slice(0, 300)}`,
					};
				}

				const json = (await response.json()) as {
					data?: Array<{ b64_json?: string; url?: string }>;
				};

				// Resolve a workspace-relative destination once (so the agent can
				// save images next to a generated HTML and reference them by
				// relative path instead of embedding base64 data URIs).
				let destAbs = "";
				let destStem = "";
				let destExt = ".png";
				if (destPath) {
					const abs = resolve(
						isAbsolute(destPath) ? destPath : resolve(WORKSPACE_DIR, destPath),
					);
					const rel = relative(WORKSPACE_DIR, abs);
					if (rel.startsWith("..") || isAbsolute(rel)) {
						return {
							success: false,
							output: "",
							error: `Destination path '${destPath}' escapes the Octopus workspace. Use a relative path inside the workspace (e.g. 'site/assets/hero.png').`,
						};
					}
					destAbs = abs;
					destExt = extname(abs) || ".png";
					destStem = abs.slice(0, abs.length - destExt.length);
				}

				const urls: string[] = [];
				for (const [idx, item] of (json.data ?? []).entries()) {
					try {
						let buffer: Buffer | undefined;
						if (item.b64_json) {
							buffer = Buffer.from(item.b64_json, "base64");
						} else if (item.url) {
							const imgResp = await fetch(item.url);
							if (imgResp.ok) buffer = Buffer.from(await imgResp.arrayBuffer());
						}
						if (!buffer) continue;
						if (destPath) {
							// Write into the workspace (next to the HTML). For n>1,
							// suffix with an index before the extension.
							const finalAbs =
								idx === 0 ? destAbs : `${destStem}_${idx + 1}${destExt}`;
							mkdirSync(dirname(finalAbs), { recursive: true });
							writeFileSync(finalAbs, buffer);
							const relPath = relative(WORKSPACE_DIR, finalAbs)
								.split("\\")
								.join("/");
							urls.push(relPath);
						} else {
							const saved = await mediaContext.save(
								buffer,
								"image/png",
								prompt,
								{ provider: "codex", model, prompt, size },
							);
							urls.push(saved.url);
						}
					} catch {
						// skip a failed image in a batch
					}
				}

				if (urls.length === 0) {
					return {
						success: false,
						output: "",
						error: "Codex image API returned no image data.",
					};
				}
				return {
					success: true,
					output: urls.map((u, i) => `Image ${i + 1}: ${u}`).join("\n"),
					metadata: { count: urls.length, urls, model, prompt },
				};
			},
		},
	];
}
