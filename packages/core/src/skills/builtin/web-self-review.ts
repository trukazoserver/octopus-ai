import type { Skill } from "../types.js";

export const WEB_SELF_REVIEW_SKILL_ID = "builtin:web-self-review";

const INSTRUCTIONS = `# Web deliverable self-review (visual QA)

Before declaring a web page / HTML deliverable "done", you MUST verify it by
seeing it render. Do not rely on the source code alone — render it, screenshot
it, and judge it with vision. Repeat the loop until it looks right.

## Loop
1. OPEN — open the deliverable with \`browser_open_file\` using the ABSOLUTE
   path returned by \`write_file\` (never just the filename). Confirm the URL is
   \`file://...\` and the page loaded.
2. VERIFY LOAD — use \`browser_snapshot\` / \`browser_read_page\` and
   \`browser_eval\` to check: no broken/missing images (404s), no unstyled
   flash, no JS console errors, all sections present. \`browser_extract_images\`
   to confirm every \`<img>\` resolved.
3. CAPTURE SECTION-BY-SECTION — start at the top, then repeatedly
   \`browser_scroll\` down + \`browser_screenshot\` (viewport, NOT fullPage) to
   capture the hero and each major section separately. Stop at the page bottom.
4. ANALYZE EACH SCREENSHOT WITH VISION:
   - If you are a multimodal model (gpt-5.5 / claude / gemini): the screenshot
     is already in your context above — inspect it directly.
   - If you are a TEXT-ONLY model (e.g. GLM/z.ai): call the \`analyze_image\`
     MCP tool with the screenshot path returned by \`browser_screenshot\`.
   Judge against a concrete checklist: layout & alignment, broken/missing/
   stretched images, text overflow or overlap, contrast & readability, spacing,
   visual hierarchy, responsiveness at the captured viewport, and whether it
   matches the user's stated style (colors, mood, e.g. "green glam").
5. FIX — for each flaw, edit the HTML/CSS/assets with \`write_file\`. Re-create
   any image with \`codex_generate_image {path:"<relative>"}\` and reference it
   by relative path — NEVER embed images as base64 data URIs (it bloats the file
   and breaks the conversation).
6. RE-VERIFY — re-open / re-scroll + re-screenshot ONLY the fixed section and
   confirm the flaw is gone. One fix can introduce another, so glance at neighbors.
7. FINISH only when the page renders cleanly end-to-end. If something is not
   auto-fixable, state it explicitly. Always tell the user the absolute path of
   the final file and a preview screenshot.

## Rules
- This runs for ANY page you create or meaningfully edit (.html / web app / landing).
- A pass requires having SEEN it render, not just having written it.
- Keep it efficient: 3-6 section screenshots is enough for most pages; don't loop
  more than ~3 full passes. Prefer targeted re-screenshots after a fix.`;

/**
 * Built-in "web self-review" skill — a visual QA loop the agent follows for any
 * web/HTML deliverable: open, screenshot section-by-section, analyze with vision
 * (its own multimodal capability, or the analyze_image MCP for text-only models),
 * fix detected flaws, and re-verify. Seeded into the SkillRegistry on startup.
 */
export function buildWebSelfReviewSkill(embedding: number[]): Skill {
	return {
		id: WEB_SELF_REVIEW_SKILL_ID,
		name: "web-self-review",
		version: "1.0.0",
		description:
			"Visually self-review a generated web page: open it, screenshot each section, analyze with vision, fix flaws, and re-verify before declaring done.",
		tags: ["web", "html", "review", "qa", "vision", "design", "frontend"],
		embedding,
		instructions: INSTRUCTIONS,
		examples: [],
		templates: [],
		triggerConditions: {
			keywords: [
				"website",
				"web",
				"html",
				"page",
				"landing",
				"review",
				"verify",
				"qa",
				"preview",
				"design",
				"boda",
				"invitacion",
				"frontend",
			],
			taskPatterns: [],
			domains: ["web", "frontend", "design"],
		},
		contextEstimate: {
			instructions: INSTRUCTIONS.length,
			perExample: 0,
			templates: 0,
		},
		metrics: {
			timesUsed: 0,
			successRate: 0,
			avgUserRating: 0,
			lastUsed: new Date(0).toISOString(),
			improvementsCount: 0,
			createdAt: new Date(0).toISOString(),
		},
		quality: { completeness: 1, accuracy: 1, clarity: 1 },
		dependencies: [],
		related: [],
	};
}
