import type React from "react";
import type { Channel } from "../../hooks/useChannels.js";
import { BrandLogo } from "../ui/BrandLogo.js";

interface ChannelCardProps {
	channel: Channel;
	onToggle: (name: string) => void;
	onTest: (name: string) => void;
	children?: React.ReactNode;
	testing?: boolean;
	canTest?: boolean;
}

const STATUS_CONFIG: Record<
	string,
	{ color: string; bg: string; label: string }
> = {
	connected: {
		color: "#10b981",
		bg: "rgba(16, 185, 129, 0.08)",
		label: "Conectado",
	},
	disconnected: {
		color: "#71717a",
		bg: "rgba(255,255,255,0.05)",
		label: "Desactivado",
	},
	error: { color: "#ef4444", bg: "rgba(239, 68, 68, 0.1)", label: "Error" },
	unconfigured: {
		color: "#f59e0b",
		bg: "rgba(245, 158, 11, 0.1)",
		label: "Sin configurar",
	},
	idle: { color: "#71717a", bg: "rgba(255,255,255,0.05)", label: "Inactivo" },
};

const CHANNEL_BRANDS: Record<
	string,
	{ name: string; domain: string; src?: string; sources?: string[] }
> = {
	telegram: {
		name: "Telegram",
		domain: "telegram.org",
		src: "https://cdn.simpleicons.org/telegram",
	},
	discord: {
		name: "Discord",
		domain: "discord.com",
		src: "https://cdn.simpleicons.org/discord",
	},
	whatsapp: {
		name: "WhatsApp",
		domain: "whatsapp.com",
		src: "https://cdn.simpleicons.org/whatsapp",
	},
	slack: {
		name: "Slack",
		domain: "slack.com",
		src: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/slack.svg",
	},
	teams: {
		name: "Microsoft Teams",
		domain: "microsoft.com",
		src: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/microsoftteams.svg",
	},
	signal: {
		name: "Signal",
		domain: "signal.org",
		src: "https://cdn.simpleicons.org/signal",
	},
	wechat: {
		name: "WeChat",
		domain: "wechat.com",
		src: "https://cdn.simpleicons.org/wechat",
	},
	webchat: { name: "Web Chat", domain: "octopus.local" },
};

export const ChannelCard: React.FC<ChannelCardProps> = ({
	channel,
	onToggle,
	onTest,
	children,
	testing,
	canTest = true,
}) => {
	const statusCfg = STATUS_CONFIG[channel.status] ?? STATUS_CONFIG.idle;
	const statusClass =
		channel.status === "connected"
			? "is-done"
			: channel.status === "error"
				? "is-failed"
				: channel.status === "unconfigured"
					? "is-warning"
					: "is-neutral";
	const brand = CHANNEL_BRANDS[channel.type] ?? {
		name: channel.type,
		domain: channel.type,
	};

	return (
		<div
			className="hover-lift"
			style={{
				padding: "18px",
				borderRadius: "16px",
				background: "rgba(24,24,27,0.6)",
				border: "1px solid #27272a",
				boxShadow: "0 12px 28px rgba(0,0,0,.18)",
				transition: "all 0.2s ease",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					marginBottom: "16px",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
					<BrandLogo
						name={brand.name}
						domain={brand.domain}
						src={brand.src}
						sources={brand.sources}
						size={44}
					/>
					<div>
						<div
							style={{
								fontSize: "1rem",
								fontWeight: 700,
								color: "#f4f4f5",
								textTransform: "capitalize",
							}}
						>
							{channel.name}
						</div>
						<div
							style={{
								fontSize: "0.75rem",
								color: "#a1a1aa",
								textTransform: "uppercase",
								letterSpacing: "0.05em",
							}}
						>
							{channel.type}
						</div>
					</div>
				</div>
				<span className={`ui-status ${statusClass}`}>{statusCfg.label}</span>
			</div>

			{/* Config section (children) */}
			{children && (
				<div style={{ marginBottom: "12px" }}>
					{!channel.enabled && (
						<div
							style={{
								marginBottom: "10px",
								padding: "8px 10px",
								borderRadius: "10px",
								background: "rgba(245, 158, 11, 0.08)",
								border: "1px solid rgba(245, 158, 11, 0.18)",
								color: "#fbbf24",
								fontSize: "0.78rem",
							}}
						>
							Puedes configurar este canal antes de activarlo.
						</div>
					)}
					{children}
				</div>
			)}

			<div
				style={{
					display: "flex",
					gap: "8px",
					marginTop: channel.enabled && children ? "12px" : "0",
				}}
			>
				<button
					type="button"
					onClick={() => onTest(channel.name)}
					disabled={testing || !channel.enabled || !canTest}
					title={
						canTest
							? undefined
							: "Prueba automática no disponible para este canal"
					}
					className="ui-btn ui-btn--secondary"
					style={{ flex: 1, padding: "10px", fontSize: "0.85rem" }}
				>
					{testing
						? "Probando..."
						: canTest
							? "Probar conexión"
							: "Prueba no disponible"}
				</button>
				<button
					type="button"
					onClick={() => onToggle(channel.name)}
					className={`ui-btn ${channel.enabled ? "ui-btn--danger" : "ui-btn--primary"}`}
					style={{ flex: 1, padding: "10px", fontSize: "0.85rem" }}
				>
					{channel.enabled ? "Desactivar" : "Activar"}
				</button>
			</div>
		</div>
	);
};
