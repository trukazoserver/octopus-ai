import {
	getMascotById,
	getMascotOptions,
} from "@octopus-ai/core/mascots/index";
import type React from "react";
import { useEffect, useState } from "react";
import {
	ConfigSection,
	Field,
	SaveButton,
	Select,
	StatusBadge,
	Toggle,
} from "../components/ConfigSection.js";
import { AppIcon } from "../components/ui/AppIcon.js";
import { BrandLogo } from "../components/ui/BrandLogo.js";
import { apiGet, apiPost, apiPut, apiPutJson } from "../hooks/useApi.js";

interface ProviderConfig {
	apiKey?: string;
	baseUrl?: string;
	mode?: string;
	models?: string[];
}

interface MemoryShortTermConfig {
	maxTokens?: number;
	[key: string]: unknown;
}

interface MemoryLongTermConfig {
	importanceThreshold?: number;
	maxItems?: number;
	[key: string]: unknown;
}

interface MemoryEmbeddingsConfig {
	enabled?: boolean;
	provider?: "auto" | "openai" | "google" | string;
	apiType?: "openai" | "google" | string;
	authMode?: "api-key" | "vertex" | string;
	model?: string;
	apiKeyEnv?: string;
	accessTokenEnv?: string;
	credentialsFile?: string;
	credentialsJson?: string;
	projectId?: string;
	location?: string;
	task?: "document" | "query" | "none" | string;
	dimensions?: number;
	maxBatchSize?: number;
	maxTextLength?: number;
}

interface SkillRegistryConfig {
	builtinSkills?: string[];
	[key: string]: unknown;
}

interface ConfigData {
	ai?: {
		default?: string;
		fallback?: string;
		thinking?: string;
		maxTokens?: number;
		providers?: Record<string, ProviderConfig>;
	};
	browser?: {
		headless?: boolean;
		provider?: "embedded" | "brightdata" | "decodo" | "auto";
		brightDataEnabled?: boolean;
		brightDataWsUrl?: string;
		decodoEnabled?: boolean;
		decodoProxyUrl?: string;
		solveCaptchas?: boolean;
		autoFallbackOnBlock?: boolean;
		blockFallbackProvider?: "brightdata" | "decodo" | "embedded";
		confirmBlockWithVision?: boolean;
	};
	mascots?: {
		defaultId?: string;
	};
	channels?: Record<string, { enabled: boolean }>;
	memory?: {
		enabled?: boolean;
		shortTerm?: MemoryShortTermConfig;
		longTerm?: MemoryLongTermConfig;
		embeddings?: MemoryEmbeddingsConfig;
		consolidation?: unknown;
		retrieval?: unknown;
	};
	skills?: {
		enabled?: boolean;
		autoCreate?: boolean;
		autoImprove?: boolean;
		forge?: unknown;
		improvement?: unknown;
		loading?: unknown;
		registry?: SkillRegistryConfig;
	};
	plugins?: { directories?: string[]; builtin?: string[] };
	server?: { port?: number; host?: string; transport?: string };
	connection?: unknown;
	storage?: { backend?: string; path?: string };
	security?: {
		encryptionKey?: string;
		allowedPaths?: string[];
		sandboxCommands?: boolean;
	};
	tools?: {
		disabled?: string[];
		iterationLimit?: {
			enabled?: boolean;
			maxIterations?: number;
		};
	};
}

interface UserProfile {
	displayName: string | null;
	communicationStyle: string;
	preferredLanguage: string;
	preferences: Record<string, string>;
}

interface UserProfileResponse {
	profile: UserProfile | null;
}

interface ProviderOption {
	key: string;
	name: string;
	url: string;
	logoDomain: string;
	logoSrc?: string;
	logoSources?: string[];
	fallbackLabel?: string;
	hasMode?: boolean;
	isLocal?: boolean;
}

const PROVIDERS: ProviderOption[] = [
	{
		key: "zhipu",
		name: "Z.ai / ZhipuAI",
		url: "https://open.bigmodel.cn/",
		logoDomain: "chat.z.ai",
		fallbackLabel: "Z.ai",
		hasMode: true,
	},
	{
		key: "openai",
		name: "OpenAI",
		url: "https://platform.openai.com/api-keys",
		logoDomain: "openai.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
	},
	{
		key: "anthropic",
		name: "Anthropic (Claude)",
		url: "https://console.anthropic.com/",
		logoDomain: "anthropic.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/anthropic.svg",
	},
	{
		key: "google",
		name: "Google (Gemini)",
		url: "https://aistudio.google.com/",
		logoDomain: "google.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/google.svg",
	},
	{
		key: "deepseek",
		name: "DeepSeek",
		url: "https://platform.deepseek.com/",
		logoDomain: "deepseek.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/deepseek.svg",
	},
	{
		key: "mistral",
		name: "Mistral",
		url: "https://console.mistral.ai/",
		logoDomain: "mistral.ai",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/mistralai.svg",
	},
	{
		key: "xai",
		name: "xAI (Grok)",
		url: "https://console.x.ai/",
		logoDomain: "x.ai",
		logoSrc: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/x.svg",
		fallbackLabel: "xAI",
	},
	{
		key: "cohere",
		name: "Cohere",
		url: "https://dashboard.cohere.com/",
		logoDomain: "cohere.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cohere.svg",
	},
	{
		key: "openrouter",
		name: "OpenRouter",
		url: "https://openrouter.ai/keys",
		logoDomain: "openrouter.ai",
		logoSrc: "https://openrouter.ai/favicon.ico",
	},
	{
		key: "local",
		name: "Ollama (Local)",
		url: "https://ollama.com/",
		logoDomain: "ollama.com",
		isLocal: true,
	},
];

const MASCOT_OPTIONS = getMascotOptions();

const settingsPanelStyle: React.CSSProperties = {
	background: "#000",
	padding: "18px",
	borderRadius: "16px",
	border: "1px solid #151515",
	boxShadow: "0 12px 28px rgba(0,0,0,.18)",
};

const settingsMutedPanelStyle: React.CSSProperties = {
	...settingsPanelStyle,
	background: "#050505",
};

const settingsPrimaryButtonStyle: React.CSSProperties = {
	padding: "9px 14px",
	borderRadius: "10px",
	border: "1px solid #2a2a2a",
	background: "#f4f4f5",
	color: "#050505",
	fontSize: "0.85rem",
	fontWeight: 800,
	cursor: "pointer",
	fontFamily: "inherit",
};

const CompanyHeading: React.FC<{
	domain: string;
	name: string;
	description: string;
	src?: string;
	sources?: string[];
}> = ({ domain, name, description, src, sources }) => (
	<div className="company-heading">
		<BrandLogo
			domain={domain}
			name={name}
			size={28}
			src={src}
			sources={sources}
		/>
		<div>
			<div className="company-heading-title">{name}</div>
			<div className="company-heading-description">{description}</div>
		</div>
	</div>
);

function setConfigValue(
	config: ConfigData,
	keyPath: string,
	value: unknown,
): ConfigData {
	const result = { ...config } as Record<string, unknown>;
	const keys = keyPath.split(".");
	let current = result;

	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		const existing = current[key];
		const next =
			existing && typeof existing === "object" && !Array.isArray(existing)
				? { ...(existing as Record<string, unknown>) }
				: {};
		current[key] = next;
		current = next;
	}

	const lastKey = keys[keys.length - 1];
	if (lastKey) current[lastKey] = value;
	return result as ConfigData;
}

function readServiceAccountProjectId(credentialsJson?: string): string {
	try {
		const raw = credentialsJson?.trim();
		if (!raw) return "";
		const parsed = JSON.parse(raw) as { project_id?: string };
		return parsed.project_id?.trim() ?? "";
	} catch {
		return "";
	}
}

export const SettingsPage: React.FC = () => {
	const [config, setConfig] = useState<ConfigData>({});
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [profileDraft, setProfileDraft] = useState<UserProfile | null>(null);
	const [embeddingDraft, setEmbeddingDraft] = useState<MemoryEmbeddingsConfig>(
		{},
	);
	const [loading, setLoading] = useState(true);
	const [savingKey, setSavingKey] = useState<string | null>(null);
	const [applyingEmbeddings, setApplyingEmbeddings] = useState(false);
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

	useEffect(() => {
		Promise.all([
			apiGet<ConfigData>("/api/config"),
			apiGet<UserProfileResponse>("/api/memory/profile"),
		])
			.then(([c, profileResponse]) => {
				setConfig(c);
				setEmbeddingDraft(c.memory?.embeddings ?? {});
				setProfile(profileResponse.profile);
				setProfileDraft(profileResponse.profile);
				setLoading(false);
			})
			.catch((e) => {
				setMsg({ text: e.message, ok: false });
				setLoading(false);
			});
	}, []);

	const save = async (key: string, value: unknown) => {
		setMsg(null);
		setSavingKey(key);
		let previousConfig: ConfigData | null = null;
		setConfig((current) => {
			previousConfig = current;
			return setConfigValue(current, key, value);
		});
		try {
			await apiPut(`/api/config/${key}`, value);
			setMsg({
				text: key.startsWith("memory.embeddings")
					? `${key} guardado y aplicado`
					: `${key} guardado`,
				ok: true,
			});

			// Clear message after 3 seconds
			setTimeout(() => {
				setMsg(null);
			}, 3000);
		} catch (e) {
			if (previousConfig) setConfig(previousConfig);
			setMsg({
				text: e instanceof Error ? e.message : String(e),
				ok: false,
			});
		} finally {
			setSavingKey(null);
		}
	};

	const saveAndApplyEmbeddings = async () => {
		setMsg(null);
		if (embeddingDraft.enabled && !canEnableEmbeddings) {
			setMsg({ text: embeddingBlockers[0], ok: false });
			return;
		}
		setApplyingEmbeddings(true);
		try {
			await apiPut("/api/config/memory.embeddings", embeddingDraft);
			setConfig((current) =>
				setConfigValue(current, "memory.embeddings", embeddingDraft),
			);
			await apiPost("/api/config/apply/embeddings");
			setMsg({
				text: "Embeddings guardados y aplicados sin reiniciar Octopus",
				ok: true,
			});
			setTimeout(() => setMsg(null), 3000);
		} catch (e) {
			setMsg({
				text: e instanceof Error ? e.message : String(e),
				ok: false,
			});
		} finally {
			setApplyingEmbeddings(false);
		}
	};

	const updateEmbeddingDraft = (patch: Partial<MemoryEmbeddingsConfig>) => {
		setMsg(null);
		setEmbeddingDraft((current) => ({ ...current, ...patch }));
	};

	const saveProfile = async (patch: Partial<UserProfile>) => {
		setMsg(null);
		let previousProfile: UserProfile | null = null;
		setProfile((current) => {
			previousProfile = current;
			return {
				displayName: null,
				communicationStyle: "concise",
				preferredLanguage: "es",
				...(current ?? {}),
				...patch,
				preferences: {
					...(current?.preferences ?? {}),
					...(patch.preferences ?? {}),
				},
			};
		});
		try {
			const response = (await apiPutJson("/api/memory/profile", patch)) as {
				profile?: UserProfile;
			};
			if (response.profile) setProfile(response.profile);
			setMsg({ text: "Perfil guardado", ok: true });
			setTimeout(() => setMsg(null), 3000);
		} catch (e) {
			setProfile(previousProfile);
			setMsg({
				text: e instanceof Error ? e.message : String(e),
				ok: false,
			});
		}
	};

	const updateProfileDraft = (patch: Partial<UserProfile>) => {
		setProfileDraft((current) => ({
			displayName: null,
			communicationStyle: "concise",
			preferredLanguage: "es",
			...(profile ?? {}),
			...(current ?? {}),
			...patch,
			preferences: {
				...(profile?.preferences ?? {}),
				...(current?.preferences ?? {}),
				...(patch.preferences ?? {}),
			},
		}));
	};

	const saveProfileDraft = async () => {
		if (!profileDraft) return;
		await saveProfile({
			displayName: profileDraft.displayName?.trim() || null,
			preferredLanguage: profileDraft.preferredLanguage || "es",
			communicationStyle: profileDraft.communicationStyle || "concise",
			preferences: profileDraft.preferences ?? {},
		});
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
							background: "#f4f4f5",
							animation: "pulse 1.4s infinite ease-in-out",
						}}
					/>
					<span>Cargando configuración...</span>
				</div>
			</div>
		);

	const ai = config.ai ?? {};
	const browser = config.browser ?? {};
	const selectedMascot = getMascotById(config.mascots?.defaultId);
	const tools = config.tools ?? {};
	const toolIterationLimit = tools.iterationLimit ?? {};
	const providers = ai.providers ?? {};
	const embeddings = embeddingDraft;
	const embeddingProvider = embeddings.provider ?? "auto";
	const embeddingAuthMode = embeddings.authMode ?? "api-key";
	const serviceAccountProjectId = readServiceAccountProjectId(
		embeddings.credentialsJson,
	);
	const effectiveAccessTokenEnv =
		embeddings.accessTokenEnv === "GOOGLE_APPLICATION_CREDENTIALS"
			? ""
			: (embeddings.accessTokenEnv ?? "");
	const embeddingBlockers: string[] = [];
	if (
		embeddingProvider === "google" &&
		embeddingAuthMode === "vertex" &&
		!String(embeddings.projectId ?? "").trim() &&
		!serviceAccountProjectId
	) {
		embeddingBlockers.push(
			"Vertex AI necesita Google Cloud Project, salvo que pegues un Service Account JSON que incluya project_id.",
		);
	}
	if (
		embeddingProvider === "google" &&
		embeddingAuthMode === "vertex" &&
		!String(effectiveAccessTokenEnv).trim() &&
		!String(embeddings.credentialsFile ?? "").trim() &&
		!String(embeddings.credentialsJson ?? "").trim()
	) {
		embeddingBlockers.push(
			"Vertex AI necesita GOOGLE_VERTEX_ACCESS_TOKEN, una ruta de service account o pegar el JSON de service account.",
		);
	}
	const canEnableEmbeddings = embeddingBlockers.length === 0;
	const userProfile = profileDraft ??
		profile ?? {
			displayName: "",
			communicationStyle: "concise",
			preferredLanguage: "es",
			preferences: {},
		};
	const allModels: string[] = [];
	for (const [, p] of Object.entries(providers)) {
		if (p.models) allModels.push(...p.models);
	}

	return (
		<div
			className="settings-page"
			style={{
				padding: "34px 34px 48px",
				maxWidth: "1120px",
				margin: "0 auto",
				overflowY: "auto",
				height: "100%",
				width: "100%",
				boxSizing: "border-box",
				background: "#000",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "26px",
				}}
			>
				<div>
					<div
						style={{
							color: "#737373",
							fontSize: "0.82rem",
							fontWeight: 800,
							letterSpacing: "0.08em",
							textTransform: "uppercase",
							marginBottom: "8px",
						}}
					>
						Octopus
					</div>
					<h2
						style={{
							margin: 0,
							fontSize: "2.1rem",
							fontWeight: 850,
							color: "#f4f4f5",
							letterSpacing: "-0.04em",
						}}
					>
						Configuración
					</h2>
					<p
						style={{ margin: "8px 0 0", color: "#8f8f94", fontSize: "0.98rem" }}
					>
						Perfil, proveedores, herramientas y preferencias del entorno local.
					</p>
				</div>
			</div>

			{msg && (
				<div
					style={{
						padding: "12px 16px",
						borderRadius: "14px",
						marginBottom: "20px",
						background: msg.ok
							? "rgba(16, 185, 129, 0.11)"
							: "rgba(239, 68, 68, 0.11)",
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

			<div
				style={{
					padding: "10px 14px",
					borderRadius: "14px",
					marginBottom: "18px",
					background: "#050505",
					border: "1px solid #151515",
					color: "#a1a1aa",
					fontSize: "0.82rem",
					display: "flex",
					justifyContent: "space-between",
					gap: "12px",
					flexWrap: "wrap",
				}}
			>
				<span>
					La configuración general se guarda al modificar un campo. En
					embeddings, los cambios quedan como borrador y solo se guardan al
					presionar Guardar y aplicar embeddings.
				</span>
				{savingKey && <strong>Guardando {savingKey}...</strong>}
			</div>

			<ConfigSection
				title="Perfil de usuario"
				icon={<AppIcon name="user" size={17} />}
				description="Define cómo quieres que Octopus te identifique y adapte sus respuestas. Este nombre también se usa en la pantalla inicial del chat."
				defaultOpen={true}
			>
				<div style={settingsPanelStyle}>
					<Field
						label="Nombre para el saludo"
						value={userProfile.displayName ?? ""}
						onChange={(v) => updateProfileDraft({ displayName: v })}
						placeholder="Ej. Edwin"
						description="Este nombre aparecerá en el saludo del chat."
					/>
					<Select
						label="Idioma preferido"
						value={userProfile.preferredLanguage || "es"}
						options={["es", "en", "pt", "auto"]}
						onChange={(v) => updateProfileDraft({ preferredLanguage: v })}
						description="Idioma principal para respuestas y textos personalizados."
					/>
					<Select
						label="Estilo de comunicación"
						value={userProfile.communicationStyle || "concise"}
						options={["concise", "detailed", "casual", "formal"]}
						onChange={(v) => updateProfileDraft({ communicationStyle: v })}
						description="Define si Octopus debe responder de forma breve, detallada, casual o formal."
					/>
					<Field
						label="Preferencia adicional"
						value={userProfile.preferences.responsePreference ?? ""}
						onChange={(v) =>
							updateProfileDraft({ preferences: { responsePreference: v } })
						}
						placeholder="Ej. respuestas con pasos claros y ejemplos"
						description="Instrucción breve sobre cómo prefieres recibir respuestas."
					/>
					<SaveButton
						onClick={() => void saveProfileDraft()}
						label="Guardar perfil"
					/>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Mascota"
				icon={<AppIcon name="octopus" size={17} />}
				description="Elige la mascota y personalidad que acompaña a Octopus en CLI, web y escritorio."
				defaultOpen={true}
			>
				<div
					style={{
						...settingsPanelStyle,
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
						gap: "20px",
						alignItems: "center",
					}}
				>
					<div style={{ display: "flex", justifyContent: "center" }}>
						<img
							src={selectedMascot.assetPath}
							alt={`${selectedMascot.animal} ${selectedMascot.nombre}`}
							style={{
								width: "140px",
								height: "140px",
								objectFit: "contain",
								imageRendering: "pixelated",
							}}
						/>
					</div>
					<div>
						<Select
							label="Mascota activa"
							value={selectedMascot.id}
							options={MASCOT_OPTIONS.map((item) => item.id)}
							onChange={(v) => save("mascots.defaultId", v)}
							description="La selección se guarda en la configuración global del servidor local."
						/>
						<div
							style={{ color: "#f4f4f5", fontWeight: 700, marginBottom: "6px" }}
						>
							{selectedMascot.nombre} · {selectedMascot.animal}
						</div>
						<div
							style={{
								color: "#f97316",
								fontSize: "0.9rem",
								marginBottom: "8px",
							}}
						>
							{selectedMascot.tagline}
						</div>
						<p style={{ color: "#a1a1aa", lineHeight: 1.6, margin: "0 0 8px" }}>
							{selectedMascot.personalidad}
						</p>
						<p style={{ color: "#71717a", lineHeight: 1.6, margin: 0 }}>
							{selectedMascot.historia}
						</p>
					</div>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Navegador Web"
				icon={<AppIcon name="globe" size={17} />}
				description="Ajustes del motor de navegación y evasión de bloqueos."
				defaultOpen={false}
			>
				<div style={{ display: "grid", gap: "20px" }}>
					<div style={settingsPanelStyle}>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
								gap: "12px",
								marginBottom: "18px",
							}}
						>
							<CompanyHeading
								domain="brightdata.com"
								name="Bright Data"
								src="https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/brightdata.svg"
								description="CDP remoto para navegación y fallback ante bloqueos."
							/>
							<CompanyHeading
								domain="decodo.com"
								name="Decodo"
								src="https://decodo.com/favicon.ico"
								description="Proxy residencial para navegación local con Playwright."
							/>
						</div>
						<Select
							label="Proveedor de Navegador"
							value={browser.provider ?? "auto"}
							options={["embedded", "brightdata", "decodo", "auto"]}
							onChange={(v) => save("browser.provider", v)}
							description="embedded: Playwright local | brightdata: CDP remoto | decodo: Playwright local con proxy residencial | auto: usa el navegador disponible"
						/>
						<Toggle
							label="Habilitar CDP remoto"
							value={browser.brightDataEnabled ?? true}
							onChange={(v) => save("browser.brightDataEnabled", v)}
							description="Permite usar este proveedor como principal o como destino de fallback."
						/>
						<Field
							label="WS URL"
							value={browser.brightDataWsUrl ?? ""}
							onChange={(v) => save("browser.brightDataWsUrl", v)}
							placeholder="wss://brd-customer-...:password@brd.superproxy.io:9222"
							description="Opcional. Déjalo vacío para usar la variable gestionada BRIGHTDATA_WS_URL. Solo valores ws:// o wss:// son válidos."
						/>
						<Toggle
							label="Habilitar proxy residencial"
							value={browser.decodoEnabled ?? true}
							onChange={(v) => save("browser.decodoEnabled", v)}
							description="Permite usar el proxy residencial para Playwright, fallback ante bloqueos y captchas con IP matching."
						/>
						<Field
							label="Proxy URL"
							value={browser.decodoProxyUrl ?? ""}
							onChange={(v) => save("browser.decodoProxyUrl", v)}
							placeholder="http://user:password@gate.decodo.com:7000"
							description="Opcional. Déjalo vacío para usar variables gestionadas DECODO_PROXY_URL o DECODO_PROXY_USERNAME/DECODO_PROXY_PASSWORD."
						/>
					</div>

					<div style={settingsPanelStyle}>
						<Toggle
							label="Modo Headless"
							value={browser.headless ?? false}
							onChange={(v) => save("browser.headless", v)}
							description="Ejecutar el navegador local oculto en segundo plano"
						/>
						<Toggle
							label="Resolver Captchas Automáticamente"
							value={browser.solveCaptchas ?? true}
							onChange={(v) => save("browser.solveCaptchas", v)}
							description="Intentar resolver reCAPTCHA/hCaptcha antes de considerar la web bloqueada"
						/>
						<Toggle
							label="Fallback Automático ante Bloqueo"
							value={browser.autoFallbackOnBlock ?? true}
							onChange={(v) => save("browser.autoFallbackOnBlock", v)}
							description="Si está activo, migra al proveedor elegido al detectar DataDome, Cloudflare u otro bloqueo"
						/>
						<Select
							label="Proveedor de Fallback"
							value={browser.blockFallbackProvider ?? "decodo"}
							options={["decodo", "brightdata", "embedded"]}
							onChange={(v) => save("browser.blockFallbackProvider", v)}
							description="Destino usado cuando el fallback automático está activo. El proxy residencial usa Playwright local; CDP remoto requiere WS URL; embedded usa el navegador local detectado."
						/>
						<Toggle
							label="Confirmar Bloqueo con Visión"
							value={browser.confirmBlockWithVision ?? true}
							onChange={(v) => save("browser.confirmBlockWithVision", v)}
							description="Tomar captura de pantalla y usar el modelo de visión configurado para confirmar si realmente hay un bloqueo."
						/>
					</div>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Herramientas e Iteraciones"
				icon={<AppIcon name="tools" size={17} />}
				description="Controla el límite global de ciclos en los que Octopus puede pedir herramientas antes de responder."
				defaultOpen={false}
			>
				<div style={settingsPanelStyle}>
					<Toggle
						label="Activar Límite de Iteraciones"
						value={toolIterationLimit.enabled ?? true}
						onChange={(v) => save("tools.iterationLimit.enabled", v)}
						description="Si está activo, el agente se detiene al llegar al máximo configurado de iteraciones con herramientas."
					/>
					{(toolIterationLimit.enabled ?? true) && (
						<Field
							label="Máximo de Iteraciones"
							value={toolIterationLimit.maxIterations ?? 18}
							type="number"
							description="Número máximo de ciclos de razonamiento con herramientas por respuesta. Debe ser 1 o mayor."
							onChange={(v) =>
								save(
									"tools.iterationLimit.maxIterations",
									Math.max(1, Number.parseInt(v, 10) || 18),
								)
							}
						/>
					)}
				</div>
			</ConfigSection>

			<ConfigSection
				title="Modelos y Proveedores AI"
				icon={<AppIcon name="brain" size={17} />}
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
							? !!prov.baseUrl
							: !!prov.apiKey &&
								prov.apiKey !== "" &&
								!prov.apiKey.includes("...");
						return (
							<div
								key={p.key}
								style={{
									padding: "16px",
									borderRadius: "16px",
									background: "#000",
									border: "1px solid #151515",
									boxShadow: "0 12px 28px rgba(0,0,0,.18)",
									transition: "border-color 0.2s",
								}}
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
										<BrandLogo
											domain={p.logoDomain}
											name={p.name}
											src={p.logoSrc}
											sources={p.logoSources}
											fallbackLabel={p.fallbackLabel}
										/>
										{p.name}
									</span>
									<StatusBadge
										ok={hasKey}
										text={hasKey ? "Activo" : "No config."}
									/>
								</div>
								{p.isLocal ? (
									<Field
										label="URL Base (Local)"
										value={prov.baseUrl ?? "http://localhost:11434"}
										onChange={(v) => save(`ai.providers.${p.key}.baseUrl`, v)}
									/>
								) : (
									<div style={{ marginBottom: "12px" }}>
										<form
											onSubmit={(e) => {
												e.preventDefault();
												const formData = new FormData(e.currentTarget);
												const value = String(
													formData.get(`provider-${p.key}-api-key`) ?? "",
												).trim();
												if (value)
													void save(`ai.providers.${p.key}.apiKey`, value);
											}}
											style={{ display: "flex", gap: "8px" }}
										>
											<input
												id={`provider-${p.key}-api-key`}
												name={`provider-${p.key}-api-key`}
												type="password"
												data-provider={p.key}
												autoComplete="off"
												placeholder={
													hasKey ? "••••••••••••••••" : "Introduce tu API Key"
												}
												style={{
													flex: 1,
													padding: "8px 12px",
													borderRadius: "8px",
													border: "1px solid #202020",
													background: "#000",
													color: "#f4f4f5",
													fontSize: "0.85rem",
													outline: "none",
													fontFamily:
														"ui-monospace, SFMono-Regular, Monaco, monospace",
													transition: "border-color 0.2s",
												}}
												onFocus={(e) => {
													e.target.style.borderColor = "#4a4a4a";
												}}
												onBlur={(e) => {
													e.target.style.borderColor = "#202020";
												}}
											/>
											<button type="submit" style={settingsPrimaryButtonStyle}>
												Guardar
											</button>
										</form>
									</div>
								)}
								{p.hasMode && (
									<div style={{ marginTop: 8 }}>
										<Select
											label="Modo de Operación"
											value={prov.mode ?? "coding-plan"}
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
											aria-hidden="true"
											focusable="false"
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
						gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
						gap: "20px",
						...settingsMutedPanelStyle,
						padding: "18px",
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
				icon={<AppIcon name="database" size={17} />}
				description="Configura cómo Octopus recuerda tus conversaciones."
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr",
						gap: "12px",
						...settingsMutedPanelStyle,
					}}
				>
					<Toggle
						label="Habilitar Memoria Larga/Corta"
						description="Octopus recordará contextos entre sesiones."
						value={config.memory?.enabled ?? true}
						onChange={(v) => save("memory.enabled", v)}
					/>

					<div
						style={{ height: "1px", background: "#151515", margin: "8px 0" }}
					/>

					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
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

					<div
						style={{
							height: "1px",
							background: "#151515",
							margin: "12px 0",
						}}
					/>

					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
							gap: "20px",
						}}
					>
						<div>
							<Toggle
								label="Embeddings avanzados"
								description="Activa vectores reales para búsqueda semántica. No se guarda hasta presionar Guardar y aplicar embeddings."
								value={embeddings.enabled ?? false}
								onChange={(v) => {
									if (v && !canEnableEmbeddings) {
										setMsg({ text: embeddingBlockers[0], ok: false });
										return;
									}
									updateEmbeddingDraft({ enabled: v });
								}}
							/>
							{embeddingBlockers.length > 0 && (
								<div
									style={{
										marginTop: "10px",
										padding: "10px 12px",
										borderRadius: "12px",
										border: "1px solid rgba(248, 113, 113, 0.28)",
										background: "rgba(127, 29, 29, 0.18)",
										color: "#fca5a5",
										fontSize: "0.78rem",
										lineHeight: 1.45,
									}}
								>
									{embeddingBlockers[0]}
								</div>
							)}
							<Select
								label="Proveedor de embeddings"
								value={embeddingProvider}
								options={["auto", "openai", "google"]}
								optionLabels={{
									auto: "Automático",
									openai: "OpenAI",
									google: "Google Gemini",
								}}
								description="OpenAI usa text-embedding-3-small. Google usa gemini-embedding-2 por defecto."
								onChange={(v) => {
									const patch: Partial<MemoryEmbeddingsConfig> = {
										enabled: false,
										provider: v,
										apiType: v === "google" ? "google" : "openai",
									};
									if (v === "google") {
										patch.authMode = "api-key";
										patch.apiKeyEnv = "GEMINI_API_KEY";
										patch.model = "gemini-embedding-2";
										patch.dimensions = 768;
									} else if (v === "openai") {
										patch.authMode = "api-key";
										patch.apiKeyEnv = "OPENAI_API_KEY";
										patch.model = "text-embedding-3-small";
										patch.dimensions = 1536;
									}
									updateEmbeddingDraft(patch);
								}}
							/>
							{embeddingProvider === "google" && (
								<Select
									label="Autenticación Google"
									value={embeddingAuthMode}
									options={["api-key", "vertex"]}
									optionLabels={{
										"api-key": "Gemini API Key",
										vertex: "Vertex AI",
									}}
									description="api-key usa Gemini API Key; vertex usa Google Cloud Vertex AI."
									onChange={(v) => {
										updateEmbeddingDraft({
											enabled: false,
											authMode: v,
											...(v === "api-key"
												? { apiKeyEnv: "GEMINI_API_KEY" }
												: { accessTokenEnv: "GOOGLE_VERTEX_ACCESS_TOKEN" }),
										});
									}}
								/>
							)}
						</div>

						<div>
							<Field
								label="Modelo de embeddings"
								value={
									embeddings.model ||
									(embeddingProvider === "google"
										? "gemini-embedding-2"
										: "text-embedding-3-small")
								}
								description="No mezcles modelos distintos sin reindexar las memorias existentes."
								onChange={(v) => updateEmbeddingDraft({ model: v })}
							/>
							<Field
								label="Dimensiones"
								value={
									embeddings.dimensions ??
									(embeddingProvider === "google" ? 768 : 1536)
								}
								type="number"
								description="Google recomienda 768, 1536 o 3072. OpenAI small usa 1536 por defecto."
								onChange={(v) =>
									updateEmbeddingDraft({
										dimensions: Number.parseInt(v, 10) || 768,
									})
								}
							/>
						</div>

						<div>
							{embeddingProvider === "google" &&
							embeddingAuthMode === "vertex" ? (
								<>
									<Field
										label="Google Cloud Project"
										value={embeddings.projectId ?? ""}
										description="Opcional si el Service Account JSON incluye project_id. También puedes usar GOOGLE_CLOUD_PROJECT."
										onChange={(v) => updateEmbeddingDraft({ projectId: v })}
									/>
									<Field
										label="Google Cloud Location"
										value={embeddings.location ?? "us-central1"}
										onChange={(v) => updateEmbeddingDraft({ location: v })}
									/>
									<Field
										label="Access Token Env"
										value={
											embeddings.accessTokenEnv ===
											"GOOGLE_APPLICATION_CREDENTIALS"
												? "GOOGLE_VERTEX_ACCESS_TOKEN"
												: (embeddings.accessTokenEnv ??
													"GOOGLE_VERTEX_ACCESS_TOKEN")
										}
										description="Variable con un access token Vertex. Para service account usa el campo Service Account JSON o GOOGLE_APPLICATION_CREDENTIALS fuera de Octopus."
										onChange={(v) =>
											updateEmbeddingDraft({ accessTokenEnv: v })
										}
									/>
									<Field
										label="Ruta de Service Account JSON"
										value={embeddings.credentialsFile ?? ""}
										placeholder="C:\\ruta\\service-account.json"
										onChange={(v) =>
											updateEmbeddingDraft({ credentialsFile: v })
										}
									/>
									<div style={{ marginBottom: "16px" }}>
										<label
											htmlFor="service-account-json"
											style={{
												display: "block",
												fontSize: "0.85rem",
												color: "#a1a1aa",
												marginBottom: "6px",
												fontWeight: 700,
											}}
										>
											Pegar Service Account JSON
										</label>
										<div
											style={{
												fontSize: "0.76rem",
												color: "#737373",
												marginBottom: "9px",
												lineHeight: 1.45,
											}}
										>
											Puedes pegar el JSON completo. Si incluye project_id, no
											necesitas llenar Google Cloud Project.
										</div>
										<textarea
											id="service-account-json"
											value={embeddings.credentialsJson ?? ""}
											placeholder={
												'{"type":"service_account","project_id":"..."}'
											}
											onChange={(e) =>
												updateEmbeddingDraft({
													credentialsJson: e.target.value,
												})
											}
											style={{
												width: "100%",
												minHeight: "150px",
												padding: "12px 14px",
												borderRadius: "12px",
												border: "1px solid #202020",
												background: "#000",
												color: "#f4f4f5",
												fontSize: "0.85rem",
												fontFamily:
													"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
												outline: "none",
												boxSizing: "border-box",
												resize: "vertical",
											}}
										/>
										{serviceAccountProjectId && (
											<div
												style={{
													color: "#86efac",
													fontSize: "0.76rem",
													marginTop: "8px",
												}}
											>
												project_id detectado: {serviceAccountProjectId}
											</div>
										)}
									</div>
								</>
							) : (
								<Field
									label={
										embeddingProvider === "google"
											? "GEMINI_API_KEY"
											: "OPENAI_API_KEY"
									}
									value={
										embeddings.apiKeyEnv ||
										(embeddingProvider === "google"
											? "GEMINI_API_KEY"
											: "OPENAI_API_KEY")
									}
									description="Nombre de variable de entorno. También se reutilizan las claves en Proveedores AI si están guardadas."
									onChange={(v) => updateEmbeddingDraft({ apiKeyEnv: v })}
								/>
							)}
						</div>
					</div>

					<div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
						<button
							type="button"
							onClick={() => void saveAndApplyEmbeddings()}
							disabled={applyingEmbeddings}
							style={{
								...settingsPrimaryButtonStyle,
								opacity: applyingEmbeddings ? 0.65 : 1,
								cursor: applyingEmbeddings ? "wait" : "pointer",
							}}
						>
							{applyingEmbeddings
								? "Aplicando..."
								: "Guardar y aplicar embeddings"}
						</button>
						<span
							style={{
								alignSelf: "center",
								color: "#737373",
								fontSize: "0.78rem",
							}}
						>
							No reinicia el servidor; refresca solo el proveedor de embeddings.
						</span>
					</div>

					<div
						style={{
							padding: "12px 14px",
							borderRadius: "14px",
							border: "1px solid rgba(251, 191, 36, 0.22)",
							background: "rgba(251, 191, 36, 0.08)",
							color: "#fbbf24",
							fontSize: "0.82rem",
							lineHeight: 1.5,
						}}
					>
						Los cambios de embeddings no se guardan automáticamente. Se guardan
						y aplican solo al presionar Guardar y aplicar embeddings. Si activas
						un proveedor real, reindexa las memorias existentes para no mezclar
						vectores hash o modelos antiguos.
					</div>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Skills (Habilidades)"
				icon={<AppIcon name="spark" size={17} />}
				description="Las herramientas y capacidades de Octopus."
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr",
						gap: "12px",
						...settingsMutedPanelStyle,
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
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
					gap: "16px",
				}}
			>
				<ConfigSection
					title="Servidor Local"
					icon={<AppIcon name="server" size={17} />}
					description="Requiere reiniciar el servidor."
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

				<ConfigSection
					title="Seguridad"
					icon={<AppIcon name="lock" size={17} />}
				>
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
							{(config.security?.allowedPaths ?? []).map((p) => (
								<span
									key={p}
									style={{
										padding: "4px 10px",
										borderRadius: "6px",
										background: "#111",
										border: "1px solid #242424",
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
