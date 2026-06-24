import type { AgentReasoningEffort } from "../agent/types.js";
import { getProviderRegistry } from "./router.js";

/**
 * Model-capability metadata used to drive per-agent reasoning controls in the UI
 * and to validate reasoning effort before it is persisted onto an agent profile.
 *
 * Based on the provider registry (`supportsReasoning`, `displayName`) plus a small
 * denylist of model-name patterns that never support adjustable reasoning even on a
 * reasoning-capable provider.
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

const ALL_EFFORTS: AgentReasoningEffort[] = ["none", "low", "medium", "high"];

// Bare model-name substrings that never support adjustable reasoning, regardless of
// whether the provider does. Keep conservative: false positives only hide a selector.
const NON_REASONING_MODEL_PATTERNS = [
	"flash-lite",
	"gpt-4o-mini",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-image",
	"dall-e",
	"tts-",
	"whisper",
	"embed",
	"o1-mini",
];

function modelSupportsReasoning(
	providerSupports: boolean,
	model: string,
): boolean {
	if (!providerSupports) return false;
	const lower = (model ?? "").toLowerCase();
	return !NON_REASONING_MODEL_PATTERNS.some((p) => lower.includes(p));
}

export function getModelCapabilities(
	provider: string,
	model: string,
): ModelCapabilityInfo {
	const registry = getProviderRegistry();
	const entry = registry[provider];
	const providerDisplayName = entry?.displayName ?? provider;
	const supports = modelSupportsReasoning(
		entry?.supportsReasoning ?? false,
		model,
	);
	return {
		provider,
		providerDisplayName,
		model,
		supportsReasoning: supports,
		allowedReasoningEfforts: supports ? ALL_EFFORTS : ["none"],
		defaultReasoningEffort: supports ? "medium" : "none",
	};
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
	const registry = getProviderRegistry();
	for (const [provider, entry] of Object.entries(registry)) {
		if (entry.defaultModels.includes(modelRef)) {
			return { provider, model: modelRef };
		}
	}
	return null;
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
