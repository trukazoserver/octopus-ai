import { OCTOPUS_ARM_PROFILES } from "./arm-profiles.js";
import type { OctopusArmProfile } from "./arm-profiles.js";

const CAPABILITY_HINTS: Array<[string, string[]]> = [
	["cali", ["image", "video", "audio", "media", "storyboard", "creative", "prompt"]],
	["ari", ["code", "coding", "debug", "script", "test", "refactor", "automation"]],
	["langi", ["research", "web", "source", "documentation", "search", "investigate"]],
	["crabby", ["qa", "security", "review", "risk", "validate", "verify", "test"]],
	["anita", ["memory", "knowledge", "rag", "context", "document", "kb"]],
	["medi", ["vision", "ocr", "diagram", "screenshot", "chart", "dashboard", "visual"]],
	["estelita", ["write", "summary", "synthesis", "report", "document", "explain"]],
	["bibi", ["plan", "task", "workflow", "coordinate", "checkpoint", "schedule"]],
];

export function routeTaskToArm(input: {
	role?: string;
	description?: string;
	toolScope?: string[];
}): OctopusArmProfile {
	const haystack = [
		input.role ?? "",
		input.description ?? "",
		...(input.toolScope ?? []),
	]
		.join(" ")
		.toLowerCase();

	let bestKey = "bibi";
	let bestScore = -1;
	for (const [key, hints] of CAPABILITY_HINTS) {
		const score = hints.reduce(
			(total, hint) => total + (haystack.includes(hint) ? 1 : 0),
			0,
		);
		if (score > bestScore) {
			bestKey = key;
			bestScore = score;
		}
	}

	return (
		OCTOPUS_ARM_PROFILES.find((profile) => profile.key === bestKey) ??
		OCTOPUS_ARM_PROFILES[0]
	);
}
