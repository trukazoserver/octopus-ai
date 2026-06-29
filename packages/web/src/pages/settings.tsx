import {
	getMascotById,
	getMascotOptions,
} from "@octopus-ai/core/mascots/index";
import type React from "react";
import { useEffect, useRef, useState } from "react";
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
import { UsageSection } from "../components/settings/UsageSection.js";
import {
	apiDelete,
	apiGet,
	apiPost,
	apiPut,
	apiPutJson,
} from "../hooks/useApi.js";

interface ProviderConfig {
	apiKey?: string;
	apiKeyEnv?: string;
	baseUrl?: string;
	authMode?: string;
	accessToken?: string;
	accessTokenEnv?: string;
	codingApiKey?: string;
	codingBaseUrl?: string;
	credentialsFile?: string;
	credentialsJson?: string;
	projectId?: string;
	location?: string;
	mode?: string;
	models?: string[];
	oauthClientId?: string;
	oauthClientSecret?: string;
	oauthAccessToken?: string;
	oauthRefreshToken?: string;
	oauthExpiresAt?: number;
	browserCookies?: string;
	browserUserAgent?: string;
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
		decodoProxyUsername?: string;
		decodoProxyPassword?: string;
		decodoProxyCountry?: string;
		decodoProxyCity?: string;
		decodoProxyState?: string;
		decodoProxyZip?: string;
		decodoProxySession?: string;
		decodoProxySessionDuration?: string;
		decodoScraperToken?: string;
		decodoScraperUsername?: string;
		decodoScraperPassword?: string;
		solveCaptchas?: boolean;
		captchaApiKey?: string;
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
	orchestration?: {
		enabled?: boolean;
		mode?: "durable" | "legacy" | "hybrid";
		maxArms?: number;
		workerTimeoutMs?: number;
		maxToolIterationsPerArm?: number;
		maxStagnantAttempts?: number;
		maxSpawnDepth?: number;
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

interface StatusResponse {
	availableProviders?: string[];
}

interface VertexSetupResponse {
	projectId: string;
	projectNumber?: string;
	createdProject: boolean;
	billingAccounts: Array<{
		name: string;
		displayName?: string;
		open?: boolean;
	}>;
	linkedBillingAccount?: string;
	enabledServices: string[];
	iamRolesGranted: string[];
	principalEmail?: string;
	warnings: string[];
}

interface EnvVarEntry {
	id: string;
	key: string;
	value: string;
	description: string | null;
	is_secret: number;
	created_at: string;
	updated_at: string;
}

interface EnvVarDraft {
	key: string;
	value: string;
	description: string;
	isSecret: boolean;
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
	authModes?: Array<{ value: string; label: string }>;
	defaultAuthMode?: string;
	apiKeyEnvPlaceholder?: string;
}

const PROVIDERS: ProviderOption[] = [
	{
		key: "zhipu",
		name: "Z.ai / ZhipuAI",
		url: "https://z.ai/",
		logoDomain: "chat.z.ai",
		fallbackLabel: "Z.ai",
		hasMode: true,
		apiKeyEnvPlaceholder: "ZHIPU_CODING_API_KEY",
	},
	{
		key: "openai",
		name: "OpenAI",
		url: "https://platform.openai.com/api-keys",
		logoDomain: "openai.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
		authModes: [
			{ value: "api-key", label: "API key" },
			{
				value: "codex",
				label: "Codex (iniciar sesión con cuenta OpenAI/ChatGPT)",
			},
		],
		defaultAuthMode: "api-key",
		apiKeyEnvPlaceholder: "OPENAI_API_KEY",
	},
	{
		key: "anthropic",
		name: "Anthropic (Claude)",
		url: "https://console.anthropic.com/",
		logoDomain: "anthropic.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/anthropic.svg",
		authModes: [
			{ value: "api-key", label: "API key" },
			{ value: "bearer", label: "Bearer token" },
			{ value: "oauth", label: "OAuth (Login)" },
			{ value: "browser", label: "Browser (Login)" },
		],
		defaultAuthMode: "api-key",
		apiKeyEnvPlaceholder: "ANTHROPIC_API_KEY",
	},
	{
		key: "gemini",
		name: "Google Gemini",
		url: "https://aistudio.google.com/",
		logoDomain: "google.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/google.svg",
		authModes: [{ value: "api-key", label: "API key" }],
		defaultAuthMode: "api-key",
		apiKeyEnvPlaceholder: "GEMINI_API_KEY",
	},
	{
		key: "vertex",
		name: "Google Vertex AI",
		url: "https://console.cloud.google.com/",
		logoDomain: "google.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlecloud.svg",
		authModes: [{ value: "vertex", label: "Service account / gcloud" }],
		defaultAuthMode: "vertex",
	},
	{
		key: "deepseek",
		name: "DeepSeek",
		url: "https://platform.deepseek.com/",
		logoDomain: "deepseek.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/deepseek.svg",
		authModes: [
			{ value: "api-key", label: "API key" },
			{ value: "browser", label: "Browser (Login)" },
		],
		defaultAuthMode: "api-key",
		apiKeyEnvPlaceholder: "DEEPSEEK_API_KEY",
	},
	{
		key: "mistral",
		name: "Mistral",
		url: "https://console.mistral.ai/",
		logoDomain: "mistral.ai",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/mistralai.svg",
		apiKeyEnvPlaceholder: "MISTRAL_API_KEY",
	},
	{
		key: "xai",
		name: "xAI (Grok)",
		url: "https://console.x.ai/",
		logoDomain: "x.ai",
		logoSrc: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/x.svg",
		fallbackLabel: "xAI",
		authModes: [
			{ value: "api-key", label: "API key" },
			{ value: "browser", label: "Browser (Login)" },
		],
		defaultAuthMode: "api-key",
		apiKeyEnvPlaceholder: "XAI_API_KEY",
	},
	{
		key: "cohere",
		name: "Cohere",
		url: "https://dashboard.cohere.com/",
		logoDomain: "cohere.com",
		logoSrc:
			"https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cohere.svg",
		apiKeyEnvPlaceholder: "COHERE_API_KEY",
	},
	{
		key: "openrouter",
		name: "OpenRouter",
		url: "https://openrouter.ai/keys",
		logoDomain: "openrouter.ai",
		logoSrc: "https://openrouter.ai/favicon.ico",
		apiKeyEnvPlaceholder: "OPENROUTER_API_KEY",
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

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"gemini-2.5-pro": 1_048_576,
	"gemini-2.5-flash": 1_048_576,
	"gemini-2.0-flash": 1_048_576,
	"gpt-4.1": 1_048_576,
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	o3: 200_000,
	"o4-mini": 200_000,
	"claude-opus-4-7": 1_048_576,
	"claude-opus-4-6": 1_048_576,
	"claude-sonnet-4-6": 1_048_576,
	"claude-haiku-4-5": 200_000,
	"glm-5.2": 1_000_000,
	"glm-5.1": 200_000,
	"glm-5": 200_000,
	"glm-5-turbo": 200_000,
	"glm-4.7": 200_000,
	"glm-4.6": 200_000,
	"glm-5v-turbo": 200_000,
	"glm-4.6v": 128_000,
	"deepseek-v4-pro": 128_000,
	"deepseek-v4-flash": 128_000,
	"deepseek-chat": 128_000,
	"deepseek-reasoner": 128_000,
	"mistral-large-3": 128_000,
	"mistral-medium-3-1": 128_000,
	"mistral-medium-3-5": 128_000,
	"mistral-small-4": 128_000,
	"codestral-25-08": 256_000,
	"grok-4.20-0309-reasoning": 1_048_576,
	"grok-4.20-0309-non-reasoning": 1_048_576,
	"grok-4-1-fast-reasoning": 1_048_576,
	"grok-4.3": 1_048_576,
	"command-a-03-2025": 256_000,
	"command-a-vision-07-2025": 128_000,
	"command-a-reasoning-08-2025": 256_000,
	"command-a-plus-05-2026": 128_000,
};

const settingsPanelStyle: React.CSSProperties = {
	background: "linear-gradient(180deg, #111318 0%, #090a0d 100%)",
	padding: "18px",
	borderRadius: "16px",
	border: "1px solid #2a303a",
	boxShadow: "0 16px 42px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.04)",
};

const settingsMutedPanelStyle: React.CSSProperties = {
	...settingsPanelStyle,
	background: "linear-gradient(180deg, #151821 0%, #0c0e13 100%)",
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

const settingsSecondaryButtonStyle: React.CSSProperties = {
	...settingsPrimaryButtonStyle,
	border: "1px solid #343a46",
	background: "transparent",
	color: "#d4d4d8",
};

const settingsDangerButtonStyle: React.CSSProperties = {
	...settingsPrimaryButtonStyle,
	border: "1px solid rgba(239, 68, 68, 0.35)",
	background: "rgba(239, 68, 68, 0.1)",
	color: "#f87171",
};

const envInputStyle: React.CSSProperties = {
	width: "100%",
	padding: "10px 12px",
	borderRadius: "10px",
	border: "1px solid #343a46",
	background: "#05070a",
	color: "#f4f4f5",
	fontSize: "0.86rem",
	outline: "none",
	boxSizing: "border-box",
};

const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const createEmptyEnvDraft = (): EnvVarDraft => ({
	key: "",
	value: "",
	description: "",
	isSecret: true,
});

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

function hasText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function getModelContextWindow(model: string): number {
	const slashIndex = model.lastIndexOf("/");
	const normalized = slashIndex === -1 ? model : model.slice(slashIndex + 1);
	if (MODEL_CONTEXT_WINDOWS[normalized])
		return MODEL_CONTEXT_WINDOWS[normalized];
	for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (normalized.startsWith(key.split("-").slice(0, 2).join("-"))) {
			return value;
		}
	}
	return 128_000;
}

function formatModelContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return String(tokens);
}

function isProviderConfigured(
	provider: ProviderConfig,
	providerInfo?: ProviderOption,
): boolean {
	const isLocal = providerInfo?.isLocal;
	if (isLocal) return hasText(provider.baseUrl);
	if (provider.authMode === "oauth") {
		return hasText(provider.oauthAccessToken);
	}
	if (providerInfo?.key === "vertex") {
		const vertexProjectId =
			provider.projectId ||
			readServiceAccountProjectId(provider.credentialsJson);
		return (
			hasText(vertexProjectId) &&
			[
				provider.accessToken,
				provider.accessTokenEnv,
				provider.oauthAccessToken,
				provider.credentialsFile,
				provider.credentialsJson,
			].some(hasText)
		);
	}
	if (providerInfo?.key === "openai" && provider.authMode === "codex") {
		return [
			provider.apiKey,
			provider.apiKeyEnv,
			provider.accessToken,
			provider.accessTokenEnv,
		].some(hasText);
	}
	return [
		provider.apiKey,
		provider.apiKeyEnv,
		provider.accessToken,
		provider.accessTokenEnv,
		provider.codingApiKey,
		provider.credentialsFile,
		provider.credentialsJson,
	].some(hasText);
}

function toModelRef(providerKey: string, model: string): string {
	return model.startsWith(`${providerKey}/`)
		? model
		: `${providerKey}/${model}`;
}

function buildConfiguredModelOptions(
	providers: Record<string, ProviderConfig>,
	activeProviderKeys: Set<string>,
): { labels: Record<string, string>; values: string[] } {
	const values: string[] = [];
	const labels: Record<string, string> = {};
	const seen = new Set<string>();

	for (const providerInfo of PROVIDERS) {
		const provider = providers[providerInfo.key] ?? {};
		if (
			!isProviderConfigured(provider, providerInfo) &&
			!activeProviderKeys.has(providerInfo.key)
		) {
			continue;
		}

		for (const model of provider.models ?? []) {
			const value = toModelRef(providerInfo.key, model);
			if (seen.has(value)) continue;
			seen.add(value);
			values.push(value);
			labels[value] = `${providerInfo.name}: ${model}`;
		}
	}

	return { labels, values };
}

function normalizeModelOption(
	model: string | undefined,
	availableModels: string[],
): string | undefined {
	if (!model) return undefined;
	if (availableModels.includes(model)) return model;
	if (!model.includes("/")) {
		return availableModels.find((available) => available.endsWith(`/${model}`));
	}
	return undefined;
}

interface BrowserLoginSectionProps {
	provider: string;
	providerName: string;
	isConfigured: boolean;
	onLogin: () => void;
}

function BrowserLoginSection({
	provider,
	providerName,
	isConfigured,
	onLogin,
}: BrowserLoginSectionProps) {
	const [status, setStatus] = useState<
		"idle" | "waiting" | "captured" | "error" | "closed"
	>("idle");
	const [error, setError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const handleLogin = async () => {
		setError(null);
		setStatus("waiting");

		try {
			const res = await fetch(`/api/auth/${provider}/browser-start`, {
				method: "POST",
			});
			const data = (await res.json()) as { ok: boolean; error?: string };
			if (!data.ok) {
				setError(data.error ?? "Failed to start browser");
				setStatus("error");
				return;
			}

			pollRef.current = setInterval(async () => {
				try {
					const pollRes = await fetch(`/api/auth/${provider}/browser-status`);
					const pollData = (await pollRes.json()) as {
						status: string;
					};
					if (pollData.status === "captured") {
						if (pollRef.current) clearInterval(pollRef.current);
						const resultRes = await fetch(
							`/api/auth/${provider}/browser-result`,
							{ method: "POST" },
						);
						await resultRes.json();
						setStatus("captured");
						onLogin();
					} else if (
						pollData.status === "error" ||
						pollData.status === "closed"
					) {
						if (pollRef.current) clearInterval(pollRef.current);
						setStatus(pollData.status as "error" | "closed");
					}
				} catch {
					if (pollRef.current) clearInterval(pollRef.current);
				}
			}, 3000);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Error starting browser");
			setStatus("error");
		}
	};

	useEffect(() => {
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []);

	return (
		<div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 12,
				}}
			>
				<span
					style={{
						display: "inline-block",
						padding: "2px 8px",
						borderRadius: 8,
						fontSize: "0.7rem",
						fontWeight: 600,
						background:
							status === "captured" || isConfigured
								? "rgba(52,211,153,.15)"
								: status === "waiting"
									? "rgba(251,191,36,.15)"
									: status === "error" || status === "closed"
										? "rgba(239,68,68,.15)"
										: "rgba(99,102,241,.15)",
						color:
							status === "captured" || isConfigured
								? "#34d399"
								: status === "waiting"
									? "#fbbf24"
									: status === "error" || status === "closed"
										? "#f87171"
										: "#818cf8",
					}}
				>
					{status === "captured" || isConfigured
						? "Conectado"
						: status === "waiting"
							? "Abriendo navegador..."
							: status === "error" || status === "closed"
								? "Error"
								: "No conectado"}
				</span>
			</div>

			{error && (
				<div
					style={{
						padding: "6px 10px",
						borderRadius: 8,
						background: "rgba(239,68,68,.1)",
						color: "#f87171",
						fontSize: "0.75rem",
						marginBottom: 8,
					}}
				>
					{error}
				</div>
			)}

			<div style={{ display: "flex", gap: 8 }}>
				<button
					type="button"
					disabled={status === "waiting"}
					onClick={handleLogin}
					style={{
						padding: "8px 16px",
						borderRadius: 8,
						border: "none",
						background:
							status === "waiting"
								? "#374151"
								: "linear-gradient(135deg, #6366f1, #8b5cf6)",
						color: "#fff",
						fontSize: "0.8rem",
						fontWeight: 500,
						cursor: status === "waiting" ? "not-allowed" : "pointer",
						opacity: status === "waiting" ? 0.7 : 1,
					}}
				>
					{status === "waiting"
						? "Esperando login en navegador..."
						: `Iniciar sesion via ${providerName}`}
				</button>
			</div>

			<div
				style={{
					marginTop: 8,
					fontSize: "0.7rem",
					color: "#475569",
					lineHeight: 1.4,
				}}
			>
				Abre la pagina de {providerName} en tu navegador para que inicies
				sesion. Octopus AI captura la sesion automaticamente.
			</div>
		</div>
	);
}

interface OAuthLoginSectionProps {
	provider: string;
	providerName: string;
	oauthClientId: string;
	oauthClientSecret: string;
	oauthAccessToken: string;
	oauthExpiresAt?: number;
	onSaveClientId: (v: string) => void;
	onSaveClientSecret: (v: string) => void;
	onTokenSaved: () => void;
}

function OAuthLoginSection({
	provider,
	providerName,
	oauthClientId,
	oauthClientSecret,
	oauthAccessToken,
	oauthExpiresAt,
	onSaveClientId,
	onSaveClientSecret,
	onTokenSaved,
}: OAuthLoginSectionProps) {
	const [clientId, setClientId] = useState(oauthClientId);
	const [clientSecret, setClientSecret] = useState(oauthClientSecret);
	const [loggingIn, setLoggingIn] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tokenStatus, setTokenStatus] = useState<"none" | "valid" | "expired">(
		() => {
			if (!oauthAccessToken) return "none";
			if (oauthExpiresAt && Date.now() > oauthExpiresAt) return "expired";
			return "valid";
		},
	);

	const isLoggedIn = tokenStatus === "valid";

	const handleLogin = async () => {
		if (!clientId.trim()) {
			setError("Client ID es requerido");
			return;
		}

		setError(null);
		setLoggingIn(true);

		try {
			onSaveClientId(clientId.trim());
			if (clientSecret.trim()) onSaveClientSecret(clientSecret.trim());

			const res = await fetch(`/api/auth/${provider}/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					clientId: clientId.trim(),
					clientSecret: clientSecret.trim() || undefined,
				}),
			});

			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "OAuth start failed");
			}

			const data = (await res.json()) as { authorizationUrl: string };
			const popup = window.open(
				data.authorizationUrl,
				"oauth_login",
				"width=600,height=700,scrollbars=yes",
			);

			if (!popup) {
				window.location.href = data.authorizationUrl;
				return;
			}

			const checkClosed = setInterval(() => {
				if (popup.closed) {
					clearInterval(checkClosed);
					setLoggingIn(false);
					onTokenSaved();
				}
			}, 1000);

			setTimeout(() => {
				clearInterval(checkClosed);
				setLoggingIn(false);
				onTokenSaved();
			}, 120000);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Error al iniciar OAuth");
			setLoggingIn(false);
		}
	};

	const handleRefresh = async () => {
		setError(null);
		try {
			const res = await fetch(`/api/auth/${provider}/refresh`, {
				method: "POST",
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Refresh failed");
			}
			setTokenStatus("valid");
			onTokenSaved();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Error al refrescar token");
		}
	};

	return (
		<div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 12,
				}}
			>
				<span
					style={{
						display: "inline-block",
						padding: "2px 8px",
						borderRadius: 8,
						fontSize: "0.7rem",
						fontWeight: 600,
						background: isLoggedIn
							? "rgba(52,211,153,.15)"
							: tokenStatus === "expired"
								? "rgba(251,191,36,.15)"
								: "rgba(99,102,241,.15)",
						color: isLoggedIn
							? "#34d399"
							: tokenStatus === "expired"
								? "#fbbf24"
								: "#818cf8",
					}}
				>
					{isLoggedIn
						? "Conectado"
						: tokenStatus === "expired"
							? "Expirado"
							: "No conectado"}
				</span>
				{isLoggedIn && oauthExpiresAt && (
					<span style={{ fontSize: "0.7rem", color: "#64748b" }}>
						Expira: {new Date(oauthExpiresAt).toLocaleString()}
					</span>
				)}
			</div>

			{!isLoggedIn && (
				<>
					<div style={{ marginBottom: 8 }}>
						<label
							htmlFor={`oauth-client-id-${provider}`}
							style={{
								display: "block",
								fontSize: "0.75rem",
								color: "#94a3b8",
								marginBottom: 4,
							}}
						>
							OAuth Client ID
						</label>
						<input
							id={`oauth-client-id-${provider}`}
							type="text"
							value={clientId}
							placeholder={`${provider} OAuth Client ID`}
							onChange={(e) => setClientId(e.target.value)}
							style={{
								width: "100%",
								padding: "8px 12px",
								borderRadius: 8,
								border: "1px solid #2a303a",
								background: "#090a0d",
								color: "#e2e8f0",
								fontSize: "0.8rem",
								boxSizing: "border-box",
							}}
						/>
					</div>
					<div style={{ marginBottom: 12 }}>
						<label
							htmlFor={`oauth-client-secret-${provider}`}
							style={{
								display: "block",
								fontSize: "0.75rem",
								color: "#94a3b8",
								marginBottom: 4,
							}}
						>
							OAuth Client Secret
							<span style={{ color: "#475569", marginLeft: 4 }}>
								(opcional)
							</span>
						</label>
						<input
							id={`oauth-client-secret-${provider}`}
							type="password"
							value={clientSecret}
							placeholder={`${provider} OAuth Client Secret`}
							onChange={(e) => setClientSecret(e.target.value)}
							style={{
								width: "100%",
								padding: "8px 12px",
								borderRadius: 8,
								border: "1px solid #2a303a",
								background: "#090a0d",
								color: "#e2e8f0",
								fontSize: "0.8rem",
								boxSizing: "border-box",
							}}
						/>
					</div>
				</>
			)}

			{error && (
				<div
					style={{
						padding: "6px 10px",
						borderRadius: 8,
						background: "rgba(239,68,68,.1)",
						color: "#f87171",
						fontSize: "0.75rem",
						marginBottom: 8,
					}}
				>
					{error}
				</div>
			)}

			<div style={{ display: "flex", gap: 8 }}>
				{!isLoggedIn ? (
					<button
						type="button"
						disabled={loggingIn || !clientId.trim()}
						onClick={handleLogin}
						style={{
							padding: "8px 16px",
							borderRadius: 8,
							border: "none",
							background: loggingIn
								? "#374151"
								: "linear-gradient(135deg, #6366f1, #8b5cf6)",
							color: "#fff",
							fontSize: "0.8rem",
							fontWeight: 500,
							cursor: loggingIn ? "not-allowed" : "pointer",
							opacity: loggingIn ? 0.7 : 1,
						}}
					>
						{loggingIn
							? "Esperando autorizacion..."
							: `Iniciar sesion con ${providerName}`}
					</button>
				) : (
					<>
						<button
							type="button"
							onClick={handleRefresh}
							style={{
								padding: "8px 16px",
								borderRadius: 8,
								border: "1px solid #2a303a",
								background: "transparent",
								color: "#94a3b8",
								fontSize: "0.8rem",
								cursor: "pointer",
							}}
						>
							Refrescar token
						</button>
					</>
				)}
			</div>

			<div
				style={{
					marginTop: 8,
					fontSize: "0.7rem",
					color: "#475569",
					lineHeight: 1.4,
				}}
			>
				Necesitas registrar una OAuth App en la consola de {providerName} para
				obtener el Client ID. El redirect URI es:{" "}
				<code
					style={{
						padding: "1px 4px",
						borderRadius: 4,
						background: "rgba(99,102,241,.1)",
						color: "#818cf8",
						fontSize: "0.65rem",
					}}
				>
					http://127.0.0.1:18789/api/auth/{provider}/callback
				</code>
			</div>
		</div>
	);
}

interface VertexSetupSectionProps {
	providerConfig: ProviderConfig;
	onSaveClientId: (v: string) => void;
	onSaveClientSecret: (v: string) => void;
	onTokenSaved: () => void;
	onComplete: () => void;
}

function VertexSetupSection({
	providerConfig,
	onSaveClientId,
	onSaveClientSecret,
	onTokenSaved,
	onComplete,
}: VertexSetupSectionProps) {
	const [projectId, setProjectId] = useState(providerConfig.projectId ?? "");
	const [location, setLocation] = useState(
		providerConfig.location ?? "us-central1",
	);
	const [billingAccountName, setBillingAccountName] = useState("");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<VertexSetupResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const hasGoogleOAuth = hasText(providerConfig.oauthAccessToken);

	const handleSetup = async () => {
		setRunning(true);
		setError(null);
		setResult(null);
		try {
			const response = (await apiPost("/api/auth/google/vertex-setup", {
				projectId: projectId.trim() || undefined,
				location: location.trim() || "us-central1",
				billingAccountName: billingAccountName.trim() || undefined,
			})) as unknown as VertexSetupResponse;
			setResult(response);
			setProjectId(response.projectId);
			onComplete();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setRunning(false);
		}
	};

	return (
		<div style={{ display: "grid", gap: 10 }}>
			{!hasGoogleOAuth ? (
				<div
					style={{
						padding: 12,
						borderRadius: 12,
						border: "1px solid rgba(99,102,241,.28)",
						background: "rgba(99,102,241,.08)",
					}}
				>
					<div
						style={{ color: "#e2e8f0", fontSize: "0.82rem", marginBottom: 10 }}
					>
						Primero inicia sesion con Google OAuth. Octopus usara los permisos
						cloud-platform para preparar Vertex AI.
					</div>
					<OAuthLoginSection
						provider="google"
						providerName="Google Cloud"
						oauthClientId={providerConfig.oauthClientId ?? ""}
						oauthClientSecret={providerConfig.oauthClientSecret ?? ""}
						oauthAccessToken={providerConfig.oauthAccessToken ?? ""}
						oauthExpiresAt={providerConfig.oauthExpiresAt}
						onSaveClientId={onSaveClientId}
						onSaveClientSecret={onSaveClientSecret}
						onTokenSaved={onTokenSaved}
					/>
				</div>
			) : (
				<div
					style={{
						padding: "6px 10px",
						borderRadius: 8,
						background: "rgba(52,211,153,.12)",
						color: "#34d399",
						fontSize: "0.75rem",
					}}
				>
					Google OAuth conectado. Puedes crear un proyecto nuevo sin
					organizacion o reutilizar un Project ID existente.
				</div>
			)}

			<Field
				label="Project ID"
				description="Dejalo vacio para crear automaticamente un proyecto sin organizacion."
				value={projectId}
				placeholder="octopus-ai-vertex"
				onChange={setProjectId}
			/>
			<Field
				label="Region Vertex"
				value={location}
				placeholder="us-central1"
				onChange={setLocation}
			/>
			<Field
				label="Cuenta de facturacion"
				description="Opcional. Usa billingAccounts/XXXXXX-XXXXXX-XXXXXX; vacio usa la primera cuenta abierta disponible."
				value={billingAccountName}
				placeholder="billingAccounts/000000-000000-000000"
				onChange={setBillingAccountName}
			/>

			<button
				type="button"
				disabled={!hasGoogleOAuth || running}
				onClick={handleSetup}
				style={{
					...settingsPrimaryButtonStyle,
					opacity: !hasGoogleOAuth || running ? 0.65 : 1,
					cursor: !hasGoogleOAuth || running ? "not-allowed" : "pointer",
				}}
			>
				{running
					? "Preparando Vertex AI..."
					: "Preparar Vertex AI automaticamente"}
			</button>

			{error && (
				<div
					style={{ color: "#f87171", fontSize: "0.75rem", lineHeight: 1.45 }}
				>
					{error}
				</div>
			)}
			{result && (
				<div
					style={{
						padding: 10,
						borderRadius: 10,
						background: "rgba(15,23,42,.55)",
						border: "1px solid #243044",
						fontSize: "0.75rem",
						color: "#cbd5e1",
						lineHeight: 1.55,
					}}
				>
					<div>Project ID: {result.projectId}</div>
					<div>
						Facturacion: {result.linkedBillingAccount ?? "sin vincular"}
					</div>
					<div>Servicios activados: {result.enabledServices.length}</div>
					<div>Roles IAM ajustados: {result.iamRolesGranted.length}</div>
					{result.billingAccounts.length > 0 && (
						<div>
							Cuentas de facturacion detectadas: {result.billingAccounts.length}
						</div>
					)}
					{result.warnings.length > 0 && (
						<div style={{ color: "#fbbf24", marginTop: 6 }}>
							Advertencias: {result.warnings.join(" | ")}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export const SettingsPage: React.FC = () => {
	const [config, setConfig] = useState<ConfigData>({});
	const [status, setStatus] = useState<StatusResponse | null>(null);
	const [envVars, setEnvVars] = useState<EnvVarEntry[]>([]);
	const [envDraft, setEnvDraft] = useState<EnvVarDraft>(createEmptyEnvDraft);
	const [envEditDrafts, setEnvEditDrafts] = useState<
		Record<string, EnvVarDraft>
	>({});
	const [envEditingKey, setEnvEditingKey] = useState<string | null>(null);
	const [envBusyKey, setEnvBusyKey] = useState<string | null>(null);
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [profileDraft, setProfileDraft] = useState<UserProfile | null>(null);
	const [embeddingDraft, setEmbeddingDraft] = useState<MemoryEmbeddingsConfig>(
		{},
	);
	const [loading, setLoading] = useState(true);
	const [savingKey, setSavingKey] = useState<string | null>(null);
	const [applyingEmbeddings, setApplyingEmbeddings] = useState(false);
	const [secretEditors, setSecretEditors] = useState<Record<string, boolean>>(
		{},
	);
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

	const loadConfig = () => {
		setLoading(true);
		Promise.all([
			apiGet<ConfigData>("/api/config"),
			apiGet<UserProfileResponse>("/api/memory/profile"),
			apiGet<StatusResponse>("/api/status").catch(() => null),
			apiGet<EnvVarEntry[]>("/api/env").catch(() => []),
		])
			.then(([c, profileResponse, statusResponse, envResponse]) => {
				setConfig(c);
				setStatus(statusResponse);
				setEnvVars(envResponse);
				setEmbeddingDraft(c.memory?.embeddings ?? {});
				setProfile(profileResponse.profile);
				setProfileDraft(profileResponse.profile);
				setLoading(false);
			})
			.catch((e) => {
				setMsg({ text: e.message, ok: false });
				setLoading(false);
			});
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only fetch
	useEffect(() => {
		loadConfig();
	}, []);

	const save = async (key: string, value: unknown): Promise<boolean> => {
		setMsg(null);
		setSavingKey(key);
		let previousConfig: ConfigData | null = null;
		setConfig((current) => {
			previousConfig = current;
			return setConfigValue(current, key, value);
		});
		try {
			await apiPut(`/api/config/${key}`, value);
			if (key.startsWith("ai.")) {
				apiGet<StatusResponse>("/api/status")
					.then(setStatus)
					.catch(() => undefined);
			}
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
			return true;
		} catch (e) {
			if (previousConfig) setConfig(previousConfig);
			setMsg({
				text: e instanceof Error ? e.message : String(e),
				ok: false,
			});
			return false;
		} finally {
			setSavingKey(null);
		}
	};

	const setSecretEditing = (secretKey: string, editing: boolean) => {
		setSecretEditors((current) => ({ ...current, [secretKey]: editing }));
	};

	const refreshConfig = () => loadConfig();

	const refreshEnvVars = async () => {
		setEnvVars(await apiGet<EnvVarEntry[]>("/api/env"));
	};

	const startEnvEdit = (entry: EnvVarEntry) => {
		setMsg(null);
		setEnvEditingKey(entry.key);
		setEnvEditDrafts((current) => ({
			...current,
			[entry.key]: {
				key: entry.key,
				value: entry.is_secret ? "" : entry.value,
				description: entry.description ?? "",
				isSecret: entry.is_secret === 1,
			},
		}));
	};

	const saveEnvDraft = async (draft: EnvVarDraft, existing?: EnvVarEntry) => {
		const key = draft.key.trim();
		if (!ENV_VAR_KEY_PATTERN.test(key)) {
			setMsg({
				text: "Nombre inválido. Usa letras, números y guiones bajos; debe iniciar con letra o guion bajo.",
				ok: false,
			});
			return;
		}
		if (!existing && !draft.value) {
			setMsg({ text: "El valor de la variable es obligatorio", ok: false });
			return;
		}

		const body: Record<string, unknown> = {
			key,
			description: draft.description.trim() || null,
			isSecret: draft.isSecret,
		};
		if (!existing || !existing.is_secret || draft.value.length > 0) {
			body.value = draft.value;
		}

		setMsg(null);
		setEnvBusyKey(key);
		try {
			await apiPost("/api/env", body);
			await refreshEnvVars();
			if (existing) {
				setEnvEditingKey(null);
				setEnvEditDrafts((current) => {
					const next = { ...current };
					delete next[existing.key];
					return next;
				});
			} else {
				setEnvDraft(createEmptyEnvDraft());
			}
			setMsg({ text: `${key} guardado`, ok: true });
			setTimeout(() => setMsg(null), 3000);
		} catch (e) {
			setMsg({
				text: e instanceof Error ? e.message : String(e),
				ok: false,
			});
		} finally {
			setEnvBusyKey(null);
		}
	};

	const deleteEnvVar = async (key: string) => {
		setMsg(null);
		setEnvBusyKey(key);
		try {
			await apiDelete(`/api/env/${encodeURIComponent(key)}`);
			await refreshEnvVars();
			setMsg({ text: `${key} eliminado`, ok: true });
			setTimeout(() => setMsg(null), 3000);
		} catch (e) {
			setMsg({
				text: e instanceof Error ? e.message : String(e),
				ok: false,
			});
		} finally {
			setEnvBusyKey(null);
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
	const orchestration = config.orchestration ?? {};
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
	const activeProviderKeys = new Set(status?.availableProviders ?? []);
	const configuredModels = buildConfiguredModelOptions(
		providers,
		activeProviderKeys,
	);
	const noConfiguredModelsOption = "(configura un proveedor primero)";
	const modelOptions =
		configuredModels.values.length > 0
			? configuredModels.values
			: [noConfiguredModelsOption];
	const savedDefaultModel = ai.default ?? "zhipu/glm-5.1";
	const normalizedDefaultModel = normalizeModelOption(
		savedDefaultModel,
		configuredModels.values,
	);
	const normalizedFallbackModel = normalizeModelOption(
		ai.fallback,
		configuredModels.values,
	);
	const defaultModelValue = normalizedDefaultModel ?? modelOptions[0];
	const fallbackModelValue = normalizedFallbackModel ?? "(ninguno)";
	const selectedContextWindow =
		defaultModelValue === noConfiguredModelsOption
			? null
			: getModelContextWindow(defaultModelValue);
	const renderSecretEditor = ({
		configured,
		fieldKey,
		inputName,
		lockedPlaceholder = "••••••••••••••••",
		unlockedPlaceholder,
	}: {
		configured: boolean;
		fieldKey: string;
		inputName: string;
		lockedPlaceholder?: string;
		unlockedPlaceholder: string;
	}) => {
		const editing = !configured || secretEditors[fieldKey] === true;
		return (
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (!editing) {
						setSecretEditing(fieldKey, true);
						return;
					}
					const form = e.currentTarget;
					const formData = new FormData(form);
					const value = String(formData.get(inputName) ?? "").trim();
					if (value) {
						void save(fieldKey, value).then((ok) => {
							if (!ok) return;
							form.reset();
							setSecretEditing(fieldKey, false);
						});
					}
				}}
				style={{ display: "flex", gap: "8px" }}
			>
				<input
					id={inputName}
					name={inputName}
					type="password"
					autoComplete="off"
					disabled={!editing}
					placeholder={
						configured && !editing ? lockedPlaceholder : unlockedPlaceholder
					}
					style={{
						flex: 1,
						padding: "8px 12px",
						borderRadius: "8px",
						border: "1px solid #343a46",
						background: editing ? "#05070a" : "#07080b",
						color: editing ? "#f4f4f5" : "#a1a1aa",
						fontSize: "0.85rem",
						outline: "none",
						fontFamily: "ui-monospace, SFMono-Regular, Monaco, monospace",
						transition: "border-color 0.2s",
						cursor: editing ? "text" : "not-allowed",
					}}
					onFocus={(e) => {
						e.target.style.borderColor = "#818cf8";
						e.target.style.boxShadow = "0 0 0 3px rgba(129, 140, 248, 0.16)";
					}}
					onBlur={(e) => {
						e.target.style.borderColor = "#343a46";
						e.target.style.boxShadow = "none";
					}}
				/>
				<button type="submit" style={settingsPrimaryButtonStyle}>
					{editing ? "Guardar" : "Editar"}
				</button>
			</form>
		);
	};

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
				background:
					"radial-gradient(circle at 20% 0%, rgba(99,102,241,.09), transparent 34%), #030406",
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
							color: "#9ca3af",
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
						style={{ margin: "8px 0 0", color: "#a1a1aa", fontSize: "0.98rem" }}
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
					background: "linear-gradient(180deg, #18181b 0%, #101013 100%)",
					border: "1px solid #27272a",
					color: "#a1a1aa",
					boxShadow: "0 12px 30px rgba(0,0,0,.28)",
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

			<UsageSection />

			<ConfigSection
				title="Variables de entorno"
				icon={<AppIcon name="key" size={17} />}
				category="entorno"
				description="Consulta, crea, edita y elimina variables guardadas. Los secretos se muestran enmascarados; para cambiarlos escribe un nuevo valor."
				defaultOpen={false}
			>
				<div style={{ display: "grid", gap: "16px" }}>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void saveEnvDraft(envDraft);
						}}
						style={settingsPanelStyle}
					>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
								gap: "12px",
								alignItems: "end",
							}}
						>
							<label style={{ display: "grid", gap: "6px", color: "#a1a1aa" }}>
								<span style={{ fontSize: "0.78rem", fontWeight: 800 }}>
									Nombre
								</span>
								<input
									value={envDraft.key}
									onChange={(e) =>
										setEnvDraft((current) => ({
											...current,
											key: e.target.value.toUpperCase(),
										}))
									}
									placeholder="GEMINI_API_KEY"
									style={{
										...envInputStyle,
										fontFamily:
											"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
									}}
								/>
							</label>
							<label style={{ display: "grid", gap: "6px", color: "#a1a1aa" }}>
								<span style={{ fontSize: "0.78rem", fontWeight: 800 }}>
									Valor
								</span>
								<input
									type={envDraft.isSecret ? "password" : "text"}
									value={envDraft.value}
									onChange={(e) =>
										setEnvDraft((current) => ({
											...current,
											value: e.target.value,
										}))
									}
									placeholder="Valor guardado"
									autoComplete="off"
									style={envInputStyle}
								/>
							</label>
							<label style={{ display: "grid", gap: "6px", color: "#a1a1aa" }}>
								<span style={{ fontSize: "0.78rem", fontWeight: 800 }}>
									Descripción
								</span>
								<input
									value={envDraft.description}
									onChange={(e) =>
										setEnvDraft((current) => ({
											...current,
											description: e.target.value,
										}))
									}
									placeholder="Opcional"
									style={envInputStyle}
								/>
							</label>
						</div>
						<div
							style={{
								display: "flex",
								gap: "10px",
								alignItems: "center",
								justifyContent: "space-between",
								flexWrap: "wrap",
								marginTop: "14px",
							}}
						>
							<label
								style={{
									display: "inline-flex",
									gap: "8px",
									alignItems: "center",
									color: "#d4d4d8",
									fontSize: "0.86rem",
								}}
							>
								<input
									type="checkbox"
									checked={envDraft.isSecret}
									onChange={(e) =>
										setEnvDraft((current) => ({
											...current,
											isSecret: e.target.checked,
										}))
									}
								/>
								Guardar como secreto
							</label>
							<button
								type="submit"
								disabled={envBusyKey === envDraft.key.trim()}
								style={settingsPrimaryButtonStyle}
							>
								{envBusyKey === envDraft.key.trim()
									? "Guardando..."
									: "Crear variable"}
							</button>
						</div>
					</form>

					<div style={{ display: "grid", gap: "10px" }}>
						{envVars.length === 0 ? (
							<div
								style={{
									...settingsMutedPanelStyle,
									color: "#9ca3af",
									fontSize: "0.88rem",
								}}
							>
								No hay variables guardadas todavía.
							</div>
						) : (
							envVars.map((entry) => {
								const editing = envEditingKey === entry.key;
								const draft = envEditDrafts[entry.key] ?? {
									key: entry.key,
									value: entry.is_secret ? "" : entry.value,
									description: entry.description ?? "",
									isSecret: entry.is_secret === 1,
								};

								return (
									<div key={entry.id} style={settingsMutedPanelStyle}>
										<div
											style={{
												display: "flex",
												justifyContent: "space-between",
												gap: "12px",
												alignItems: "flex-start",
												flexWrap: "wrap",
											}}
										>
											<div>
												<div
													style={{
														color: "#f4f4f5",
														fontWeight: 850,
														fontFamily:
															"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
													}}
												>
													{entry.key}
												</div>
												<div
													style={{
														color: entry.is_secret ? "#fbbf24" : "#86efac",
														fontSize: "0.76rem",
														marginTop: "4px",
													}}
												>
													{entry.is_secret ? "Secreto" : "Texto visible"}
												</div>
											</div>

											{!editing && (
												<div style={{ display: "flex", gap: "8px" }}>
													<button
														type="button"
														onClick={() => startEnvEdit(entry)}
														style={settingsSecondaryButtonStyle}
													>
														Editar
													</button>
													<button
														type="button"
														disabled={envBusyKey === entry.key}
														onClick={() => void deleteEnvVar(entry.key)}
														style={settingsDangerButtonStyle}
													>
														{envBusyKey === entry.key
															? "Eliminando..."
															: "Eliminar"}
													</button>
												</div>
											)}
										</div>

										{editing ? (
											<form
												onSubmit={(e) => {
													e.preventDefault();
													void saveEnvDraft(draft, entry);
												}}
												style={{
													display: "grid",
													gap: "10px",
													marginTop: "14px",
												}}
											>
												<input
													value={draft.value}
													type={draft.isSecret ? "password" : "text"}
													placeholder={
														entry.is_secret
															? "Nuevo valor secreto; déjalo vacío para conservarlo"
															: "Valor"
													}
													autoComplete="off"
													onChange={(e) =>
														setEnvEditDrafts((current) => ({
															...current,
															[entry.key]: { ...draft, value: e.target.value },
														}))
													}
													style={envInputStyle}
												/>
												<input
													value={draft.description}
													placeholder="Descripción opcional"
													onChange={(e) =>
														setEnvEditDrafts((current) => ({
															...current,
															[entry.key]: {
																...draft,
																description: e.target.value,
															},
														}))
													}
													style={envInputStyle}
												/>
												<div
													style={{
														display: "flex",
														gap: "10px",
														alignItems: "center",
														justifyContent: "space-between",
														flexWrap: "wrap",
													}}
												>
													<label
														style={{
															display: "inline-flex",
															gap: "8px",
															alignItems: "center",
															color: "#d4d4d8",
															fontSize: "0.86rem",
														}}
													>
														<input
															type="checkbox"
															checked={draft.isSecret}
															onChange={(e) =>
																setEnvEditDrafts((current) => ({
																	...current,
																	[entry.key]: {
																		...draft,
																		isSecret: e.target.checked,
																	},
																}))
															}
														/>
														Guardar como secreto
													</label>
													<div style={{ display: "flex", gap: "8px" }}>
														<button
															type="submit"
															style={settingsPrimaryButtonStyle}
														>
															{envBusyKey === entry.key
																? "Guardando..."
																: "Guardar"}
														</button>
														<button
															type="button"
															onClick={() => setEnvEditingKey(null)}
															style={settingsSecondaryButtonStyle}
														>
															Cancelar
														</button>
													</div>
												</div>
											</form>
										) : (
											<div
												style={{
													marginTop: "14px",
													display: "grid",
													gap: "8px",
												}}
											>
												<code
													style={{
														padding: "9px 11px",
														borderRadius: "10px",
														background: "#05070a",
														border: "1px solid #222733",
														color: "#d4d4d8",
														fontSize: "0.82rem",
														overflowWrap: "anywhere",
													}}
												>
													{entry.value}
												</code>
												{entry.description && (
													<div
														style={{ color: "#a1a1aa", fontSize: "0.82rem" }}
													>
														{entry.description}
													</div>
												)}
												<div style={{ color: "#71717a", fontSize: "0.74rem" }}>
													Actualizada:{" "}
													{new Date(entry.updated_at).toLocaleString()}
												</div>
											</div>
										)}
									</div>
								);
							})
						)}
					</div>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Perfil de usuario"
				icon={<AppIcon name="user" size={17} />}
				category="personalizacion"
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
				category="personalizacion"
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
				category="navegacion"
				description="Ajustes del motor de navegación y evasión de bloqueos."
				defaultOpen={true}
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
							description="Opcional. URL del proxy residencial (puede incluir usuario:password). Déjala vacía para usar los campos siguientes o las variables de entorno DECODO_PROXY_URL / DECODO_PROXY_USERNAME."
						/>
						<Field
							label="Usuario del proxy"
							value={browser.decodoProxyUsername ?? ""}
							onChange={(v) => save("browser.decodoProxyUsername", v)}
							placeholder="user-xxxxx"
							description="Usuario Decodo. Si la Proxy URL ya incluye usuario:password, puedes dejarlo vacío."
						/>
						<Field
							label="Contraseña del proxy"
							type="password"
							value={browser.decodoProxyPassword ?? ""}
							onChange={(v) => save("browser.decodoProxyPassword", v)}
							placeholder="••••••••"
							description="Contraseña Decodo. Déjala vacía para usar DECODO_PROXY_PASSWORD del entorno."
						/>
						<Field
							label="País (geo-targeting)"
							value={browser.decodoProxyCountry ?? ""}
							onChange={(v) => save("browser.decodoProxyCountry", v)}
							placeholder="es"
							description="Código ISO de país (ej: es, us, mx, de). Acopla timezone, locale y geolocalización del navegador a la IP del proxy."
						/>
						<Field
							label="Ciudad"
							value={browser.decodoProxyCity ?? ""}
							onChange={(v) => save("browser.decodoProxyCity", v)}
							placeholder="Madrid"
							description="Opcional. Geo-targeting por ciudad."
						/>
						<Field
							label="Estado / Región"
							value={browser.decodoProxyState ?? ""}
							onChange={(v) => save("browser.decodoProxyState", v)}
							description="Opcional. Geo-targeting por estado."
						/>
						<Field
							label="Código postal"
							value={browser.decodoProxyZip ?? ""}
							onChange={(v) => save("browser.decodoProxyZip", v)}
							description="Opcional. Geo-targeting por ZIP."
						/>
						<Field
							label="ID de sesión"
							value={browser.decodoProxySession ?? ""}
							onChange={(v) => save("browser.decodoProxySession", v)}
							placeholder="sess01"
							description="Opcional. IP pegajosa: misma sesión = misma IP entre peticiones."
						/>
						<Field
							label="Duración de sesión (min)"
							value={browser.decodoProxySessionDuration ?? ""}
							onChange={(v) => save("browser.decodoProxySessionDuration", v)}
							placeholder="10"
							description="Opcional. Cuánto mantener la misma IP antes de rotar."
						/>
						<Field
							label="Token del Scraper API"
							type="password"
							value={browser.decodoScraperToken ?? ""}
							onChange={(v) => save("browser.decodoScraperToken", v)}
							placeholder="Basic ..."
							description="Token de la API de scraping de Decodo (decodo_scrape). Distinto del proxy. Déjalo vacío para usar DECODO_SCRAPER_TOKEN del entorno."
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
						<Field
							label="2captcha API Key"
							type="password"
							value={browser.captchaApiKey ?? ""}
							onChange={(v) => save("browser.captchaApiKey", v)}
							placeholder="••••••••"
							description="Clave de 2captcha para resolver reCAPTCHA/hCaptcha/Turnstile. Déjala vacía para usar TWOCAPTCHA_API_KEY del entorno."
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
				category="inteligencia"
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
				title="Orquestación multi-agente"
				icon={<AppIcon name="agent" size={17} />}
				category="inteligencia"
				description="Controla workflows durables, brazos paralelos, reintentos y límites de subagentes. Algunos cambios aplican al reiniciar Octopus."
				defaultOpen={false}
			>
				<div style={settingsPanelStyle}>
					<Toggle
						label="Habilitar orquestación durable"
						value={orchestration.enabled ?? true}
						onChange={(v) => save("orchestration.enabled", v)}
						description="Permite que Octopus divida objetivos complejos entre sus brazos y persista runs, subtareas y artefactos."
					/>
					<Select
						label="Modo de workflow"
						value={orchestration.mode ?? "durable"}
						options={["durable", "legacy", "hybrid"]}
						onChange={(v) => save("orchestration.mode", v)}
						description="durable es el camino principal; legacy queda como referencia/fallback interno."
					/>
					<Field
						label="Máximo de brazos"
						value={orchestration.maxArms ?? 8}
						type="number"
						description="Límite de agentes/brazos paralelos por ejecución. Máximo recomendado: 8."
						onChange={(v) =>
							save(
								"orchestration.maxArms",
								Math.min(8, Math.max(1, Number.parseInt(v, 10) || 8)),
							)
						}
					/>
					<Field
						label="Timeout por brazo (ms)"
						value={orchestration.workerTimeoutMs ?? 600000}
						type="number"
						description="Tiempo máximo por worker antes de considerarlo fallido o interrumpido."
						onChange={(v) =>
							save(
								"orchestration.workerTimeoutMs",
								Math.max(1000, Number.parseInt(v, 10) || 600000),
							)
						}
					/>
					<Field
						label="Iteraciones por brazo"
						value={orchestration.maxToolIterationsPerArm ?? 32}
						type="number"
						description="Máximo de ciclos con herramientas para cada brazo especializado."
						onChange={(v) =>
							save(
								"orchestration.maxToolIterationsPerArm",
								Math.max(1, Number.parseInt(v, 10) || 32),
							)
						}
					/>
					<Field
						label="Intentos sin avance"
						value={orchestration.maxStagnantAttempts ?? 5}
						type="number"
						description="Tras estos fallos en el mismo paso sin nueva evidencia, la subtarea se bloquea y reporta razón."
						onChange={(v) =>
							save(
								"orchestration.maxStagnantAttempts",
								Math.max(1, Number.parseInt(v, 10) || 5),
							)
						}
					/>
					<Field
						label="Profundidad máxima de subagentes"
						value={orchestration.maxSpawnDepth ?? 2}
						type="number"
						description="Controla recursión de subagentes para evitar ciclos o crecimiento indefinido."
						onChange={(v) =>
							save(
								"orchestration.maxSpawnDepth",
								Math.min(5, Math.max(0, Number.parseInt(v, 10) || 2)),
							)
						}
					/>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Modelos y Proveedores AI"
				icon={<AppIcon name="brain" size={17} />}
				category="inteligencia"
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
						const currentAuthMode =
							prov.authMode ?? p.defaultAuthMode ?? "api-key";
						const configured = isProviderConfigured(prov, p);
						const apiKeyConfigured = [
							prov.apiKey,
							prov.apiKeyEnv,
							prov.codingApiKey,
						].some(hasText);
						const accessTokenConfigured = [
							prov.accessToken,
							prov.accessTokenEnv,
						].some(hasText);
						const active = activeProviderKeys.has(p.key);
						const statusText = active
							? "Activo"
							: configured
								? "Configurado"
								: "No config.";
						return (
							<div
								key={p.key}
								style={{
									padding: "16px",
									borderRadius: "16px",
									background:
										"linear-gradient(180deg, #111318 0%, #090a0d 100%)",
									border: "1px solid #2a303a",
									boxShadow:
										"0 16px 42px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.04)",
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
									<StatusBadge ok={active || configured} text={statusText} />
								</div>
								{p.isLocal ? (
									<Field
										label="URL Base (Local)"
										value={prov.baseUrl ?? "http://localhost:11434"}
										onChange={(v) => save(`ai.providers.${p.key}.baseUrl`, v)}
									/>
								) : (
									<div style={{ marginBottom: "12px" }}>
										{p.authModes && (
											<Select
												label="Metodo de conexion"
												value={currentAuthMode}
												options={p.authModes.map((mode) => mode.value)}
												optionLabels={Object.fromEntries(
													p.authModes.map((mode) => [mode.value, mode.label]),
												)}
												onChange={(v) =>
													save(`ai.providers.${p.key}.authMode`, v)
												}
											/>
										)}
										{p.key === "vertex" ? (
											<>
												<VertexSetupSection
													providerConfig={prov}
													onSaveClientId={(v) =>
														save(`ai.providers.${p.key}.oauthClientId`, v)
													}
													onSaveClientSecret={(v) =>
														save(`ai.providers.${p.key}.oauthClientSecret`, v)
													}
													onTokenSaved={() => refreshConfig()}
													onComplete={() => refreshConfig()}
												/>
												<div style={{ marginTop: 10 }}>
													<Field
														label="Archivo credenciales manual"
														value={prov.credentialsFile ?? ""}
														placeholder="C:\\ruta\\service-account.json"
														onChange={(v) =>
															save(`ai.providers.${p.key}.credentialsFile`, v)
														}
													/>
												</div>
											</>
										) : currentAuthMode === "oauth" ? (
											<OAuthLoginSection
												provider={p.key}
												providerName={p.name}
												oauthClientId={prov.oauthClientId ?? ""}
												oauthClientSecret={prov.oauthClientSecret ?? ""}
												oauthAccessToken={prov.oauthAccessToken ?? ""}
												oauthExpiresAt={prov.oauthExpiresAt}
												onSaveClientId={(v) =>
													save(`ai.providers.${p.key}.oauthClientId`, v)
												}
												onSaveClientSecret={(v) =>
													save(`ai.providers.${p.key}.oauthClientSecret`, v)
												}
												onTokenSaved={() => refreshConfig()}
											/>
										) : currentAuthMode === "browser" ||
										  (p.key === "openai" &&
												currentAuthMode === "codex") ? (
											<BrowserLoginSection
												provider={p.key}
												providerName={p.name}
												isConfigured={Boolean(
													prov.browserCookies || prov.accessToken,
												)}
												onLogin={() => refreshConfig()}
											/>
										) : (
											<>
												{renderSecretEditor({
													configured: apiKeyConfigured,
													fieldKey: `ai.providers.${p.key}.apiKey`,
													inputName: `provider-${p.key}-api-key`,
													unlockedPlaceholder:
														currentAuthMode === "bearer"
															? "Bearer token"
															: apiKeyConfigured
																? "Nueva API Key"
																: "Introduce tu API Key",
												})}
												{p.key === "openai" && currentAuthMode === "codex" && (
													<>
														{renderSecretEditor({
															configured: accessTokenConfigured,
															fieldKey: `ai.providers.${p.key}.accessToken`,
															inputName: `provider-${p.key}-access-token`,
															unlockedPlaceholder: accessTokenConfigured
																? "Nuevo access token"
																: "Access token Codex",
														})}
													</>
												)}
											</>
										)}
									</div>
								)}
								{p.hasMode && (
									<div style={{ marginTop: 8 }}>
										<Select
											label="Modo de Operación"
											value={prov.mode ?? "coding-global"}
											options={["coding-global", "global"]}
											optionLabels={{
												"coding-global": "Coding Plan",
												global: "Global",
											}}
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
						description="Solo muestra modelos de proveedores configurados o activos."
						value={defaultModelValue}
						options={modelOptions}
						optionLabels={configuredModels.labels}
						onChange={(v) => {
							if (v !== noConfiguredModelsOption) void save("ai.default", v);
						}}
					/>
					<Select
						label="Modelo de Respaldo"
						description="Se usará si el modelo por defecto falla; también se limita a proveedores configurados."
						value={fallbackModelValue}
						options={["(ninguno)", ...configuredModels.values]}
						optionLabels={configuredModels.labels}
						onChange={(v) => save("ai.fallback", v === "(ninguno)" ? "" : v)}
					/>
					<Select
						label="Nivel de Razonamiento (Thinking)"
						description="Profundidad del análisis antes de responder. 'Máximo' (xhigh) solo aplica a gpt-5.x; otros modelos se ajustan solos."
						value={ai.thinking ?? "medium"}
						options={["none", "low", "medium", "high", "xhigh"]}
						onChange={(v) => save("ai.thinking", v)}
					/>
					<div style={{ marginBottom: "16px" }}>
						<div
							style={{
								fontSize: "0.85rem",
								color: "#a1a1aa",
								marginBottom: "6px",
								fontWeight: 700,
							}}
						>
							Ventana de contexto del modelo
						</div>
						<div
							style={{
								fontSize: "0.76rem",
								color: "#9ca3af",
								marginBottom: "9px",
								lineHeight: 1.45,
							}}
						>
							Se calcula automaticamente segun el modelo seleccionado; no se
							guarda manualmente.
						</div>
						<div
							style={{
								width: "100%",
								padding: "12px 14px",
								borderRadius: "12px",
								border: "1px solid #343a46",
								background: "#05070a",
								color: "#f4f4f5",
								fontSize: "0.95rem",
								boxSizing: "border-box",
							}}
						>
							{selectedContextWindow
								? `${formatModelContextWindow(selectedContextWindow)} tokens`
								: "Configura un proveedor primero"}
						</div>
					</div>
					<Field
						label="Maximo de tokens de salida"
						description="Limite de generacion por respuesta. La ventana de contexto se ajusta automaticamente segun el modelo."
						value={ai.maxTokens ?? 16384}
						type="number"
						onChange={(v) => save("ai.maxTokens", Number.parseInt(v) || 16384)}
					/>
				</div>
			</ConfigSection>

			<ConfigSection
				title="Memoria Autónoma"
				icon={<AppIcon name="database" size={17} />}
				category="memoria"
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
												color: "#9ca3af",
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
												border: "1px solid #343a46",
												background: "#05070a",
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
								color: "#9ca3af",
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
				category="memoria"
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
					category="sistema"
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
					category="sistema"
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
