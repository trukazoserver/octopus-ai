import { createHash } from "node:crypto";
import { assertSafeObjectTree } from "../config/object-safety.js";
import type { OctopusConfig } from "../config/schema.js";
import type {
	SettingsSaveRequest,
	SettingsSaveResponse,
	SettingsSectionId,
	SettingsSectionResponse,
	SettingsStatusResponse,
} from "./types.js";

type ConfigKey = keyof OctopusConfig;

interface SectionDefinition {
	id: SettingsSectionId;
	keys: ConfigKey[];
	restartKeys: string[];
}

const SECTIONS: SectionDefinition[] = [
	{ id: "overview", keys: [], restartKeys: [] },
	{ id: "profile", keys: ["mascots"], restartKeys: [] },
	{ id: "usage", keys: [], restartKeys: [] },
	{ id: "providers", keys: ["ai"], restartKeys: [] },
	{ id: "agents", keys: ["orchestration"], restartKeys: [] },
	{ id: "web", keys: ["browser", "webToolsHealth"], restartKeys: [] },
	{ id: "multimedia", keys: ["multimedia"], restartKeys: [] },
	{ id: "skills", keys: ["skills", "learning"], restartKeys: [] },
	{ id: "tools", keys: ["tools"], restartKeys: [] },
	{ id: "mcp", keys: ["mcp"], restartKeys: [] },
	{
		id: "memory",
		keys: ["memory"],
		restartKeys: [
			"memory.shortTerm",
			"memory.longTerm",
			"memory.consolidation",
			"memory.retrieval",
			"memory.retention",
			"memory.embeddings.model",
			"memory.embeddings.dimensions",
		],
	},
	{ id: "connections", keys: ["channels"], restartKeys: [] },
	{ id: "variables", keys: [], restartKeys: [] },
	{ id: "system", keys: ["server", "storage", "connection"], restartKeys: ["server", "storage"] },
	{ id: "security", keys: ["security"], restartKeys: [] },
];

const SECTION_BY_ID = new Map(SECTIONS.map((section) => [section.id, section]));

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a.localeCompare(b),
		);
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function redact(value: unknown, parentKey = ""): unknown {
	if (Array.isArray(value)) {
		if (/args/i.test(parentKey)) {
			let redactNext = false;
			return value.map((item) => {
				if (typeof item !== "string") return redact(item, parentKey);
				if (redactNext) {
					redactNext = false;
					return "[redacted]";
				}
				if (/^(?:--?|\/).*(?:key|token|secret|password|authorization)$/i.test(item)) {
					redactNext = true;
					return item;
				}
				if (/^(?:--?|\/).*(?:key|token|secret|password|authorization)=/i.test(item)) {
					return `${item.slice(0, item.indexOf("=") + 1)}[redacted]`;
				}
				return item;
			});
		}
		return value.map((item) => redact(item, parentKey));
	}
	if (typeof value === "string") {
		try {
			const url = new URL(value);
			if (url.username || url.password || url.search) {
				url.username = "";
				url.password = "";
				for (const key of [...url.searchParams.keys()]) {
					url.searchParams.set(key, "[redacted]");
				}
				return url.toString();
			}
		} catch {
			// Not a URL.
		}
		return value;
	}
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
		const secretContainer = /^(env|headers)$/i.test(parentKey);
		const secretKey =
			/(?:api|access|refresh|encryption|private|signing)?key$|token$|secret$|password$|authorization$|cookie|credentialsjson/.test(
				normalizedKey,
			);
		if (secretContainer || secretKey) {
			if (typeof item === "string" && item.trim()) {
				out[key] = { configured: true };
			} else {
				out[key] = { configured: false };
			}
			continue;
		}
		out[key] = redact(item, key);
	}
	return out;
}

function mergePlain(target: unknown, patch: unknown): unknown {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
	if (!target || typeof target !== "object" || Array.isArray(target)) return clone(patch);
	const result = { ...(target as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		result[key] = mergePlain(result[key], value);
	}
	return result;
}

function restoreRedactedValues(current: unknown, next: unknown): unknown {
	if (next === "[redacted]") return current;
	if (
		typeof current === "string" &&
		typeof next === "string" &&
		next.endsWith("=[redacted]") &&
		current.startsWith(next.slice(0, -"[redacted]".length))
	) {
		return current;
	}
	if (Array.isArray(next)) {
		const currentArray = Array.isArray(current) ? current : [];
		return next.map((item, index) =>
			restoreRedactedValues(currentArray[index], item),
		);
	}
	if (next && typeof next === "object") {
		const nextRecord = next as Record<string, unknown>;
		if (
			Object.keys(nextRecord).length === 1 &&
			typeof nextRecord.configured === "boolean" &&
			(typeof current === "string" || current === undefined)
		) {
			return current;
		}
		const currentRecord =
			current && typeof current === "object" && !Array.isArray(current)
				? (current as Record<string, unknown>)
				: {};
		return Object.fromEntries(
			Object.entries(nextRecord).map(([key, value]) => [
				key,
				restoreRedactedValues(currentRecord[key], value),
			]),
		);
	}
	return next;
}

function changedPaths(previous: unknown, next: unknown, prefix: string): string[] {
	if (stableStringify(previous) === stableStringify(next)) return [];
	if (
		previous &&
		next &&
		typeof previous === "object" &&
		typeof next === "object" &&
		!Array.isArray(previous) &&
		!Array.isArray(next)
	) {
		const previousRecord = previous as Record<string, unknown>;
		const nextRecord = next as Record<string, unknown>;
		const keys = new Set([
			...Object.keys(previousRecord),
			...Object.keys(nextRecord),
		]);
		return [...keys].flatMap((key) =>
			changedPaths(
				previousRecord[key],
				nextRecord[key],
				prefix ? `${prefix}.${key}` : key,
			),
		);
	}
	return [prefix];
}

// Biome allows static service objects elsewhere in the codebase, but this rule
// flags classes with only static members. Keeping this class makes call sites
// explicit and avoids allocating service instances per HTTP request.
// biome-ignore lint/complexity/noStaticOnlyClass: stateless service namespace
export class SettingsService {
	static readonly sectionIds = SECTIONS.map((section) => section.id);

	static isSectionId(value: string): value is SettingsSectionId {
		return SECTION_BY_ID.has(value as SettingsSectionId);
	}

	static revisionFor(value: unknown): string {
		return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
	}

	static getStatus(
		config: OctopusConfig,
		pendingRestartKeys: string[] = [],
	): SettingsStatusResponse {
		return {
			revision: SettingsService.revisionFor(config),
			sections: SECTIONS.map((section) => ({
				id: section.id,
				revision: SettingsService.revisionFor(
					SettingsService.dataForSection(config, section.id),
				),
				requiresRestart: section.restartKeys.length > 0,
				restartKeys: section.restartKeys.map(String),
			})),
			restartRequired: pendingRestartKeys.length > 0,
			restartKeys: [...new Set(pendingRestartKeys)].sort(),
			runtime: {
				server: config.server,
				defaultModel: config.ai.default,
				fallbackModel: config.ai.fallback,
				memoryEnabled: config.memory.enabled,
				skillsEnabled: config.skills.enabled,
				multimediaEnabled: Boolean(config.multimedia?.image.enabled || config.multimedia?.video.enabled),
			},
		};
	}

	static getSection(config: OctopusConfig, id: SettingsSectionId): SettingsSectionResponse {
		const definition = SettingsService.requireDefinition(id);
		const data = redact(SettingsService.dataForSection(config, id));
		return {
			section: id,
			revision: SettingsService.revisionFor(
				SettingsService.dataForSection(config, id),
			),
			data,
			requiresRestart: definition.restartKeys.length > 0,
			restartKeys: definition.restartKeys.map(String),
			warnings: [],
		};
	}

	static applySectionUpdate(
		config: OctopusConfig,
		id: SettingsSectionId,
		request: SettingsSaveRequest,
	): { config: OctopusConfig; changedKeys: string[] } {
		const definition = SettingsService.requireDefinition(id);
		if (definition.keys.length === 0) {
			throw new Error(`Section ${id} is read-only`);
		}
		const currentData = SettingsService.dataForSection(config, id);
		if (
			request.revision &&
			request.revision !== SettingsService.revisionFor(currentData)
		) {
			throw new Error("SETTINGS_REVISION_CONFLICT");
		}
		const proposedData = request.patch !== undefined
			? mergePlain(currentData, request.patch)
			: request.data;
		const nextData = restoreRedactedValues(currentData, proposedData);
		if (!nextData || typeof nextData !== "object") {
			throw new Error("Section payload must be an object");
		}
		assertSafeObjectTree(nextData);

		const nextConfig = clone(config);
		if (definition.keys.length === 1) {
			const key = definition.keys[0];
			(nextConfig as unknown as Record<string, unknown>)[key] = nextData;
			return {
				config: nextConfig,
				changedKeys: changedPaths(config[key], nextData, String(key)),
			};
		}

		const dataRecord = nextData as Record<string, unknown>;
		const changedKeys: string[] = [];
		let includedKeys = 0;
		for (const key of definition.keys) {
			if (Object.hasOwn(dataRecord, key)) {
				includedKeys++;
				(nextConfig as unknown as Record<string, unknown>)[key] = dataRecord[key];
				changedKeys.push(
					...changedPaths(config[key], dataRecord[key], String(key)),
				);
			}
		}
		if (includedKeys === 0) {
			throw new Error(`Section ${id} payload must include one of: ${definition.keys.join(", ")}`);
		}
		return { config: nextConfig, changedKeys };
	}

	static restartKeysForChanges(
		id: SettingsSectionId,
		changedKeys: string[],
	): string[] {
		const definition = SettingsService.requireDefinition(id);
		return definition.restartKeys.filter((restartKey) =>
			changedKeys.some(
				(changedKey) =>
					changedKey === restartKey ||
					changedKey.startsWith(`${restartKey}.`) ||
					restartKey.startsWith(`${changedKey}.`),
			),
		);
	}

	static restartKeysForChangedPaths(changedKeys: string[]): string[] {
		return [...new Set(SECTIONS.flatMap((section) => section.restartKeys))].filter(
			(restartKey) =>
				changedKeys.some(
					(changedKey) =>
						changedKey === restartKey ||
						changedKey.startsWith(`${restartKey}.`) ||
						restartKey.startsWith(`${changedKey}.`),
				),
		);
	}

	static saveResponse(
		config: OctopusConfig,
		id: SettingsSectionId,
		applied: boolean,
		warnings: string[] = [],
	): SettingsSaveResponse {
		const section = SettingsService.getSection(config, id);
		return { ...section, applied, warnings };
	}

	private static requireDefinition(id: SettingsSectionId): SectionDefinition {
		const definition = SECTION_BY_ID.get(id);
		if (!definition) throw new Error(`Unknown settings section: ${id}`);
		return definition;
	}

	private static dataForSection(config: OctopusConfig, id: SettingsSectionId): unknown {
		const definition = SettingsService.requireDefinition(id);
		if (definition.keys.length === 0) {
			return SettingsService.syntheticSection(config, id);
		}
		if (definition.keys.length === 1) {
			return clone(config[definition.keys[0]]);
		}
		const data: Record<string, unknown> = {};
		for (const key of definition.keys) data[key] = clone(config[key]);
		return data;
	}

	private static syntheticSection(config: OctopusConfig, id: SettingsSectionId): unknown {
		switch (id) {
			case "overview":
				return {
					version: config.version,
					server: config.server,
					defaultModel: config.ai.default,
					fallbackModel: config.ai.fallback,
					memoryEnabled: config.memory.enabled,
					skillsEnabled: config.skills.enabled,
					multimedia: config.multimedia,
				};
			case "usage":
				return { source: "/api/usage", quotas: "/api/quotas" };
			case "variables":
				return { source: "/api/env" };
			default:
				return {};
		}
	}
}
