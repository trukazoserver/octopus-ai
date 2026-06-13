export interface EnvironmentFilterConfig {
	enabled?: boolean;
	allowlist?: string[];
	blocklist?: string[];
}

const DEFAULT_SECRET_ENV_RE =
	/(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|bearer|password|passwd|secret|credential|private[_-]?key|client[_-]?secret|cookie|session)/i;

const DEFAULT_ALLOWLIST = new Set([
	"ALLUSERSPROFILE",
	"APPDATA",
	"COMSPEC",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LOCALAPPDATA",
	"LOGNAME",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PSMODULEPATH",
	"PWD",
	"SHELL",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USER",
	"USERDOMAIN",
	"USERNAME",
	"USERPROFILE",
	"WINDIR",
]);

export class EnvironmentFilter {
	private readonly enabled: boolean;
	private readonly allowlist: Set<string>;
	private readonly blocklist: Set<string>;

	constructor(config: EnvironmentFilterConfig = {}) {
		this.enabled = config.enabled ?? true;
		this.allowlist = new Set([
			...DEFAULT_ALLOWLIST,
			...(config.allowlist ?? []).map((key) => key.toUpperCase()),
		]);
		this.blocklist = new Set(
			(config.blocklist ?? []).map((key) => key.toUpperCase()),
		);
	}

	filter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
		if (!this.enabled) return { ...env };

		const filtered: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) continue;
			if (this.shouldInclude(key)) filtered[key] = value;
		}
		return filtered;
	}

	shouldInclude(key: string): boolean {
		const normalized = key.toUpperCase();
		if (this.blocklist.has(normalized)) return false;
		if (this.allowlist.has(normalized)) return true;
		return !DEFAULT_SECRET_ENV_RE.test(key);
	}
}
