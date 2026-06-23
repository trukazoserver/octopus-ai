/**
 * codex_generate_image — generate images via the OpenAI Codex backend using the
 * ChatGPT-account access_token (same auth as the Codex text provider). Mirrors
 * the Codex CLI image endpoint: POST {codex}/images/generations.
 */
import { ConfigLoader } from "../config/loader.js";
import { mediaContext } from "./media.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const CODEX_BASE_URL =
	process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex";

const IMAGE_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

export function createCodexImageTools(): ToolDefinition[] {
	return [
		{
			name: "codex_generate_image",
			description:
				"Generate one or more images from a text prompt using the OpenAI Codex backend (your ChatGPT/Codex account). Requires Codex login. Returns the saved image URL(s) in the Octopus media library.",
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

				// Credentials live under the openai provider (Codex login).
				const openai = new ConfigLoader().load().ai.providers.openai;
				const accessToken = openai.accessToken;
				const accountId = openai.accountId;
				if (!accessToken || openai.authMode !== "codex") {
					return {
						success: false,
						output: "",
						error: "Codex login is required. Sign in with your OpenAI account first.",
					};
				}

				const headers: Record<string, string> = {
					Authorization: `Bearer ${accessToken.replace(/^Bearer\s+/i, "")}`,
					"content-type": "application/json",
					originator: "codex_cli_rs",
				};
				if (accountId) headers["chatgpt_account_id"] = accountId;

				let response: Response;
				try {
					response = await fetch(`${CODEX_BASE_URL}/images/generations`, {
						method: "POST",
						headers,
						body: JSON.stringify({ prompt, model, n, size, quality }),
					});
				} catch (err) {
					return {
						success: false,
						output: "",
						error: `Codex image request failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
				if (!response.ok) {
					const text = await response.text().catch(() => response.statusText);
					return {
						success: false,
						output: "",
						error: `Codex image API error (${response.status}): ${text.slice(0, 300)}`,
					};
				}

				const json = (await response.json()) as {
					data?: Array<{ b64_json?: string; url?: string }>;
				};
				const urls: string[] = [];
				for (const item of json.data ?? []) {
					try {
						let buffer: Buffer | undefined;
						if (item.b64_json) {
							buffer = Buffer.from(item.b64_json, "base64");
						} else if (item.url) {
							const imgResp = await fetch(item.url);
							if (imgResp.ok) buffer = Buffer.from(await imgResp.arrayBuffer());
						}
						if (!buffer) continue;
						const saved = await mediaContext.save(buffer, "image/png", prompt, {
							provider: "codex",
							model,
							prompt,
							size,
						});
						urls.push(saved.url);
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
