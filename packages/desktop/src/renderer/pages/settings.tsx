import type React from "react";
import { useCallback, useState } from "react";
import { apiGet, apiPut } from "../hooks/useApi.js";

interface ConfigData {
	ai?: {
		default?: string;
		fallback?: string;
		thinking?: string;
		maxTokens?: number;
		providers?: Record<string, { apiKey?: string; models?: string[] }>;
	};
	memory?: {
		enabled?: boolean;
		shortTerm?: Record<string, unknown>;
		longTerm?: Record<string, unknown>;
	};
	skills?: {
		enabled?: boolean;
		autoCreate?: boolean;
		autoImprove?: boolean;
	};
	server?: {
		port?: number;
		host?: string;
	};
	security?: {
		sandboxCommands?: boolean;
		allowedPaths?: string[];
	};
}

const PROVIDERS = [
	{ key: "zhipu", name: "Z.ai (ZhipuAI)" },
	{ key: "openai", name: "OpenAI" },
	{ key: "anthropic", name: "Anthropic" },
	{ key: "google", name: "Google Gemini" },
	{ key: "deepseek", name: "DeepSeek" },
	{ key: "mistral", name: "Mistral" },
	{ key: "xai", name: "xAI (Grok)" },
	{ key: "cohere", name: "Cohere" },
	{ key: "openrouter", name: "OpenRouter" },
	{ key: "local", name: "Ollama (Local)" },
];

const sectionStyle: React.CSSProperties = {
	marginBottom: "24px",
	padding: "20px",
	backgroundColor: "#18181b",
	borderRadius: "8px",
	border: "1px solid #27272a",
};

const labelStyle: React.CSSProperties = {
	display: "block",
	fontSize: "12px",
	color: "#71717a",
	marginBottom: "4px",
};

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "8px 12px",
	borderRadius: "8px",
	border: "1px solid #27272a",
	backgroundColor: "#0f1117",
	color: "#e4e4e7",
	fontSize: "13px",
	outline: "none",
	boxSizing: "border-box",
};

export const Settings: React.FC = () => {
	const [config, setConfig] = useState<ConfigData | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const loadConfig = useCallback(async () => {
		setLoading(true);
		try {
			const data = await apiGet<ConfigData>("/api/config");
			setConfig(data);
		} catch {
			setMessage("Failed to load config");
		} finally {
			setLoading(false);
		}
	}, []);

	const saveConfig = useCallback(async (key: string, value: unknown) => {
		setSaving(true);
		setMessage(null);
		try {
			await apiPut(`/api/config/${key}`, value);
			setMessage(`Saved ${key}`);
			setTimeout(() => setMessage(null), 3000);
		} catch {
			setMessage(`Failed to save ${key}`);
		} finally {
			setSaving(false);
		}
	}, []);

	if (!config) {
		return (
			<div
				style={{
					padding: "24px",
					backgroundColor: "#0f1117",
					color: "#e4e4e7",
					height: "100%",
					fontFamily: "Inter, system-ui, sans-serif",
				}}
			>
				<h2 style={{ margin: "0 0 16px 0" }}>Settings</h2>
				<button
					type="button"
					onClick={loadConfig}
					disabled={loading}
					style={{
						padding: "10px 20px",
						borderRadius: "8px",
						backgroundColor: "#3b82f6",
						color: "#fff",
						border: "none",
						cursor: "pointer",
						fontSize: "14px",
					}}
				>
					{loading ? "Loading..." : "Load Configuration"}
				</button>
			</div>
		);
	}

	return (
		<div
			style={{
				padding: "24px",
				backgroundColor: "#0f1117",
				color: "#e4e4e7",
				height: "100%",
				fontFamily: "Inter, system-ui, sans-serif",
				overflowY: "auto",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "24px",
				}}
			>
				<h2 style={{ margin: 0 }}>Settings</h2>
				{message && (
					<span style={{ fontSize: "13px", color: "#22c55e" }}>{message}</span>
				)}
			</div>

			<div style={sectionStyle}>
				<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>AI Providers</h3>
				<div style={{ display: "grid", gap: "16px" }}>
					{PROVIDERS.map((p) => {
						const provider = config.ai?.providers?.[p.key];
						return (
							<div
								key={p.key}
								style={{
									padding: "12px",
									backgroundColor: "#0f1117",
									borderRadius: "6px",
									border: "1px solid #27272a",
								}}
							>
								<div
									style={{
										fontWeight: 600,
										fontSize: "14px",
										marginBottom: "8px",
									}}
								>
									{p.name}
								</div>
								<div
									style={{ display: "flex", gap: "8px", alignItems: "center" }}
								>
									<span style={labelStyle}>API Key:</span>
									<input
										type="password"
										defaultValue={provider?.apiKey ?? ""}
										onBlur={(e) =>
											saveConfig(`ai.providers.${p.key}.apiKey`, e.target.value)
										}
										placeholder={
											provider?.apiKey ? "••••••••" : "Enter API key"
										}
										style={{ ...inputStyle, flex: 1 }}
									/>
								</div>
							</div>
						);
					})}
				</div>
			</div>

			<div style={sectionStyle}>
				<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>
					Model Configuration
				</h3>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: "12px",
					}}
				>
					<div>
						<span style={labelStyle}>Default Model</span>
						<input
							type="text"
							defaultValue={config.ai?.default ?? ""}
							onBlur={(e) => saveConfig("ai.default", e.target.value)}
							style={inputStyle}
						/>
					</div>
					<div>
						<span style={labelStyle}>Fallback Model</span>
						<input
							type="text"
							defaultValue={config.ai?.fallback ?? ""}
							onBlur={(e) => saveConfig("ai.fallback", e.target.value)}
							style={inputStyle}
						/>
					</div>
					<div>
						<span style={labelStyle}>Thinking Level</span>
						<select
							defaultValue={config.ai?.thinking ?? "medium"}
							onChange={(e) => saveConfig("ai.thinking", e.target.value)}
							style={inputStyle}
						>
							<option value="none">None</option>
							<option value="low">Low</option>
							<option value="medium">Medium</option>
							<option value="high">High</option>
						</select>
					</div>
					<div>
						<span style={labelStyle}>Max Tokens</span>
						<input
							type="number"
							defaultValue={config.ai?.maxTokens ?? 16384}
							onBlur={(e) => saveConfig("ai.maxTokens", Number(e.target.value))}
							style={inputStyle}
						/>
					</div>
				</div>
			</div>

			<div style={sectionStyle}>
				<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>Server</h3>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: "12px",
					}}
				>
					<div>
						<span style={labelStyle}>Port</span>
						<input
							type="number"
							defaultValue={config.server?.port ?? 18789}
							style={inputStyle}
						/>
					</div>
					<div>
						<span style={labelStyle}>Host</span>
						<input
							type="text"
							defaultValue={config.server?.host ?? "127.0.0.1"}
							style={inputStyle}
						/>
					</div>
				</div>
			</div>

			<div style={sectionStyle}>
				<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>Security</h3>
				<label
					style={{
						display: "flex",
						alignItems: "center",
						gap: "8px",
						fontSize: "14px",
					}}
				>
					<input
						type="checkbox"
						defaultChecked={config.security?.sandboxCommands ?? true}
						onChange={(e) =>
							saveConfig("security.sandboxCommands", e.target.checked)
						}
					/>
					Sandbox Commands (block dangerous shell patterns)
				</label>
			</div>

			<div style={sectionStyle}>
				<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>
					Skills & Memory
				</h3>
				<div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "8px",
							fontSize: "14px",
						}}
					>
						<input
							type="checkbox"
							defaultChecked={config.skills?.enabled ?? true}
							onChange={(e) => saveConfig("skills.enabled", e.target.checked)}
						/>
						Skills Enabled
					</label>
					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "8px",
							fontSize: "14px",
						}}
					>
						<input
							type="checkbox"
							defaultChecked={config.skills?.autoCreate ?? true}
							onChange={(e) =>
								saveConfig("skills.autoCreate", e.target.checked)
							}
						/>
						Auto-Create Skills
					</label>
					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "8px",
							fontSize: "14px",
						}}
					>
						<input
							type="checkbox"
							defaultChecked={config.memory?.enabled ?? true}
							onChange={(e) => saveConfig("memory.enabled", e.target.checked)}
						/>
						Memory Enabled
					</label>
				</div>
			</div>

			<div style={sectionStyle}>
				<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>
					Code Execution
				</h3>
				<p style={{ color: "#71717a", fontSize: "13px", margin: 0 }}>
					Octopus AI can execute JavaScript, TypeScript, Python, and Bash code.
					It can also create custom tools dynamically. This is enabled by
					default and configured in the core system. Tools created are saved to{" "}
					<code style={{ color: "#a78bfa" }}>~/.octopus/tools/</code>.
				</p>
			</div>

			{saving && (
				<div style={{ color: "#71717a", fontSize: "12px" }}>Saving...</div>
			)}
		</div>
	);
};
