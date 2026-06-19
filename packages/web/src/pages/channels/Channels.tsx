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
						color: "#818cf8",
						fontSize: "0.74rem",
						fontWeight: 800,
						letterSpacing: "0.12em",
						textTransform: "uppercase",
						marginBottom: "10px",
					}}
				>
					Octopus
				</div>
				<h1 className="ui-page-title" style={{ fontSize: "2.1rem" }}>
					Canales
				</h1>
				<p className="ui-page-subtitle" style={{ marginTop: 6 }}>
					Configura y gestiona tus canales de comunicación
				</p>
			</div>

			{error && (
				<div
					className="animate-fade-in ui-notice is-error"
					style={{ marginBottom: "20px" }}
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
						<div className="ui-empty">
							<div className="ui-empty-icon">
								<AppIcon name="message" size={42} strokeWidth={1.6} />
							</div>
							<div className="ui-empty-title">No hay canales registrados</div>
							<div className="ui-empty-desc">
								Recarga o revisa la configuración del servidor de canales.
							</div>
							<button
								type="button"
								onClick={reload}
								className="ui-btn ui-btn--primary"
								style={{ marginTop: 18 }}
							>
								Recargar canales
							</button>
						</div>
					)}
					{/* Active channels */}
					{activeChannels.length > 0 && (
						<div style={{ marginBottom: "32px" }}>
							<h2 className="ui-group-label">Canales activos</h2>
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
							<h2 className="ui-group-label">Canales disponibles</h2>
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
