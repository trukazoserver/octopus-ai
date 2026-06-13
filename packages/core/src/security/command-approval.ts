export type CommandApprovalMode = "manual" | "smart" | "off";

export interface CommandApprovalConfig {
	mode?: CommandApprovalMode;
	timeoutMs?: number;
	allowlist?: string[];
	sessionAllowlist?: string[];
}

export interface CommandDecision {
	allowed: boolean;
	reason?: string;
	requiresApproval?: boolean;
	blockedByHardPolicy?: boolean;
}

interface CommandPattern {
	pattern: RegExp;
	reason: string;
}

const HARD_BLOCKLIST: CommandPattern[] = [
	{
		pattern: /rm\s+-rf\s+(?:\/|~)(?:\s|$)/i,
		reason: "recursive deletion of root or home",
	},
	{ pattern: /:\(\)\{\s*:\|:&\s*\}/, reason: "fork bomb" },
	{ pattern: /\bformat\s+[a-zA-Z]:/i, reason: "disk format" },
	{ pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i, reason: "filesystem creation" },
	{
		pattern: /\bdd\s+if=.*\bof=\s*(?:\/dev\/|[a-zA-Z]:)/i,
		reason: "raw disk overwrite",
	},
	{
		pattern: /\bchmod\s+-R\s+777\s+(?:\/|~)(?:\s|$)/i,
		reason: "unsafe recursive permission change",
	},
	{
		pattern: /\bchown\s+-R\s+(?:\/|~)(?:\s|$)/i,
		reason: "unsafe recursive ownership change",
	},
	{ pattern: /\bmv\s+\/\s+/i, reason: "moving filesystem root" },
	{ pattern: /\bkill\s+-9\s+1\b/i, reason: "killing init process" },
	{
		pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i,
		reason: "host power operation",
	},
	{
		pattern: /\b(?:del|erase)\s+\/[sSqQ]\s+(?:[a-zA-Z]:\\|\\)/i,
		reason: "recursive system deletion",
	},
	{
		pattern: /\brd\s+\/[sSqQ]\s+(?:[a-zA-Z]:\\|\\)/i,
		reason: "recursive system directory deletion",
	},
];

const SMART_APPROVAL_PATTERNS: CommandPattern[] = [
	{ pattern: /\b(?:sudo|su|runas)\b/i, reason: "privilege escalation" },
	{
		pattern: /\b(?:rm|del|erase|rd|rmdir)\b/i,
		reason: "destructive file operation",
	},
	{
		pattern: /\b(?:curl|wget|irm|iwr)\b.*\|\s*(?:sh|bash|pwsh|powershell)/i,
		reason: "remote script execution",
	},
	{
		pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|add|install)\b/i,
		reason: "package mutation",
	},
	{
		pattern:
			/\b(?:git\s+push|git\s+reset|git\s+clean|git\s+checkout\s+--|git\s+rebase)\b/i,
		reason: "git history or workspace mutation",
	},
	{
		pattern: /\b(?:docker|podman)\s+(?:run|exec).*--privileged\b/i,
		reason: "privileged container execution",
	},
];

export class CommandApprovalService {
	private readonly config: Required<CommandApprovalConfig>;

	constructor(config: CommandApprovalConfig = {}) {
		this.config = {
			mode: config.mode ?? "smart",
			timeoutMs: config.timeoutMs ?? 30000,
			allowlist: config.allowlist ?? [],
			sessionAllowlist: config.sessionAllowlist ?? [],
		};
	}

	evaluate(command: string): CommandDecision {
		const hardBlock = this.match(command, HARD_BLOCKLIST);
		if (hardBlock) {
			return {
				allowed: false,
				reason: `Command blocked by hard security policy: ${hardBlock.reason}`,
				blockedByHardPolicy: true,
			};
		}

		if (this.isAllowlisted(command)) return { allowed: true };
		if (this.config.mode === "off") return { allowed: true };

		if (this.config.mode === "manual") {
			return {
				allowed: false,
				requiresApproval: true,
				reason: "Command requires manual approval",
			};
		}

		const smartMatch = this.match(command, SMART_APPROVAL_PATTERNS);
		if (smartMatch) {
			return {
				allowed: false,
				requiresApproval: true,
				reason: `Command requires approval: ${smartMatch.reason}`,
			};
		}

		return { allowed: true };
	}

	private isAllowlisted(command: string): boolean {
		const normalized = command.trim();
		return [...this.config.allowlist, ...this.config.sessionAllowlist].some(
			(allowed) => allowed.trim() === normalized,
		);
	}

	private match(
		command: string,
		patterns: CommandPattern[],
	): CommandPattern | undefined {
		return patterns.find(({ pattern }) => pattern.test(command));
	}
}

export function isCommandHardBlocked(command: string): boolean {
	return (
		new CommandApprovalService({ mode: "off" }).evaluate(command)
			.blockedByHardPolicy === true
	);
}
