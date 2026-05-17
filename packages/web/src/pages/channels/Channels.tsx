import type React from "react";
import { useState } from "react";
import { ChannelCard } from "../../components/channels/ChannelCard.js";
import { DiscordConfig } from "../../components/channels/DiscordConfig.js";
import { SlackConfig } from "../../components/channels/SlackConfig.js";
import { TelegramConfig } from "../../components/channels/TelegramConfig.js";
import { WhatsAppConfig } from "../../components/channels/WhatsAppConfig.js";
import { AppIcon } from "../../components/ui/AppIcon.js";
import { showToast } from "../../components/ui/Toast.js";
import { useChannels } from "../../hooks/useChannels.js";

function renderChannelConfig(
	type: string,
	enabled: boolean,
	config: Record<string, unknown>,
	onSave: (cfg: Record<string, unknown>) => Promise<void>,
): React.ReactNode {
	switch (type) {
		case "telegram":
			return (
				<TelegramConfig enabled={enabled} config={config} onSave={onSave} />
			);
		case "discord":
			return (
				<DiscordConfig enabled={enabled} config={config} onSave={onSave} />
			);
		case "slack":
			return <SlackConfig enabled={enabled} config={config} onSave={onSave} />;
		case "whatsapp":
			return (
				<WhatsAppConfig enabled={enabled} config={config} onSave={onSave} />
			);
		default:
			return null;
	}
}

export const ChannelsPage: React.FC = () => {
	const {
		channels,
		loading,
		error,
		reload,
		toggleChannel,
		testChannel,
		saveChannelConfig,
	} = useChannels();
	const [testingChannel, setTestingChannel] = useState<string | null>(null);

	const handleToggle = async (name: string) => {
		const wasEnabled = channels.find((c) => c.name === name)?.enabled;
		try {
			await toggleChannel(name);
			showToast(
				"success",
				`${name} ${wasEnabled ? "desactivado" : "activado"}`,
			);
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "Error al cambiar el canal",
			);
		}
	};

	const handleTest = async (name: string) => {
		setTestingChannel(name);
		const result = await testChannel(name);
		setTestingChannel(null);
		if (result.success) {
			showToast("success", result.message);
		} else {
			showToast("error", result.message);
		}
	};

	const handleSaveConfig = async (
		name: string,
		config: Record<string, unknown>,
	) => {
		await saveChannelConfig(name, config);
	};

	// Separate active and inactive channels
	const activeChannels = channels.filter((c) => c.enabled);
	const inactiveChannels = channels.filter((c) => !c.enabled);
	const channelGridStyle: React.CSSProperties = {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
		gap: "16px",
	};

	return (
		<div className="page-shell settings-page">
			<div className="animate-fade-in" style={{ marginBottom: "28px" }}>
				<div
					style={{
						color: "#737373",
						fontSize: "0.82rem",
						fontWeight: 850,
						letterSpacing: "0.08em",
						textTransform: "uppercase",
						marginBottom: "8px",
					}}
				>
					Octopus
				</div>
				<h1
					style={{
						fontSize: "2.1rem",
						fontWeight: 850,
						color: "#f4f4f5",
						margin: "0 0 6px",
						letterSpacing: "-0.04em",
					}}
				>
					Canales
				</h1>
				<p style={{ fontSize: "0.95rem", color: "#a1a1aa", margin: 0 }}>
					Configura y gestiona tus canales de comunicación
				</p>
			</div>

			{error && (
				<div
					className="animate-fade-in"
					style={{
						padding: "12px 16px",
						borderRadius: "12px",
						background: "rgba(239, 68, 68, 0.1)",
						border: "1px solid rgba(239, 68, 68, 0.3)",
						color: "#ef4444",
						fontSize: "0.85rem",
						marginBottom: "20px",
					}}
				>
					{error}
				</div>
			)}

			{loading ? (
				<div style={channelGridStyle}>
					{[
						"channels-skeleton-1",
						"channels-skeleton-2",
						"channels-skeleton-3",
					].map((key) => (
						<div
							key={key}
							className="skeleton"
							style={{ height: "180px", borderRadius: "16px" }}
						/>
					))}
				</div>
			) : (
				<>
					{channels.length === 0 && (
						<div
							style={{
								padding: "48px 20px",
								borderRadius: "16px",
								border: "1px dashed #242424",
								background: "#050505",
								textAlign: "center",
								color: "#a1a1aa",
							}}
						>
							<div
								style={{
									width: 42,
									height: 42,
									borderRadius: 14,
									border: "1px solid #242424",
									background: "#111",
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									marginBottom: 12,
								}}
							>
								<AppIcon name="message" size={19} />
							</div>
							<div
								style={{ fontWeight: 700, color: "#f4f4f5", marginBottom: 6 }}
							>
								No hay canales registrados
							</div>
							<div style={{ fontSize: "0.85rem" }}>
								Recarga o revisa la configuración del servidor de canales.
							</div>
							<button
								type="button"
								onClick={reload}
								style={{
									marginTop: 16,
									padding: "8px 14px",
									borderRadius: 10,
									border: "1px solid #2a2a2a",
									background: "#f4f4f5",
									color: "#050505",
									fontWeight: 800,
									cursor: "pointer",
								}}
							>
								Recargar canales
							</button>
						</div>
					)}
					{/* Active channels */}
					{activeChannels.length > 0 && (
						<div style={{ marginBottom: "32px" }}>
							<h2
								style={{
									fontSize: "0.9rem",
									fontWeight: 700,
									color: "#71717a",
									margin: "0 0 12px",
									textTransform: "uppercase",
									letterSpacing: "0.05em",
								}}
							>
								Canales activos
							</h2>
							<div style={channelGridStyle}>
								{activeChannels.map((channel) => (
									<ChannelCard
										key={channel.name}
										channel={channel}
										onToggle={handleToggle}
										onTest={handleTest}
										canTest={channel.type === "telegram"}
										testing={testingChannel === channel.name}
									>
										{renderChannelConfig(
											channel.type,
											true,
											channel.config,
											(cfg) => handleSaveConfig(channel.name, cfg),
										)}
									</ChannelCard>
								))}
							</div>
						</div>
					)}

					{/* Inactive channels */}
					{inactiveChannels.length > 0 && (
						<div>
							<h2
								style={{
									fontSize: "0.9rem",
									fontWeight: 700,
									color: "#71717a",
									margin: "0 0 12px",
									textTransform: "uppercase",
									letterSpacing: "0.05em",
								}}
							>
								Canales disponibles
							</h2>
							<div style={channelGridStyle}>
								{inactiveChannels.map((channel) => (
									<ChannelCard
										key={channel.name}
										channel={channel}
										onToggle={handleToggle}
										onTest={handleTest}
										canTest={channel.type === "telegram"}
										testing={testingChannel === channel.name}
									>
										{renderChannelConfig(
											channel.type,
											channel.enabled,
											channel.config,
											(cfg) => handleSaveConfig(channel.name, cfg),
										)}
									</ChannelCard>
								))}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
};
