export type DeliveryChannel =
	| "web"
	| "desktop"
	| "cli"
	| "telegram"
	| "whatsapp"
	| "discord"
	| "slack"
	| "api"
	| "internal";

export type TrustProfile =
	| "local_owner"
	| "remote_owner"
	| "trusted_user"
	| "guest"
	| "automation"
	| "background_agent";

export interface DeliveryCapabilities {
	markdown: boolean;
	files: boolean;
	images: boolean;
	audio: boolean;
	video: boolean;
	buttons: boolean;
	localPathsAccessible: boolean;
	maxTextChars: number;
	maxFileBytes: number;
}

export interface DeliveryContext {
	channel: DeliveryChannel;
	principalId: string;
	trustProfile: TrustProfile;
	ownerVerified: boolean;
	destinationId?: string;
	actorId?: string;
	inboundMessageId?: string;
	threadId?: string;
	capabilities: DeliveryCapabilities;
}

const MIB = 1024 * 1024;
const DEFAULTS: Record<DeliveryChannel, DeliveryCapabilities> = {
	web: {
		markdown: true,
		files: true,
		images: true,
		audio: true,
		video: true,
		buttons: true,
		localPathsAccessible: false,
		maxTextChars: 200_000,
		maxFileBytes: 250 * MIB,
	},
	desktop: {
		markdown: true,
		files: true,
		images: true,
		audio: true,
		video: true,
		buttons: true,
		localPathsAccessible: true,
		maxTextChars: 200_000,
		maxFileBytes: 2048 * MIB,
	},
	cli: {
		markdown: true,
		files: true,
		images: false,
		audio: false,
		video: false,
		buttons: false,
		localPathsAccessible: true,
		maxTextChars: 500_000,
		maxFileBytes: 2048 * MIB,
	},
	telegram: {
		markdown: true,
		files: true,
		images: true,
		audio: true,
		video: true,
		buttons: true,
		localPathsAccessible: false,
		maxTextChars: 4096,
		maxFileBytes: 50 * MIB,
	},
	whatsapp: {
		markdown: false,
		files: false,
		images: false,
		audio: false,
		video: false,
		buttons: false,
		localPathsAccessible: false,
		maxTextChars: 65_536,
		maxFileBytes: 64 * MIB,
	},
	discord: {
		markdown: true,
		files: false,
		images: false,
		audio: false,
		video: false,
		buttons: true,
		localPathsAccessible: false,
		maxTextChars: 2000,
		maxFileBytes: 10 * MIB,
	},
	slack: {
		markdown: true,
		files: false,
		images: false,
		audio: false,
		video: false,
		buttons: true,
		localPathsAccessible: false,
		maxTextChars: 40_000,
		maxFileBytes: 1024 * MIB,
	},
	api: {
		markdown: true,
		files: true,
		images: true,
		audio: true,
		video: true,
		buttons: false,
		localPathsAccessible: false,
		maxTextChars: 500_000,
		maxFileBytes: 250 * MIB,
	},
	internal: {
		markdown: true,
		files: true,
		images: true,
		audio: true,
		video: true,
		buttons: false,
		localPathsAccessible: true,
		maxTextChars: 500_000,
		maxFileBytes: 2048 * MIB,
	},
};

export function createDeliveryContext(options: {
	channel: DeliveryChannel;
	principalId?: string;
	trustProfile?: TrustProfile;
	ownerVerified?: boolean;
	destinationId?: string;
	actorId?: string;
	inboundMessageId?: string;
	threadId?: string;
	capabilities?: Partial<DeliveryCapabilities>;
}): DeliveryContext {
	const ownerVerified = options.ownerVerified ?? false;
	return {
		channel: options.channel,
		principalId: options.principalId ?? (ownerVerified ? "owner" : "anonymous"),
		trustProfile:
			options.trustProfile ??
			(ownerVerified
				? options.channel === "cli" || options.channel === "desktop"
					? "local_owner"
					: "remote_owner"
				: "guest"),
		ownerVerified,
		destinationId: options.destinationId,
		actorId: options.actorId,
		inboundMessageId: options.inboundMessageId,
		threadId: options.threadId,
		capabilities: {
			...DEFAULTS[options.channel],
			...(options.capabilities ?? {}),
		},
	};
}

export function asBackgroundDeliveryContext(
	context: DeliveryContext | undefined,
): DeliveryContext | undefined {
	if (!context) return undefined;
	return {
		...context,
		trustProfile: "background_agent",
		capabilities: { ...context.capabilities },
	};
}
