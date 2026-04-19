import type React from "react";
import type { Channel } from "../../hooks/useChannels.js";

interface ChannelCardProps {
	channel: Channel;
	onToggle: (name: string) => void;
	onTest: (name: string) => void;
	children?: React.ReactNode;
	testing?: boolean;
}

const STATUS_CONFIG: Record<
	string,
	{ color: string; bg: string; label: string }
> = {
	connected: {
		color: "#10b981",
		bg: "rgba(16, 185, 129, 0.1)",
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

const TYPE_ICONS: Record<string, string> = {
	telegram: "✈️",
	discord: "🎮",
	whatsapp: "📱",
	slack: "💼",
	teams: "📋",
	signal: "🔔",
	wechat: "💬",
	webchat: "🌐",
};

export const ChannelCard: React.FC<ChannelCardProps> = ({
	channel,
	onToggle,
	onTest,
	children,
	testing,
}) => {
	const statusCfg = STATUS_CONFIG[channel.status] ?? STATUS_CONFIG.idle;
	const icon = TYPE_ICONS[channel.type] ?? "📡";

	return (
		<div
			className="hover-lift"
			style={{
				padding: "20px",
				borderRadius: "16px",
				background: "rgba(24, 24, 27, 0.6)",
				border: "1px solid #27272a",
				transition: "all 0.2s ease",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.borderColor = "#3f3f46";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.borderColor = "#27272a";
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
					<div
						style={{
							width: "44px",
							height: "44px",
							borderRadius: "12px",
							background: statusCfg.bg,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							fontSize: "20px",
						}}
					>
						{icon}
					</div>
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
								color: "#71717a",
								textTransform: "uppercase",
								letterSpacing: "0.05em",
							}}
						>
							{channel.type}
						</div>
					</div>
				</div>
				<span
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: "6px",
						padding: "4px 10px",
						borderRadius: "20px",
						fontSize: "0.75rem",
						fontWeight: 600,
						background: statusCfg.bg,
						color: statusCfg.color,
						border: `1px solid ${statusCfg.color}30`,
					}}
				>
					<span
						style={{
							width: "6px",
							height: "6px",
							borderRadius: "50%",
							background: statusCfg.color,
							boxShadow:
								channel.status === "connected"
									? `0 0 6px ${statusCfg.color}`
									: "none",
						}}
					/>
					{statusCfg.label}
				</span>
			</div>

			{/* Config section (children) */}
			{channel.enabled && children}

			{/* Action buttons */}
			{channel.enabled && (
				<div
					style={{
						display: "flex",
						gap: "8px",
						marginTop: channel.enabled && children ? "12px" : "0",
					}}
				>
					{channel.type === "telegram" && (
						<button
							type="button"
							onClick={() => onTest(channel.name)}
							disabled={testing || !channel.enabled}
							style={{
								flex: 1,
								padding: "10px",
								borderRadius: "10px",
								border: "1px solid #3f3f46",
								background: "#27272a",
								color: testing ? "#52525b" : "#e4e4e7",
								fontSize: "0.85rem",
								fontWeight: 600,
								cursor: testing || !channel.enabled ? "not-allowed" : "pointer",
								fontFamily: "inherit",
								opacity: testing || !channel.enabled ? 0.5 : 1,
								transition: "all 0.15s",
							}}
						>
							{testing ? "Probando..." : "Probar conexión"}
						</button>
					)}
					<button
						type="button"
						onClick={() => onToggle(channel.name)}
						style={{
							flex: 1,
							padding: "10px",
							borderRadius: "10px",
							border: "1px solid",
							borderColor: channel.enabled
								? "rgba(239, 68, 68, 0.3)"
								: "rgba(16, 185, 129, 0.3)",
							background: channel.enabled
								? "rgba(239, 68, 68, 0.1)"
								: "rgba(16, 185, 129, 0.1)",
							color: channel.enabled ? "#ef4444" : "#10b981",
							fontSize: "0.85rem",
							fontWeight: 600,
							cursor: "pointer",
							fontFamily: "inherit",
							transition: "all 0.15s",
						}}
					>
						{channel.enabled ? "Desactivar" : "Activar"}
					</button>
				</div>
			)}

			{!channel.enabled && (
				<button
					type="button"
					onClick={() => onToggle(channel.name)}
					style={{
						width: "100%",
						padding: "10px",
						borderRadius: "10px",
						border: "1px solid rgba(16, 185, 129, 0.3)",
						background: "rgba(16, 185, 129, 0.1)",
						color: "#10b981",
						fontSize: "0.85rem",
						fontWeight: 600,
						cursor: "pointer",
						fontFamily: "inherit",
						transition: "all 0.15s",
					}}
				>
					Activar canal
				</button>
			)}
		</div>
	);
};
