import type { AgentReasoningEffort } from "../agent/types.js";
import { getProviderRegistry } from "./router.js";

/**
 * Model-capability metadata used to drive per-agent reasoning controls in the UI
 * and to validate reasoning effort before it is persisted onto an agent profile.
 *
 * Reasoning capability is NOT uniform across models — it is resolved from a
 * per-model profile table (verified against each provider's developer docs,
 * June 2026) with a provider-level fallback. Two things vary by model:
 *   1. Whether it reasons at all (gpt-4o, gpt-4.1, embeddings, images … do not).
 *   2. Which discrete effort levels it exposes (gpt-5.x adds "xhigh"; the
 *      o-series only offers low/medium/high because they always reason).
 */

export interface ModelCapabilityInfo {
	provider: string;
	providerDisplayName: string;
	model: string;
	supportsReasoning: boolean;
	/** Effort levels the UI may offer for this model. ["none"] when unsupported. */
	allowedReasoningEfforts: AgentReasoningEffort[];
	/** Sensible default effort when none is configured yet. */
	defaultReasoningEffort: AgentReasoningEffort;
}

type Profile = {
	supports: boolean;
	efforts: AgentReasoningEffort[];
	def: AgentReasoningEffort;
};

// Reusable profiles.
const NONE: Profile = { supports: false, efforts: ["none"], def: "none" };
// OpenAI gpt-5.5 / gpt-5.4 (incl. mini/nano/pro) — verified "none low medium
// high xhigh" on developers.openai.com/api/docs/models.
const GPT5_FLAGSHIP: Profile = {
	supports: true,
	efforts: ["none", "low", "medium", "high", "xhigh"],
	def: "medium",
};
// Other gpt-5.x flagships (5, 5.1, 5.2, 5.3, mini, nano) — low/medium/high (+none).
const GPT5: Profile = {
	supports: true,
	efforts: ["none", "low", "medium", "high"],
	def: "medium",
};
// OpenAI o-series (o3, o4-mini, o3-mini) — always reason; no "none", no "xhigh".
const O_SERIES: Profile = {
	supports: true,
	efforts: ["low", "medium", "high"],
	def: "medium",
};
// Default abstraction for reasoning-capable providers whose discrete "effort"
// selector maps to a thinking budget or on/off flag (Claude, Gemini, GLM, Grok,
// DeepSeek, Mistral, Cohere, OpenRouter).
const STANDARD: Profile = {
	supports: true,
	efforts: ["none", "low", "medium", "high"],
	def: "medium",
};
// On/off reasoning: thinking enabled/disabled with no gradation. Used by GLM-4.5+
// (except GLM-5.2), Grok-4.x (model-variant-driven), etc.
const ONOFF: Profile = { supports: true, efforts: ["none", "high"], def: "high" };
// GLM-5.2: the only REAL reasoning-effort tiers are High and Max (z.ai
// `reasoning_effort`; low/medium are compat aliases → High, xhigh → Max). So we
// expose none / High(=high) / Max(=xhigh) and nothing else. (Verified
// docs.z.ai/guides/overview/concept-param.)
const GLM_52: Profile = {
	supports: true,
	efforts: ["none", "high", "xhigh"],
	def: "high",
};

// Model-name patterns → reasoning profile. First match wins, so list more
// specific keys before their prefixes (e.g. "gpt-5.4" before bare "gpt-5").
const MODEL_REASONING_PROFILES: Array<{ match: string; profile: Profile }> = [
	// ── Non-reasoning models (never offer an effort selector) ────────────────
	{ match: "gpt-4o-mini", profile: NONE },
	{ match: "gpt-4o", profile: NONE },
	{ match: "gpt-4.1-mini", profile: NONE },
	{ match: "gpt-4.1-nano", profile: NONE },
	{ match: "gpt-4.1", profile: NONE },
	{ match: "gpt-4-", profile: NONE }, // gpt-4, gpt-4-turbo, gpt-4-0613…
	{ match: "gpt-3.5", profile: NONE },
	{ match: "flash-lite", profile: NONE },
	{ match: "gpt-image", profile: NONE },
	{ match: "dall-e", profile: NONE },
	{ match: "tts-", profile: NONE },
	{ match: "whisper", profile: NONE },
	{ match: "embed", profile: NONE },
	{ match: "nano-banana", profile: NONE },
	// o1 family: always reasons but exposes NO adjustable effort parameter.
	{ match: "o1-mini", profile: NONE },
	{ match: "o1-preview", profile: NONE },
	{ match: "o1", profile: NONE },

	// ── OpenAI gpt-5.x flagships with xhigh ─────────────────────────────────
	{ match: "gpt-5.5", profile: GPT5_FLAGSHIP },
	{ match: "gpt-5.4", profile: GPT5_FLAGSHIP }, // covers -mini/-nano/-pro

	// ── Other gpt-5.x (no xhigh) ────────────────────────────────────────────
	{ match: "gpt-5.3", profile: GPT5 }, // gpt-5.3-codex
	{ match: "gpt-5.2", profile: GPT5 },
	{ match: "gpt-5.1", profile: GPT5 },
	{ match: "gpt-5-mini", profile: GPT5 },
	{ match: "gpt-5-nano", profile: GPT5 },
	{ match: "gpt-5", profile: GPT5 }, // bare gpt-5 — keep after the specific ones

	// ── OpenAI o-series: low/medium/high only (always reason) ───────────────
	{ match: "o4-mini", profile: O_SERIES },
	{ match: "o3-mini", profile: O_SERIES },
	{ match: "o3", profile: O_SERIES },
	{ match: "o4", profile: O_SERIES },

	// ── Zhipu / GLM (verified docs.z.ai/guides/overview/concept-param) ──────
	// GLM-5.2 exposes reasoning_effort (real tiers High/Max); other GLM-4.5+/5.x
	// only support thinking on/off (no reasoning_effort).
	{ match: "glm-5.2", profile: GLM_52 },
	{ match: "glm-5.1", profile: ONOFF },
	{ match: "glm-5-turbo", profile: ONOFF },
	{ match: "glm-5v-turbo", profile: ONOFF },
	{ match: "glm-5", profile: ONOFF },
	{ match: "glm-4.7", profile: ONOFF },
	{ match: "glm-4.6v", profile: ONOFF },
	{ match: "glm-4.6", profile: ONOFF },
	{ match: "glm-4.5", profile: ONOFF },

	// ── xAI Grok (verified docs.x.ai/docs/guides/reasoning) ────────────────
	// reasoning_effort is REJECTED by grok-3/4/4-fast-reasoning (only grok-3-mini
	// accepts it, low/high). Grok-4.x reasoning is inherent to the model variant
	// → on/off (advisory); the provider sends no parameter.
	{
		match: "grok-3-mini",
		profile: { supports: true, efforts: ["low", "high"], def: "high" },
	},
	{ match: "grok", profile: ONOFF },
];

function profileForModel(provider: string, model: string): Profile {
	const lower = (model ?? "").toLowerCase();
	for (const { match, profile } of MODEL_REASONING_PROFILES) {
		if (lower.includes(match)) return profile;
	}
	// Provider-level fallback: reasoning-capable providers get the standard
	// abstraction; non-reasoning providers (e.g. ollama) get NONE.
	const registry = getProviderRegistry();
	return registry[provider]?.supportsReasoning ? STANDARD : NONE;
}

export function getModelCapabilities(
	provider: string,
	model: string,
): ModelCapabilityInfo {
	const registry = getProviderRegistry();
	const entry = registry[provider];
	const profile = profileForModel(provider, model);
	return {
		provider,
		providerDisplayName: entry?.displayName ?? provider,
		model,
		supportsReasoning: profile.supports,
		allowedReasoningEfforts: profile.efforts,
		defaultReasoningEffort: profile.def,
	};
}

/** Resolve a bare model id to a provider via the registry's defaultModels. */
function resolveProviderFromRegistry(model: string): string | null {
	const registry = getProviderRegistry();
	for (const [provider, entry] of Object.entries(registry)) {
		if (entry.defaultModels.includes(model)) return provider;
	}
	return null;
}

/**
 * Resolve which provider a bare or prefixed model ref belongs to, mirroring the
 * router's own resolution: explicit "provider/model" wins, then a provider's
 * configured `models` list, then the registry `defaultModels`.
 */
export function resolveProviderForModel(
	config: { ai: { providers: Record<string, { models?: string[] }> } },
	modelRef: string | undefined,
): { provider: string; model: string } | null {
	if (!modelRef) return null;
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex !== -1) {
		return {
			provider: modelRef.slice(0, slashIndex),
			model: modelRef.slice(slashIndex + 1),
		};
	}
	for (const [provider, providerConfig] of Object.entries(
		config.ai.providers,
	)) {
		const models = Array.isArray(providerConfig.models)
			? providerConfig.models
			: [];
		if (models.includes(modelRef)) {
			return { provider, model: modelRef };
		}
	}
	const resolved = resolveProviderFromRegistry(modelRef);
	return resolved ? { provider: resolved, model: modelRef } : null;
}

export function getModelCapabilitiesFromRef(
	config: { ai: { providers: Record<string, { models?: string[] }> } },
	modelRef: string | undefined,
): ModelCapabilityInfo | null {
	const resolved = resolveProviderForModel(config, modelRef);
	if (!resolved) return null;
	return getModelCapabilities(resolved.provider, resolved.model);
}

/**
 * Lightweight capability lookup from a model ref alone (no providers config),
 * for runtime coercion. Splits "provider/model" or falls back to the registry's
 * defaultModels. Returns null if the provider cannot be determined.
 */
export function getModelCapabilitiesByRef(
	modelRef: string | undefined,
): ModelCapabilityInfo | null {
	if (!modelRef) return null;
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex !== -1) {
		return getModelCapabilities(
			modelRef.slice(0, slashIndex),
			modelRef.slice(slashIndex + 1),
		);
	}
	const provider = resolveProviderFromRegistry(modelRef);
	return provider ? getModelCapabilities(provider, modelRef) : null;
}

/**
 * Validate / coerce a desired effort against a model's capabilities. Unsupported
 * models always resolve to "none"; unknown values fall back to the model default.
 */
export function coerceReasoningEffort(
	capabilities: ModelCapabilityInfo | null,
	desired: AgentReasoningEffort | undefined,
): AgentReasoningEffort {
	if (!capabilities || !capabilities.supportsReasoning) return "none";
	if (desired && capabilities.allowedReasoningEfforts.includes(desired)) {
		return desired;
	}
	return capabilities.defaultReasoningEffort;
}
