import type { OctopusConfig } from "../config/schema.js";

export type SettingsSectionId =
	| "overview"
	| "profile"
	| "usage"
	| "providers"
	| "agents"
	| "web"
	| "multimedia"
	| "skills"
	| "tools"
	| "mcp"
	| "memory"
	| "connections"
	| "variables"
	| "system"
	| "security";

export interface SettingsSectionResponse<T = unknown> {
	section: SettingsSectionId;
	revision: string;
	data: T;
	requiresRestart: boolean;
	restartKeys: string[];
	warnings: string[];
}

export interface SettingsSaveRequest<T = unknown> {
	revision?: string;
	data?: T;
	patch?: T;
}

export interface SettingsSaveResponse<T = unknown>
	extends SettingsSectionResponse<T> {
	applied: boolean;
}

export interface SettingsStatusResponse {
	revision: string;
	sections: Array<{
		id: SettingsSectionId;
		revision: string;
		requiresRestart: boolean;
		restartKeys: string[];
	}>;
	restartRequired: boolean;
	restartKeys: string[];
	runtime: {
		server: OctopusConfig["server"];
		defaultModel: string;
		fallbackModel: string;
		memoryEnabled: boolean;
		skillsEnabled: boolean;
		multimediaEnabled: boolean;
	};
}
