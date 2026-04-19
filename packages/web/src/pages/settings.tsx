import type React from "react";
import { useEffect, useState } from "react";
import {
	ConfigSection,
	Field,
	Select,
	StatusBadge,
	Toggle,
} from "../components/ConfigSection.js";
import { apiGet, apiPut } from "../hooks/useApi.js";

interface ProviderConfig {
	apiKey?: string;
	baseUrl?: string;
	mode?: string;
	models?: string[];
}
interface ConfigData {
	ai?: {
		default?: string;
		fallback?: string;
		thinking?: string;
		maxTokens?: number;
		providers?: Record<string, ProviderConfig>;
	};
	channels?: Record<string, { enabled: boolean }>;
	memory?: {
		enabled?: boolean;
		shortTerm?: any;
		longTerm?: any;
		consolidation?: any;
		retrieval?: any;
	};
	skills?: {
		enabled?: boolean;
		autoCreate?: boolean;
		autoImprove?: boolean;
		forge?: any;
		improvement?: any;
		loading?: any;
		registry?: any;
	};
	plugins?: { directories?: string[]; builtin?: string[] };
	server?: { port?: number; host?: string; transport?: string };
	connection?: any;
	storage?: { backend?: string; path?: string };
	security?: {
		encryptionKey?: string;
		allowedPaths?: string[];
		sandboxCommands?: boolean;
	};
}

const PROVIDERS = [
	{
		key: "zhipu",
		name: "Z.ai / ZhipuAI",
		icon: "🇨🇳",
		url: "https://open.bigmodel.cn/",
		hasMode: true,
	},
	{
		key: "openai",
		name: "OpenAI",
		icon: "🟢",
		url: "https://platform.openai.com/api-keys",
	},
	{
		key: "anthropic",
		name: "Anthropic (Claude)",
		icon: "🟠",
		url: "https://console.anthropic.com/",
	},
	{
		key: "google",
		name: "Google (Gemini)",
		icon: "🔵",
		url: "https://aistudio.google.com/",
	},
	{
		key: "deepseek",
		name: "DeepSeek",
		icon: "🐋",
		url: "https://platform.deepseek.com/",
	},
	{
		key: "mistral",
		name: "Mistral",
		icon: "🌀",
		url: "https://console.mistral.ai/",
	},
	{ key: "xai", name: "xAI (Grok)", icon: "⚡", url: "https://console.x.ai/" },
	{
		key: "cohere",
		name: "Cohere",
		icon: "🔶",
		url: "https://dashboard.cohere.com/",
	},
	{
		key: "openrouter",
		name: "OpenRouter",
		icon: "🌐",
		url: "https://openrouter.ai/keys",
	},
	{
		key: "local",
		name: "Ollama (Local)",
		icon: "🦙",
		url: "https://ollama.com/",
		isLocal: true,
	},
];

export const SettingsPage: React.FC = () => {
	const [config, setConfig] = useState<ConfigData>({});
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

	useEffect(() => {
		apiGet<ConfigData>("/api/config")
			.then((c) => {
				setConfig(c);
				setLoading(false);
			})
			.catch((e) => {
				setMsg({ text: e.message, ok: false });
				setLoading(false);
			});
	}, []);

	const save = async (key: string, value: unknown) => {
		setMsg(null);
		try {
			await apiPut(`/api/config/${key}`, value);
			setMsg({ text: `✓ ${key} guardado`, ok: true });

			// Clear message after 3 seconds
			setTimeout(() => {
				setMsg(null);
			}, 3000);
		} catch (e) {
			setMsg({
				text: `✗ ${e instanceof Error ? e.message : String(e)}`,
				ok: false,
			});
		}
	};

	if (loading)
		return (
			<div
				style={{
					padding: 40,
					color: "#a1a1aa",
					display: "flex",
					justifyContent: "center",
					alignItems: "center",
					height: "100%",
				}}
			>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: "16px",
					}}
				>
					<span
						className="dot-animation"
						style={{
							width: "32px",
							height: "32px",
							borderRadius: "50%",
							background: "#6366f1",
							animation: "pulse 1.4s infinite ease-in-out",
						}}
					/>
					<span>Cargando configuración...</span>
				</div>
			</div>
		);

	const ai = config.ai ?? {};
	const providers = ai.providers ?? {};
	const allModels: string[] = [];
	for (const [, p] of Object.entries(providers)) {
		if (p.models) allModels.push(...p.models);
	}

	return (
		<div
			style={{
				padding: "30px",
				maxWidth: "1000px",
				margin: "0 auto",
				overflowY: "auto",
				height: "100%",
				width: "100%",
				boxSizing: "border-box",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "30px",
				}}
			>
				<h2
					style={{
						margin: 0,
						fontSize: "1.8rem",
						fontWeight: 700,
						color: "#f4f4f5",
						letterSpacing: "-0.02em",
					}}
				>
					Configuración General
				</h2>
			</div>

			{msg && (
				<div
					style={{
						padding: "12px 16px",
						borderRadius: "8px",
						marginBottom: "20px",
						background: msg.ok
							? "rgba(16, 185, 129, 0.1)"
							: "rgba(239, 68, 68, 0.1)",
						color: msg.ok ? "#10b981" : "#ef4444",
						border: `1px solid ${msg.ok ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)"}`,
						fontSize: "0.9rem",
						fontWeight: 500,
						display: "flex",
						alignItems: "center",
						gap: "8px",
					}}
				>
					{msg.text}
				</div>
			)}

			<ConfigSection
				title="Modelos y Proveedores AI"
				icon="🧠"
				description="Configura tus claves API y modelos para que Octopus AI pueda pensar."
				defaultOpen={true}
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
						gap: "16px",
						marginBottom: "24px",
					}}
				>
					{PROVIDERS.map((p) => {
						const prov = providers[p.key] ?? {};
						const hasKey = p.isLocal
							? !!(prov as any).baseUrl
							: !!(prov as any).apiKey &&
								(prov as any).apiKey !== "" &&
								!(prov as any).apiKey?.includes("...");
						return (
							<div
								key={p.key}
								style={{
									padding: "16px",
									borderRadius: "12px",
									background: "#09090b",
									border: "1px solid #27272a",
									transition: "border-color 0.2s",
								}}
								onMouseOver={(e) =>
									(e.currentTarget.style.borderColor = "#3f3f46")
								}
								onMouseOut={(e) =>
									(e.currentTarget.style.borderColor = "#27272a")
								}
							>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										marginBottom: "12px",
									}}
								>
									<span
										style={{
											fontWeight: 600,
											fontSize: "0.95rem",
											color: "#f4f4f5",
											display: "flex",
											alignItems: "center",
											gap: "8px",
										}}
									>
										<span>{p.icon}</span> {p.name}
									</span>
									<StatusBadge
										ok={hasKey}
										text={hasKey ? "Activo" : "No config."}
									/>
								</div>
								{p.isLocal ? (
									<Field
										label="URL Base (Local)"
										value={(prov as any).baseUrl ?? "http://localhost:11434"}
										onChange={(v) => save(`ai.providers.${p.key}.baseUrl`, v)}
									/>
								) : (
									<div style={{ marginBottom: "12px" }}>
										<div style={{ display: "flex", gap: "8px" }}>
											<input
												type="password"
												data-provider={p.key}
												placeholder={
													hasKey ? "••••••••••••••••" : "Introduce tu API Key"
												}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														const v = (e.target as HTMLInputElement).value;
														if (v) save(`ai.providers.${p.key}.apiKey`, v);
													}
												}}
												style={{
													flex: 1,
													padding: "8px 12px",
													borderRadius: "8px",
													border: "1px solid #3f3f46",
													background: "#18181b",
													color: "#f4f4f5",
													fontSize: "0.85rem",
													outline: "none",
													fontFamily:
														"ui-monospace, SFMono-Regular, Monaco, monospace",
													transition: "border-color 0.2s",
												}}
												onFocus={(e) =>
													(e.target.style.borderColor = "#6366f1")
												}
												onBlur={(e) => (e.target.style.borderColor = "#3f3f46")}
											/>
											<button
												onClick={() => {
													const inp = document.querySelector(
														`[data-provider="${p.key}"]`,
													) as HTMLInputElement;
													if (inp?.value)
														save(`ai.providers.${p.key}.apiKey`, inp.value);
												}}
												style={{
													padding: "8px 14px",
													borderRadius: "8px",
													border: "none",
													background: "#27272a",
													color: "#e4e4e7",
													fontSize: "0.85rem",
													fontWeight: 500,
													cursor: "pointer",
													transition: "all 0.2s",
												}}
												onMouseOver={(e) => {
													e.currentTarget.style.background = "#3f3f46";
													e.currentTarget.style.color = "#fff";
												}}
												onMouseOut={(e) => {
													e.currentTarget.style.background = "#27272a";
													e.currentTarget.style.color = "#e4e4e7";
												}}
											>
												Guardar
											</button>
										</div>
									</div>
								)}
								{p.hasMode && (
									<div style={{ marginTop: 8 }}>
										<Select
											label="Modo de Operación"
											value={(prov as any).mode ?? "coding-plan"}
											options={[
												"api",
												"coding-plan",
												"coding-global",
												"global",
											]}
											onChange={(v) => save(`ai.providers.${p.key}.mode`, v)}
										/>
									</div>
								)}
								<div style={{ marginTop: "12px", textAlign: "right" }}>
									<a
										href={p.url}
										target="_blank"
										rel="noreferrer noopener"
										style={{
											fontSize: "0.75rem",
											color: "#818cf8",
											textDecoration: "none",
											fontWeight: 500,
											display: "inline-flex",
											alignItems: "center",
											gap: "4px",
										}}
									>
										Obtener API Key
										<svg
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<line x1="7" y1="17" x2="17" y2="7" />
											<polyline points="7 7 17 7 17 17" />
										</svg>
									</a>
								</div>
							</div>
						);
					})}
				</div>

				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: "20px",
						background: "#09090b",
						padding: "20px",
						borderRadius: "12px",
						border: "1px solid #27272a",
					}}
				>
					<Select
						label="Modelo por Defecto"
						description="El modelo que Octopus usará para las interacciones."
						value={ai.default ?? "zhipu/glm-5.1"}
						options={
							allModels.length > 0
								? allModels
								: [
										"zhipu/glm-5.1",
										"openai/gpt-4o",
										"anthropic/claude-sonnet-4-6",
										"google/gemini-2.5-pro",
										"local/llama3.1",
									]
						}
						onChange={(v) => save("ai.default", v)}
					/>
					<Select
						label="Modelo de Respaldo"
						description="Se usará si el modelo por defecto falla."
						value={ai.fallback ?? ""}
						options={[
							"(ninguno)",
							...(allModels.length > 0 ? allModels : ["openai/gpt-4o"]),
						]}
						onChange={(v) => save("ai.fallback", v === "(ninguno)" ? "" : v)}
					/>
					<Select
						label="Nivel de Razonamiento (Thinking)"
						description="Controla la profundidad del análisis antes de responder."
						value={ai.thinking ?? "medium"}
						options={["none", "low", "medium", "high"]}
						onChange={(v) => save("ai.thinking", v)}
					/>
					<Field
						label="Límite Máximo de Tokens"
						description="Contexto máximo permitido para la IA."
						value={ai.maxTokens ?? 16384}
						type="number"
						onChange={(v) => save("ai.maxTokens", Number.parseInt(v) || 16384)}
					/>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Memoria Autónoma"
				icon="💭"
				description="Configura cómo Octopus recuerda tus conversaciones."
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr",
						gap: "12px",
						background: "#09090b",
						padding: "20px",
						borderRadius: "12px",
						border: "1px solid #27272a",
					}}
				>
					<Toggle
						label="Habilitar Memoria Larga/Corta"
						description="Octopus recordará contextos entre sesiones."
						value={config.memory?.enabled ?? true}
						onChange={(v) => save("memory.enabled", v)}
					/>

					<div
						style={{ height: "1px", background: "#27272a", margin: "8px 0" }}
					/>

					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1fr 1fr",
							gap: "20px",
						}}
					>
						{config.memory?.shortTerm && (
							<Field
								label="Tokens STM (Memoria Corta)"
								description="Capacidad de la ventana de contexto activo."
								value={config.memory.shortTerm.maxTokens ?? 8192}
								type="number"
								onChange={(v) =>
									save("memory.shortTerm.maxTokens", Number.parseInt(v))
								}
							/>
						)}
						{config.memory?.longTerm && (
							<>
								<Field
									label="Umbral de Importancia"
									description="Valor mínimo (0.0 a 1.0) para guardar un recuerdo permanente."
									value={config.memory.longTerm.importanceThreshold ?? 0.5}
									type="number"
									onChange={(v) =>
										save(
											"memory.longTerm.importanceThreshold",
											Number.parseFloat(v),
										)
									}
								/>
								<Field
									label="Límite de Recuerdos (Items)"
									value={config.memory.longTerm.maxItems ?? 100000}
									type="number"
									onChange={(v) =>
										save("memory.longTerm.maxItems", Number.parseInt(v))
									}
								/>
							</>
						)}
					</div>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Skills (Habilidades)"
				icon="⚡"
				description="Las herramientas y capacidades de Octopus."
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr",
						gap: "12px",
						background: "#09090b",
						padding: "20px",
						borderRadius: "12px",
						border: "1px solid #27272a",
					}}
				>
					<Toggle
						label="Habilitar Sistema de Skills"
						value={config.skills?.enabled ?? true}
						onChange={(v) => save("skills.enabled", v)}
					/>
					<Toggle
						label="Auto-crear Skills"
						description="Octopus creará automáticamente nuevas herramientas si las necesita."
						value={config.skills?.autoCreate ?? true}
						onChange={(v) => save("skills.autoCreate", v)}
					/>
					<Toggle
						label="Mejora Automática"
						description="Octopus refactorizará y mejorará sus habilidades con el uso."
						value={config.skills?.autoImprove ?? true}
						onChange={(v) => save("skills.autoImprove", v)}
					/>

					{config.skills?.registry?.builtinSkills && (
						<div style={{ marginTop: "16px" }}>
							<div
								style={{
									fontSize: "0.85rem",
									color: "#a1a1aa",
									marginBottom: "8px",
									fontWeight: 500,
								}}
							>
								Skills Nativas Activas:
							</div>
							<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
								{config.skills.registry.builtinSkills.map((s: string) => (
									<span
										key={s}
										style={{
											padding: "6px 12px",
											borderRadius: "20px",
											background: "rgba(99, 102, 241, 0.1)",
											border: "1px solid rgba(99, 102, 241, 0.2)",
											fontSize: "0.8rem",
											color: "#818cf8",
											fontWeight: 500,
										}}
									>
										{s}
									</span>
								))}
							</div>
						</div>
					)}
				</div>
			</ConfigSection>

			<div
				style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}
			>
				<ConfigSection
					title="Servidor Local"
					icon="🖥️"
					description="⚠️ Requiere reiniciar el servidor."
				>
					<Field
						label="Puerto"
						value={config.server?.port ?? 18789}
						type="number"
						onChange={(v) => save("server.port", Number.parseInt(v))}
					/>
					<Field
						label="Host"
						value={config.server?.host ?? "127.0.0.1"}
						onChange={(v) => save("server.host", v)}
					/>
					<Select
						label="Transporte Principal"
						value={config.server?.transport ?? "auto"}
						options={["auto", "stdio", "sse", "streamable-http"]}
						onChange={(v) => save("server.transport", v)}
					/>
				</ConfigSection>

				<ConfigSection title="Seguridad" icon="🔒">
					<Toggle
						label="Modo Sandbox"
						description="Limita los comandos que Octopus puede ejecutar."
						value={config.security?.sandboxCommands ?? true}
						onChange={(v) => save("security.sandboxCommands", v)}
					/>
					<div style={{ marginTop: "16px" }}>
						<div
							style={{
								fontSize: "0.85rem",
								color: "#a1a1aa",
								marginBottom: "8px",
								fontWeight: 500,
							}}
						>
							Directorios Permitidos:
						</div>
						<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
							{(config.security?.allowedPaths ?? []).map((p, i) => (
								<span
									key={i}
									style={{
										padding: "4px 10px",
										borderRadius: "6px",
										background: "#27272a",
										border: "1px solid #3f3f46",
										fontSize: "0.8rem",
										color: "#e4e4e7",
										fontFamily: "monospace",
									}}
								>
									{p}
								</span>
							))}
						</div>
					</div>
				</ConfigSection>
			</div>

			<br />
			<br />
		</div>
	);
};
