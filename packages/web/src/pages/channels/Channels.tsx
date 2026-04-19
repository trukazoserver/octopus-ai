import type React from "react";
import { useState } from "react";
import { ChannelCard } from "../../components/channels/ChannelCard.js";
import { DiscordConfig } from "../../components/channels/DiscordConfig.js";
import { SlackConfig } from "../../components/channels/SlackConfig.js";
import { TelegramConfig } from "../../components/channels/TelegramConfig.js";
import { WhatsAppConfig } from "../../components/channels/WhatsAppConfig.js";
import { showToast } from "../../components/ui/Toast.js";
import { useChannels } from "../../hooks/useChannels.js";

function renderChannelConfig(
	type: string,
	enabled: boolean,
	config: Record<string, unknown>,
	onSave: (cfg: Record<string, unknown>) => void,
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
		await toggleChannel(name);
		const ch = channels.find((c) => c.name === name);
		showToast("success", `${name} ${ch?.enabled ? "desactivado" : "activado"}`);
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

	return (
		<div className="page-shell">
			<div className="animate-fade-in" style={{ marginBottom: "28px" }}>
				<h1
					style={{
						fontSize: "1.6rem",
						fontWeight: 700,
						color: "#f4f4f5",
						margin: "0 0 6px",
						letterSpacing: "-0.02em",
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
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
						gap: "16px",
					}}
				>
					{Array.from({ length: 3 }).map((_, i) => (
						<div
							key={i}
							className="skeleton"
							style={{ height: "180px", borderRadius: "16px" }}
						/>
					))}
				</div>
			) : (
				<>
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
							<div
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
									gap: "16px",
								}}
							>
								{activeChannels.map((channel) => (
									<ChannelCard
										key={channel.name}
										channel={channel}
										onToggle={handleToggle}
										onTest={handleTest}
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
							<div
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
									gap: "16px",
								}}
							>
								{inactiveChannels.map((channel) => (
									<ChannelCard
										key={channel.name}
										channel={channel}
										onToggle={handleToggle}
										onTest={handleTest}
										testing={testingChannel === channel.name}
									/>
								))}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
};
