import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon } from "../components/ui/AppIcon.js";
import { API_BASE, apiGet, apiPost, apiPutJson } from "../hooks/useApi.js";
import { publicAsset } from "../utils/assets.js";

interface AgentRecord {
	id: string;
	name: string;
	description: string | null;
	role: string;
	personality: string | null;
	system_prompt: string;
	model: string | null;
	avatar: string | null;
	color: string | null;
	is_default: number;
	is_main: number;
	parent_id: string | null;
	created_at: string;
	updated_at: string;
	config: string | null;
	is_builtin_arm?: number;
	arm_key?: string | null;
	base_profile?: string | null;
	capabilities?: string | null;
	tool_permissions?: string | null;
	knowledge_base_ids?: string | null;
	fallback_model?: string | null;
	can_spawn_subagents?: number;
	max_spawn_depth?: number;
	effectiveModel?: string;
	reasoningEffort?: string;
}

interface AgentFormData {
	name: string;
	role: string;
	personality: string;
	description: string;
	systemPrompt: string;
	model: string;
	reasoningEffort: string;
	fallbackModel: string;
	avatar: string;
	color: string;
	capabilitiesText: string;
	toolPermissionMode: string;
	toolPermissionTools: string;
	knowledgeBaseIds: string[];
	canSpawnSubagents: boolean;
	maxSpawnDepth: string;
	maxTokens: string;
	temperature: string;
}

interface AgentStoredMessage {
	id: string;
	run_id: string | null;
	from_agent_id: string;
	to_agent_id: string | null;
	task_id: string | null;
	message_type: string;
	content: string;
	created_at: string;
	read_at: string | null;
	metadata: string | null;
}

interface KnowledgeCollection {
	id: string;
	name: string;
}

interface ModelOptionGroup {
	providerKey: string;
	providerName: string;
	models: Array<{ value: string; label: string }>;
}

interface ModelsResponse {
	providers?: Array<{
		provider: string;
		providerDisplayName: string;
		models: string[];
	}>;
	modelCapabilities?: Array<{
		provider: string;
		model: string;
		supportsReasoning: boolean;
		allowedReasoningEfforts: string[];
		defaultReasoningEffort: string;
	}>;
}

const ROLE_OPTIONS = [
	"assistant",
	"coder",
	"researcher",
	"writer",
	"analyst",
	"coordinator",
];

const REASONING_LABELS: Record<string, string> = {
	none: "Sin razonamiento",
	low: "Bajo",
	medium: "Medio",
	high: "Alto",
	xhigh: "Máximo",
};

const MESSAGE_TYPE_OPTIONS = [
	"message",
	"broadcast",
	"progress",
	"question",
	"result",
	"spawn_request",
];

const ROLE_ICONS: Record<string, string> = {
	assistant: "🤖",
	coder: "💻",
	researcher: "🔍",
	writer: "✍️",
	analyst: "📊",
	coordinator: "🎯",
};

const EMPTY_FORM: AgentFormData = {
	name: "",
	role: "assistant",
	personality: "",
	description: "",
	systemPrompt: "",
	model: "",
	reasoningEffort: "none",
	fallbackModel: "",
	avatar: "🤖",
	color: "#3b82f6",
	capabilitiesText: "",
	toolPermissionMode: "inherit",
	toolPermissionTools: "",
	knowledgeBaseIds: [],
	canSpawnSubagents: true,
	maxSpawnDepth: "2",
	maxTokens: "",
	temperature: "",
};

function parseJsonObject(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseJsonStringArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function splitList(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function joinList(items: string[]): string {
	return items.join("\n");
}

function toModelRef(providerKey: string, model: string): string {
	return model.startsWith(`${providerKey}/`)
		? model
		: `${providerKey}/${model}`;
}

function buildModelGroups(response: ModelsResponse): ModelOptionGroup[] {
	const seen = new Set<string>();
	return (response.providers ?? [])
		.map((providerInfo) => {
			const models = providerInfo.models
				.map((model) => {
					const value = toModelRef(providerInfo.provider, model);
					if (seen.has(value)) return null;
					seen.add(value);
					return { value, label: model };
				})
				.filter((item): item is { value: string; label: string } =>
					Boolean(item),
				);
			return models.length > 0
				? {
						providerKey: providerInfo.provider,
						providerName: providerInfo.providerDisplayName,
						models,
					}
				: null;
		})
		.filter((item): item is ModelOptionGroup => Boolean(item));
}

function modelValues(groups: ModelOptionGroup[]): string[] {
	return groups.flatMap((group) => group.models.map((model) => model.value));
}

function normalizeModelValue(
	model: string,
	groups: ModelOptionGroup[],
): string {
	if (!model) return "";
	const values = modelValues(groups);
	if (values.includes(model)) return model;
	if (!model.includes("/")) {
		return values.find((value) => value.endsWith(`/${model}`)) ?? model;
	}
	return model;
}

function avatarImageSrc(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(trimmed)) return null;
	if (/^(https?:|data:|\/)/i.test(trimmed)) return trimmed;
	return publicAsset(`mascotas/${trimmed}`);
}

function displayAgentName(agent: AgentRecord): string {
	return agent.is_main === 1 && agent.name === "Octopus AI"
		? "Octavio"
		: agent.name;
}

function displayAgentDescription(agent: AgentRecord): string | null {
	return agent.is_main === 1 && agent.description === "Default Octopus AI agent"
		? "Agente principal de Octopus AI"
		: agent.description;
}

function displayAgentAvatar(agent: AgentRecord): string | null {
	return agent.is_main === 1
		? (agent.avatar ?? "Pulpo_octavio.png")
		: agent.avatar;
}

async function deleteAgent(id: string): Promise<void> {
	const res = await fetch(`${API_BASE}/api/agents/${id}`, { method: "DELETE" });
	if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export const AgentsPage: React.FC = () => {
	const [agents, setAgents] = useState<AgentRecord[]>([]);
	const [knowledgeCollections, setKnowledgeCollections] = useState<
		KnowledgeCollection[]
	>([]);
	const [modelGroups, setModelGroups] = useState<ModelOptionGroup[]>([]);
	const [modelCapabilities, setModelCapabilities] = useState<
		Record<
			string,
			{
				supportsReasoning: boolean;
				allowedReasoningEfforts: string[];
				defaultReasoningEffort: string;
			}
		>
	>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
	const [showForm, setShowForm] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<AgentFormData>({ ...EMPTY_FORM });
	const [saving, setSaving] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
	const [selectedInboxAgentId, setSelectedInboxAgentId] = useState("");
	const [selectedFromAgentId, setSelectedFromAgentId] = useState("");
	const [selectedToAgentId, setSelectedToAgentId] = useState("broadcast");
	const [messageType, setMessageType] = useState("message");
	const [messageContent, setMessageContent] = useState("");
	const [agentMessages, setAgentMessages] = useState<AgentStoredMessage[]>([]);
	const [messagesLoading, setMessagesLoading] = useState(false);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [showBroadcasts, setShowBroadcasts] = useState(false);
	const editingAgent = editingId
		? (agents.find((agent) => agent.id === editingId) ?? null)
		: null;
	const editingBuiltinArm = editingAgent?.is_builtin_arm === 1;

	const loadAgents = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [data, collections, models] = await Promise.all([
				apiGet<AgentRecord[]>("/api/agents"),
				apiGet<KnowledgeCollection[]>(
					"/api/memory/knowledge/collections",
				).catch(() => []),
				apiGet<ModelsResponse>("/api/models").catch(
					(): ModelsResponse => ({ providers: [] }),
				),
			]);
			setAgents(data);
			setKnowledgeCollections(collections);
			setModelGroups(buildModelGroups(models));
			const capsMap: Record<
				string,
				{
					supportsReasoning: boolean;
					allowedReasoningEfforts: string[];
					defaultReasoningEffort: string;
				}
			> = {};
			for (const c of models.modelCapabilities ?? []) {
				capsMap[`${c.provider}/${c.model}`] = {
					supportsReasoning: c.supportsReasoning,
					allowedReasoningEfforts: c.allowedReasoningEfforts,
					defaultReasoningEffort: c.defaultReasoningEffort,
				};
			}
			setModelCapabilities(capsMap);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadAgents();
	}, [loadAgents]);

	useEffect(() => {
		if (agents.length === 0) return;
		const mainAgent = agents.find((agent) => agent.is_main === 1) ?? agents[0];
		if (!selectedInboxAgentId) setSelectedInboxAgentId(mainAgent.id);
		if (!selectedFromAgentId) setSelectedFromAgentId(mainAgent.id);
	}, [agents, selectedFromAgentId, selectedInboxAgentId]);

	const loadAgentMessages = useCallback(async () => {
		if (!selectedInboxAgentId) return;
		setAgentMessages([]);
		setMessagesLoading(true);
		try {
			const params = new URLSearchParams({
				includeBroadcasts: String(showBroadcasts),
				limit: "30",
			});
			if (unreadOnly) params.set("unreadOnly", "true");
			const data = await apiGet<AgentStoredMessage[]>(
				`/api/agents/${encodeURIComponent(selectedInboxAgentId)}/messages?${params.toString()}`,
			);
			setAgentMessages(data);
		} catch (e) {
			showMessage(e instanceof Error ? e.message : String(e), false);
		} finally {
			setMessagesLoading(false);
		}
	}, [selectedInboxAgentId, unreadOnly, showBroadcasts]);

	useEffect(() => {
		void loadAgentMessages();
	}, [loadAgentMessages]);

	const showMessage = (text: string, ok: boolean) => {
		setMsg({ text, ok });
		setTimeout(() => setMsg(null), 4000);
	};

	const openCreate = () => {
		setEditingId(null);
		setForm({ ...EMPTY_FORM });
		setShowForm(true);
	};

	const openEdit = (agent: AgentRecord) => {
		const config = parseJsonObject(agent.config);
		const toolPermissions = parseJsonObject(agent.tool_permissions ?? null);
		setEditingId(agent.id);
		setForm({
			name: agent.name,
			role: agent.role,
			personality: agent.personality ?? "",
			description: agent.description ?? "",
			systemPrompt: agent.system_prompt,
			model: normalizeModelValue(agent.model ?? "", modelGroups),
			reasoningEffort: agent.reasoningEffort ?? "none",
			fallbackModel: normalizeModelValue(
				agent.fallback_model ?? "",
				modelGroups,
			),
			avatar: agent.avatar ?? "🤖",
			color: agent.color ?? "#3b82f6",
			capabilitiesText: joinList(
				parseJsonStringArray(agent.capabilities ?? null),
			),
			toolPermissionMode:
				typeof toolPermissions.mode === "string"
					? toolPermissions.mode
					: "inherit",
			toolPermissionTools: joinList(
				Array.isArray(toolPermissions.tools)
					? toolPermissions.tools.filter(
							(item): item is string => typeof item === "string",
						)
					: [],
			),
			knowledgeBaseIds: parseJsonStringArray(agent.knowledge_base_ids ?? null),
			canSpawnSubagents: agent.can_spawn_subagents !== 0,
			maxSpawnDepth: String(agent.max_spawn_depth ?? 2),
			maxTokens:
				typeof config.maxTokens === "number" ? String(config.maxTokens) : "",
			temperature:
				typeof config.temperature === "number"
					? String(config.temperature)
					: "",
		});
		setShowForm(true);
	};

	const closeForm = () => {
		setShowForm(false);
		setEditingId(null);
		setForm({ ...EMPTY_FORM });
	};

	const handleSubmit = async () => {
		if (!form.name.trim()) {
			showMessage("El nombre es obligatorio", false);
			return;
		}
		setSaving(true);
		try {
			const maxSpawnDepth = Number.parseInt(form.maxSpawnDepth || "2", 10);
			const maxTokens = form.maxTokens.trim()
				? Number.parseInt(form.maxTokens.trim(), 10)
				: undefined;
			const temperature = form.temperature.trim()
				? Number.parseFloat(form.temperature.trim())
				: undefined;
			if (
				Number.isNaN(maxSpawnDepth) ||
				maxSpawnDepth < 0 ||
				maxSpawnDepth > 5
			) {
				showMessage("La profundidad máxima debe estar entre 0 y 5", false);
				return;
			}
			if (
				maxTokens !== undefined &&
				(Number.isNaN(maxTokens) || maxTokens < 1)
			) {
				showMessage("Max tokens debe ser un número positivo", false);
				return;
			}
			if (
				temperature !== undefined &&
				(Number.isNaN(temperature) || temperature < 0 || temperature > 2)
			) {
				showMessage("Temperatura debe estar entre 0 y 2", false);
				return;
			}

			const toolPermissions =
				form.toolPermissionMode === "inherit"
					? undefined
					: {
							mode: form.toolPermissionMode,
							tools: splitList(form.toolPermissionTools),
						};
			const config: Record<string, unknown> = {};
			if (maxTokens !== undefined) config.maxTokens = maxTokens;
			if (temperature !== undefined) config.temperature = temperature;

			const payload: Record<string, unknown> = {
				name: form.name.trim(),
				role: form.role,
				personality: form.personality.trim(),
				description: form.description.trim(),
				systemPrompt: form.systemPrompt.trim(),
				model: normalizeModelValue(form.model.trim(), modelGroups),
				reasoningEffort: form.reasoningEffort || "none",
				fallbackModel: normalizeModelValue(
					form.fallbackModel.trim(),
					modelGroups,
				),
				avatar: form.avatar.trim(),
				color: form.color.trim(),
				capabilities: splitList(form.capabilitiesText),
				toolPermissions,
				knowledgeBaseIds: form.knowledgeBaseIds,
				canSpawnSubagents: form.canSpawnSubagents,
				maxSpawnDepth,
				config,
			};
			if (!payload.fallbackModel) payload.fallbackModel = undefined;
			if ((payload.capabilities as string[]).length === 0)
				payload.capabilities = undefined;
			if (!toolPermissions) payload.toolPermissions = undefined;
			if (form.knowledgeBaseIds.length === 0)
				payload.knowledgeBaseIds = undefined;
			if (Object.keys(config).length === 0) payload.config = undefined;
			if (editingBuiltinArm) {
				payload.name = undefined;
				payload.role = undefined;
				payload.systemPrompt = undefined;
				payload.avatar = undefined;
			}
			if (editingId) {
				await apiPutJson(`/api/agents/${editingId}`, payload);
				showMessage("Agente actualizado", true);
			} else {
				await apiPost("/api/agents", payload);
				showMessage("Agente creado", true);
			}
			closeForm();
			await loadAgents();
		} catch (e) {
			showMessage(e instanceof Error ? e.message : String(e), false);
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async (id: string) => {
		setSaving(true);
		try {
			await deleteAgent(id);
			showMessage("Agente eliminado", true);
			setDeleteConfirm(null);
			await loadAgents();
		} catch (e) {
			showMessage(e instanceof Error ? e.message : String(e), false);
		} finally {
			setSaving(false);
		}
	};

	const getAgentLabel = (id: string | null) => {
		if (!id) return "Broadcast";
		return agents.find((agent) => agent.id === id)?.name ?? id;
	};

	const handleSendAgentMessage = async () => {
		if (!selectedFromAgentId || !messageContent.trim()) {
			showMessage("Selecciona origen y escribe un mensaje", false);
			return;
		}
		setSaving(true);
		try {
			await apiPost("/api/agents/messages", {
				fromAgentId: selectedFromAgentId,
				toAgentId: selectedToAgentId === "broadcast" ? null : selectedToAgentId,
				messageType:
					selectedToAgentId === "broadcast" ? "broadcast" : messageType,
				content: messageContent,
				metadata: { source: "web-agents-page" },
			});
			setMessageContent("");
			showMessage("Mensaje enviado", true);
			await loadAgentMessages();
		} catch (e) {
			showMessage(e instanceof Error ? e.message : String(e), false);
		} finally {
			setSaving(false);
		}
	};

	const handleMarkVisibleRead = async () => {
		if (!selectedInboxAgentId) return;
		const unreadIds = agentMessages
			.filter(
				(message) =>
					!message.read_at && message.to_agent_id === selectedInboxAgentId,
			)
			.map((message) => message.id);
		if (unreadIds.length === 0) {
			showMessage("No hay mensajes directos sin leer", true);
			return;
		}
		setSaving(true);
		try {
			await apiPost(
				`/api/agents/${encodeURIComponent(selectedInboxAgentId)}/messages/read`,
				{ messageIds: unreadIds },
			);
			showMessage("Mensajes marcados como leidos", true);
			await loadAgentMessages();
		} catch (e) {
			showMessage(e instanceof Error ? e.message : String(e), false);
		} finally {
			setSaving(false);
		}
	};

	const toggleKnowledgeBase = (collectionId: string) => {
		setForm((current) => ({
			...current,
			knowledgeBaseIds: current.knowledgeBaseIds.includes(collectionId)
				? current.knowledgeBaseIds.filter((id) => id !== collectionId)
				: [...current.knowledgeBaseIds, collectionId],
		}));
	};

	if (loading) {
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
							background: "#3b82f6",
							animation: "pulse 1.4s infinite ease-in-out",
						}}
					/>
					<span>Cargando agentes...</span>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="page-shell page-shell--xl">
				<div
					style={{
						padding: "20px 24px",
						borderRadius: "10px",
						background: "rgba(239, 68, 68, 0.1)",
						color: "#ef4444",
						border: "1px solid rgba(239, 68, 68, 0.2)",
						fontSize: "0.9rem",
					}}
				>
					Error al cargar agentes: {error}
				</div>
			</div>
		);
	}

	const mainCount = agents.filter((a) => a.is_main).length;
	const roleCounts: Record<string, number> = {};
	for (const a of agents) {
		roleCounts[a.role] = (roleCounts[a.role] ?? 0) + 1;
	}

	return (
		<div className="page-shell page-shell--xl">
			<div className="page-header">
				<div>
					<h2 className="ui-page-title">Agentes</h2>
					<p className="ui-page-subtitle">
						Gestiona tus agentes IA, sus roles, personalidad y prompts del
						sistema.
					</p>
				</div>
				<button
					type="button"
					onClick={openCreate}
					className="ui-btn ui-btn--primary"
					style={{ flexShrink: 0 }}
				>
					<span style={{ fontSize: "1.1rem", lineHeight: 1 }}>+</span>
					Crear agente
				</button>
			</div>

			{msg && (
				<div
					className={`ui-notice ${msg.ok ? "is-ok" : "is-error"}`}
					style={{ marginBottom: "20px" }}
				>
					{msg.text}
				</div>
			)}

			<div className="settings-summary-grid" style={{ marginBottom: "24px" }}>
				<StatCard
					label="Agentes totales"
					value={agents.length}
					accent="#818cf8"
				/>
				<StatCard label="Agente principal" value={mainCount} accent="#22c55e" />
				<StatCard
					label="Roles usados"
					value={Object.keys(roleCounts).length}
					accent="#f59e0b"
				/>
				<StatCard
					label="Agentes personalizados"
					value={agents.filter((a) => !a.is_main && !a.is_default).length}
					accent="#3b82f6"
				/>
			</div>

			<div
				style={{
					padding: "22px",
					borderRadius: "14px",
					background:
						"linear-gradient(180deg, rgba(24, 24, 27, 0.95), rgba(15, 15, 18, 0.95))",
					border: "1px solid #27272a",
					marginBottom: "24px",
				}}
			>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						gap: "16px",
						alignItems: "flex-start",
						marginBottom: "18px",
						flexWrap: "wrap",
					}}
				>
					<div>
						<h3
							style={{
								margin: 0,
								fontSize: "1.05rem",
								fontWeight: 800,
								color: "#f4f4f5",
							}}
						>
							Mensajes y handoffs
						</h3>
						<p
							style={{
								margin: "6px 0 0",
								color: "#a1a1aa",
								fontSize: "0.85rem",
								lineHeight: 1.5,
							}}
						>
							Envía mensajes directos o broadcasts entre brazos y agentes. Los
							workers también usan esta bandeja para coordinarse durante
							workflows durables.
						</p>
					</div>
					<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
						<button
							type="button"
							onClick={() => void loadAgentMessages()}
							style={actionBtnStyle}
						>
							Actualizar
						</button>
						<button
							type="button"
							onClick={handleMarkVisibleRead}
							disabled={saving || !selectedInboxAgentId}
							style={{ ...actionBtnStyle, opacity: saving ? 0.6 : 1 }}
						>
							Marcar leidos
						</button>
					</div>
				</div>

				<div className="responsive-grid-2" style={{ gap: "18px" }}>
					<div>
						<div
							className="responsive-grid-2"
							style={{ gap: "12px", marginBottom: "12px" }}
						>
							<AgentSelect
								label="Desde"
								value={selectedFromAgentId}
								agents={agents}
								onChange={setSelectedFromAgentId}
							/>
							<AgentSelect
								label="Para"
								value={selectedToAgentId}
								agents={agents}
								onChange={setSelectedToAgentId}
								includeBroadcast
							/>
						</div>
						<div style={{ marginBottom: "12px" }}>
							<label htmlFor="agent-message-type" style={labelStyle}>
								Tipo
							</label>
							<select
								id="agent-message-type"
								value={messageType}
								onChange={(event) => setMessageType(event.target.value)}
								disabled={selectedToAgentId === "broadcast"}
								style={{
									...inputStyle,
									appearance: "auto",
									opacity: selectedToAgentId === "broadcast" ? 0.65 : 1,
								}}
							>
								{MESSAGE_TYPE_OPTIONS.map((type) => (
									<option key={type} value={type}>
										{type}
									</option>
								))}
							</select>
						</div>
						<FormTextarea
							label="Mensaje"
							value={messageContent}
							onChange={setMessageContent}
							placeholder="Describe el handoff, bloqueo, pregunta o resultado que debe ver otro agente..."
							rows={4}
						/>
						<div
							style={{
								display: "flex",
								justifyContent: "flex-end",
								marginTop: "12px",
							}}
						>
							<button
								type="button"
								onClick={handleSendAgentMessage}
								disabled={saving || !messageContent.trim()}
								style={{
									...saveBtnStyle,
									opacity: saving || !messageContent.trim() ? 0.5 : 1,
								}}
							>
								{saving ? "Enviando..." : "Enviar mensaje"}
							</button>
						</div>
					</div>

					<div>
						<div
							style={{
								display: "flex",
								gap: "12px",
								alignItems: "flex-end",
								marginBottom: "12px",
							}}
						>
							<div style={{ flex: 1 }}>
								<AgentSelect
									label="Bandeja"
									value={selectedInboxAgentId}
									agents={agents}
									onChange={setSelectedInboxAgentId}
								/>
							</div>
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									gap: "6px",
									paddingBottom: "10px",
								}}
							>
								<label
									style={{
										display: "flex",
										alignItems: "center",
										gap: "8px",
										color: "#a1a1aa",
										fontSize: "0.82rem",
									}}
								>
									<input
										type="checkbox"
										checked={unreadOnly}
										onChange={(event) => setUnreadOnly(event.target.checked)}
									/>
									Solo sin leer
								</label>
								<label
									style={{
										display: "flex",
										alignItems: "center",
										gap: "8px",
										color: "#a1a1aa",
										fontSize: "0.82rem",
									}}
								>
									<input
										type="checkbox"
										checked={showBroadcasts}
										onChange={(event) =>
											setShowBroadcasts(event.target.checked)
										}
									/>
									Incluir broadcasts
								</label>
							</div>
						</div>

						<div
							style={{
								border: "1px solid #27272a",
								borderRadius: "12px",
								background: "rgba(9, 9, 11, 0.45)",
								maxHeight: "360px",
								overflow: "auto",
							}}
						>
							{messagesLoading ? (
								<div style={emptyMessageStyle}>Cargando mensajes...</div>
							) : agentMessages.length === 0 ? (
								<div
									style={{
										...emptyMessageStyle,
										display: "flex",
										flexDirection: "column",
										alignItems: "center",
										gap: "10px",
									}}
								>
									<span style={{ color: "#6366f1", opacity: 0.7 }}>
										<AppIcon name="message" size={28} strokeWidth={1.6} />
									</span>
									Sin mensajes para esta bandeja.
								</div>
							) : (
								agentMessages.map((message) => (
									<div key={message.id} style={agentMessageItemStyle}>
										<div
											style={{
												display: "flex",
												justifyContent: "space-between",
												gap: "10px",
												marginBottom: "6px",
											}}
										>
											<strong style={{ color: "#e4e4e7", fontSize: "0.84rem" }}>
												{getAgentLabel(message.from_agent_id)}{" "}
												{message.to_agent_id
													? `→ ${getAgentLabel(message.to_agent_id)}`
													: "→ Todos"}
											</strong>
											<span style={{ color: "#71717a", fontSize: "0.72rem" }}>
												{formatAgentMessageDate(message.created_at)}
											</span>
										</div>
										<div
											style={{
												color: "#a1a1aa",
												fontSize: "0.8rem",
												marginBottom: "8px",
											}}
										>
											<span
												style={
													message.to_agent_id
														? messageBadgeStyle
														: broadcastBadgeStyle
												}
											>
												{message.to_agent_id
													? message.message_type
													: "broadcast"}
											</span>
											{message.run_id && <span> Run: {message.run_id}</span>}
											{message.to_agent_id === selectedInboxAgentId &&
												!message.read_at && (
													<span style={{ color: "#f59e0b", marginLeft: "8px" }}>
														Sin leer
													</span>
												)}
										</div>
										<div
											style={{
												color: "#d4d4d8",
												fontSize: "0.86rem",
												lineHeight: 1.55,
												whiteSpace: "pre-wrap",
											}}
										>
											{message.content}
										</div>
									</div>
								))
							)}
						</div>
					</div>
				</div>
			</div>

			{showForm && (
				<div
					style={{
						padding: "24px",
						borderRadius: "14px",
						background:
							"linear-gradient(180deg, rgba(24, 24, 27, 0.95), rgba(15, 15, 18, 0.95))",
						border: "1px solid #27272a",
						marginBottom: "24px",
						boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
					}}
				>
					<h3
						style={{
							margin: "0 0 20px",
							fontSize: "1.15rem",
							fontWeight: 700,
							color: "#f4f4f5",
						}}
					>
						{editingBuiltinArm
							? "Editar brazo Octopus"
							: editingId
								? "Editar agente"
								: "Crear agente"}
					</h3>
					{editingBuiltinArm && (
						<div
							style={{
								marginBottom: 16,
								padding: "12px 14px",
								borderRadius: 12,
								border: "1px solid rgba(59,130,246,0.35)",
								background: "rgba(59,130,246,0.08)",
								color: "#bfdbfe",
								fontSize: "0.9rem",
							}}
						>
							Este es un brazo integrado de Octopus. Puedes cambiar modelo,
							personalidad y limites, pero su identidad base y mascota estan
							protegidas.
						</div>
					)}

					<div
						className="responsive-grid-2"
						style={{ gap: "16px", marginBottom: "16px" }}
					>
						<FormInput
							label="Nombre"
							value={form.name}
							onChange={(v) => setForm((f) => ({ ...f, name: v }))}
							placeholder="Nombre del agente"
							disabled={editingBuiltinArm}
						/>
						<FormSelect
							label="Rol"
							value={form.role}
							options={ROLE_OPTIONS}
							onChange={(v) => setForm((f) => ({ ...f, role: v }))}
							disabled={editingBuiltinArm}
						/>
					</div>

					<div
						className="responsive-grid-2"
						style={{ gap: "16px", marginBottom: "16px" }}
					>
						<ModelSelect
							label="Modelo"
							value={form.model}
							onChange={(v) =>
								setForm((f) => {
									const caps = modelCapabilities[v];
									const allowed = caps ? caps.allowedReasoningEfforts : ["none"];
									const coerced = caps
										? allowed.includes(f.reasoningEffort)
											? f.reasoningEffort
											: caps.defaultReasoningEffort
										: "none";
									return { ...f, model: v, reasoningEffort: coerced };
								})
							}
							groups={modelGroups}
							placeholder="Selecciona un modelo"
						/>
						<div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
							<label
								htmlFor="agent-reasoning-effort"
								style={{
									fontSize: "0.8rem",
									color: "#a1a1aa",
									fontWeight: 500,
								}}
							>
								Nivel de razonamiento
							</label>
							{(() => {
								const caps = form.model ? modelCapabilities[form.model] : undefined;
								const allowed = caps
									? caps.allowedReasoningEfforts
									: ["none"];
								const supports = caps ? caps.supportsReasoning : false;
								return (
									<>
										<select
											id="agent-reasoning-effort"
											value={caps && !supports ? "none" : form.reasoningEffort}
											disabled={!supports}
											onChange={(e) =>
												setForm((f) => ({ ...f, reasoningEffort: e.target.value }))
											}
											style={{
												padding: "8px 10px",
												borderRadius: "8px",
												border: "1px solid #3f3f46",
												background: "#0b0b10",
												color: "#f4f4f5",
												fontSize: "0.88rem",
												cursor: supports ? "pointer" : "not-allowed",
												opacity: supports ? 1 : 0.6,
											}}
										>
											{allowed.map((effort) => (
												<option key={effort} value={effort}>
													{REASONING_LABELS[effort] ?? effort}
												</option>
											))}
										</select>
										{!supports && (
											<span style={{ fontSize: "0.72rem", color: "#71717a" }}>
												Este modelo no admite razonamiento ajustable.
											</span>
										)}
									</>
								);
							})()}
						</div>
						<FormInput
							label="Avatar (emoji o texto)"
							value={form.avatar}
							onChange={(v) => setForm((f) => ({ ...f, avatar: v }))}
							placeholder="🤖"
							disabled={editingBuiltinArm}
						/>
					</div>

					<div
						className="responsive-grid-2"
						style={{ gap: "16px", marginBottom: "16px" }}
					>
						<FormInput
							label="Color"
							value={form.color}
							onChange={(v) => setForm((f) => ({ ...f, color: v }))}
							placeholder="#3b82f6"
							type="color"
						/>
						<FormInput
							label="Descripción"
							value={form.description}
							onChange={(v) => setForm((f) => ({ ...f, description: v }))}
							placeholder="Descripción breve"
						/>
					</div>

					<FormTextarea
						label="Personalidad"
						value={form.personality}
						onChange={(v) => setForm((f) => ({ ...f, personality: v }))}
						placeholder="Describe los rasgos de personalidad del agente..."
						rows={3}
					/>

					<div style={{ height: "16px" }} />

					<FormTextarea
						label="Prompt del sistema"
						value={form.systemPrompt}
						onChange={(v) => setForm((f) => ({ ...f, systemPrompt: v }))}
						placeholder="Define el comportamiento e instrucciones del agente..."
						rows={5}
						disabled={editingBuiltinArm}
					/>

					<div style={{ height: "18px" }} />

					<div
						style={{
							padding: "18px",
							borderRadius: "12px",
							border: "1px solid rgba(129, 140, 248, 0.22)",
							background: "rgba(49, 46, 129, 0.12)",
						}}
					>
						<div style={{ marginBottom: "14px" }}>
							<div
								style={{
									color: "#e0e7ff",
									fontWeight: 800,
									fontSize: "0.95rem",
								}}
							>
								Configuración avanzada
							</div>
							<div
								style={{ color: "#a1a1aa", fontSize: "0.8rem", marginTop: 4 }}
							>
								Ajusta permisos, contexto, subagentes y límites del runtime. Los
								agentes personalizados heredan permisos completos si no
								restringes herramientas.
							</div>
						</div>

						<div
							className="responsive-grid-2"
							style={{ gap: "16px", marginBottom: "16px" }}
						>
							<ModelSelect
								label="Modelo fallback"
								value={form.fallbackModel}
								onChange={(v) => setForm((f) => ({ ...f, fallbackModel: v }))}
								groups={modelGroups}
								placeholder="Sin fallback"
								allowEmpty
							/>
							<FormSelect
								label="Permisos de herramientas"
								value={form.toolPermissionMode}
								options={["inherit", "allowlist", "denylist"]}
								onChange={(v) =>
									setForm((f) => ({ ...f, toolPermissionMode: v }))
								}
							/>
						</div>

						<FormTextarea
							label="Capacidades"
							value={form.capabilitiesText}
							onChange={(v) => setForm((f) => ({ ...f, capabilitiesText: v }))}
							placeholder="Una capacidad por línea: code, research, qa, multimodal..."
							rows={3}
						/>

						<div style={{ height: "14px" }} />

						<FormTextarea
							label="Herramientas permitidas/bloqueadas"
							value={form.toolPermissionTools}
							onChange={(v) =>
								setForm((f) => ({ ...f, toolPermissionTools: v }))
							}
							placeholder="Una herramienta por línea. Vacío = sin lista específica."
							rows={3}
							disabled={form.toolPermissionMode === "inherit"}
						/>

						<div style={{ height: "14px" }} />

						<div
							className="responsive-grid-2"
							style={{ gap: "16px", marginBottom: "16px" }}
						>
							<FormInput
								label="Max tokens"
								value={form.maxTokens}
								onChange={(v) => setForm((f) => ({ ...f, maxTokens: v }))}
								placeholder="Opcional"
								type="number"
							/>
							<FormInput
								label="Temperatura"
								value={form.temperature}
								onChange={(v) => setForm((f) => ({ ...f, temperature: v }))}
								placeholder="0.0 - 2.0"
								type="number"
							/>
						</div>

						<div
							className="responsive-grid-2"
							style={{ gap: "16px", marginBottom: "16px" }}
						>
							<FormInput
								label="Profundidad subagentes"
								value={form.maxSpawnDepth}
								onChange={(v) => setForm((f) => ({ ...f, maxSpawnDepth: v }))}
								placeholder="0-5"
								type="number"
							/>
							<label
								style={{
									display: "flex",
									alignItems: "center",
									gap: "10px",
									color: "#a1a1aa",
									fontSize: "0.86rem",
									paddingTop: "22px",
								}}
							>
								<input
									type="checkbox"
									checked={form.canSpawnSubagents}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											canSpawnSubagents: e.target.checked,
										}))
									}
								/>
								Puede crear subagentes
							</label>
						</div>

						<div>
							<div style={labelStyle}>Bases de conocimiento asignadas</div>
							{knowledgeCollections.length === 0 ? (
								<div style={{ color: "#71717a", fontSize: "0.82rem" }}>
									No hay colecciones KB todavía.
								</div>
							) : (
								<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
									{knowledgeCollections.map((collection) => {
										const selected = form.knowledgeBaseIds.includes(
											collection.id,
										);
										return (
											<button
												key={collection.id}
												type="button"
												onClick={() => toggleKnowledgeBase(collection.id)}
												style={{
													padding: "7px 10px",
													borderRadius: "999px",
													border: selected
														? "1px solid #818cf8"
														: "1px solid #3f3f46",
													background: selected
														? "rgba(129, 140, 248, 0.16)"
														: "#18181b",
													color: selected ? "#c7d2fe" : "#a1a1aa",
													fontSize: "0.78rem",
													fontWeight: 700,
													cursor: "pointer",
												}}
											>
												{collection.name}
											</button>
										);
									})}
								</div>
							)}
						</div>
					</div>

					<div
						style={{
							display: "flex",
							gap: "10px",
							justifyContent: "flex-end",
							marginTop: "20px",
						}}
					>
						<button type="button" onClick={closeForm} style={cancelBtnStyle}>
							Cancelar
						</button>
						<button
							type="button"
							onClick={handleSubmit}
							disabled={saving || !form.name.trim()}
							style={{
								...saveBtnStyle,
								opacity: saving || !form.name.trim() ? 0.45 : 1,
								cursor: saving || !form.name.trim() ? "not-allowed" : "pointer",
							}}
						>
							{saving
								? "Guardando..."
								: editingId
									? "Actualizar agente"
									: "Crear agente"}
						</button>
					</div>
				</div>
			)}

			{agents.length === 0 ? (
				<div className="ui-empty">
					<div className="ui-empty-icon">
						<AppIcon name="agent" size={44} strokeWidth={1.6} />
					</div>
					<div className="ui-empty-title">Aún no hay agentes</div>
					<div className="ui-empty-desc">
						Crea tu primer agente o conecta una plantilla especializada para
						empezar.
					</div>
					<button
						type="button"
						onClick={openCreate}
						className="ui-btn ui-btn--primary"
						style={{ marginTop: "20px" }}
					>
						Crear agente
					</button>
				</div>
			) : (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
						gap: "16px",
					}}
				>
					{agents.map((agent) => (
						<AgentCard
							key={agent.id}
							agent={agent}
							onEdit={() => openEdit(agent)}
							onDelete={() => setDeleteConfirm(agent.id)}
							deleteConfirm={deleteConfirm}
							onConfirmDelete={() => handleDelete(agent.id)}
							onCancelDelete={() => setDeleteConfirm(null)}
							saving={saving}
						/>
					))}
				</div>
			)}
		</div>
	);
};

const AgentCard: React.FC<{
	agent: AgentRecord;
	onEdit: () => void;
	onDelete: () => void;
	deleteConfirm: string | null;
	onConfirmDelete: () => void;
	onCancelDelete: () => void;
	saving: boolean;
}> = ({
	agent,
	onEdit,
	onDelete,
	deleteConfirm,
	onConfirmDelete,
	onCancelDelete,
	saving,
}) => {
	const agentColor = agent.color ?? "#3b82f6";
	const roleIcon = ROLE_ICONS[agent.role] ?? "🤖";
	const isConfirming = deleteConfirm === agent.id;
	const avatar = displayAgentAvatar(agent);
	const avatarSrc = avatarImageSrc(avatar);
	const description = displayAgentDescription(agent);

	return (
		<div
			style={{
				padding: "18px",
				borderRadius: "14px",
				background:
					"linear-gradient(180deg, rgba(24, 24, 27, 0.95), rgba(15, 15, 18, 0.95))",
				border: "1px solid #27272a",
				transition: "border-color 0.2s ease, transform 0.2s ease",
				position: "relative",
				overflow: "hidden",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.borderColor = "#3f3f46";
				e.currentTarget.style.transform = "translateY(-1px)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.borderColor = "#27272a";
				e.currentTarget.style.transform = "translateY(0)";
			}}
		>
			<div
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					right: 0,
					height: "3px",
					background: agentColor,
					opacity: 0.7,
				}}
			/>

			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					gap: "12px",
					marginBottom: "12px",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: "12px",
						minWidth: 0,
					}}
				>
					<div
						style={{
							width: "40px",
							height: "40px",
							borderRadius: "10px",
							background: `${agentColor}20`,
							border: `1px solid ${agentColor}40`,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							fontSize: "1.3rem",
							flexShrink: 0,
							overflow: "hidden",
						}}
					>
						{avatarSrc ? (
							<img
								src={avatarSrc}
								alt=""
								aria-hidden="true"
								style={{
									width: "100%",
									height: "100%",
									objectFit: "cover",
									display: "block",
								}}
								onError={(event) => {
									event.currentTarget.style.display = "none";
									event.currentTarget.parentElement?.replaceChildren(roleIcon);
								}}
							/>
						) : (
							(avatar ?? roleIcon)
						)}
					</div>
					<div style={{ minWidth: 0 }}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "8px",
								flexWrap: "wrap",
							}}
						>
							<span
								style={{
									fontWeight: 700,
									fontSize: "1rem",
									color: "#f4f4f5",
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{displayAgentName(agent)}
							</span>
							{agent.is_main === 1 && (
								<span
									style={{
										padding: "2px 8px",
										borderRadius: "999px",
										background: "rgba(34, 197, 94, 0.15)",
										border: "1px solid rgba(34, 197, 94, 0.3)",
										color: "#22c55e",
										fontSize: "0.7rem",
										fontWeight: 700,
										textTransform: "uppercase",
										letterSpacing: "0.04em",
									}}
								>
									Principal
								</span>
							)}
						</div>
						<div
							style={{ fontSize: "0.8rem", color: "#71717a", marginTop: "2px" }}
						>
							{roleIcon} {agent.role}
							{agent.model && (
								<span style={{ color: "#52525b", marginLeft: "6px" }}>
									· {agent.model}
								</span>
							)}
						</div>
					</div>
				</div>
			</div>

			{description && (
				<div
					style={{
						fontSize: "0.82rem",
						color: "#a1a1aa",
						marginBottom: "8px",
						lineHeight: 1.5,
						display: "-webkit-box",
						WebkitLineClamp: 2,
						WebkitBoxOrient: "vertical",
						overflow: "hidden",
					}}
				>
					{description}
				</div>
			)}

			{agent.personality && (
				<div
					style={{
						fontSize: "0.78rem",
						color: "#71717a",
						marginBottom: "12px",
						lineHeight: 1.5,
						fontStyle: "italic",
						display: "-webkit-box",
						WebkitLineClamp: 2,
						WebkitBoxOrient: "vertical",
						overflow: "hidden",
					}}
				>
					{agent.personality}
				</div>
			)}

			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "8px",
					paddingTop: "12px",
					borderTop: "1px solid #27272a",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
					<span
						style={{
							width: "8px",
							height: "8px",
							borderRadius: "50%",
							background: agentColor,
							flexShrink: 0,
						}}
					/>
					<span style={{ fontSize: "0.72rem", color: "#52525b" }}>
						{agentColor}
					</span>
				</div>

				{isConfirming ? (
					<div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
						<span
							style={{ fontSize: "0.8rem", color: "#ef4444", fontWeight: 500 }}
						>
							¿Eliminar?
						</span>
						<button
							type="button"
							onClick={onConfirmDelete}
							disabled={saving}
							style={{
								...dangerBtnStyle,
								opacity: saving ? 0.45 : 1,
							}}
						>
							{saving ? "..." : "Sí"}
						</button>
						<button
							type="button"
							onClick={onCancelDelete}
							style={cancelBtnStyle}
						>
							No
						</button>
					</div>
				) : (
					<div style={{ display: "flex", gap: "8px" }}>
						<button type="button" onClick={onEdit} style={actionBtnStyle}>
							Editar
						</button>
						<button type="button" onClick={onDelete} style={dangerBtnStyle}>
							Eliminar
						</button>
					</div>
				)}
			</div>
		</div>
	);
};

const StatCard: React.FC<{
	label: string;
	value: number;
	accent: string;
}> = ({ label, value, accent }) => (
	<div
		className="settings-summary-card"
		style={{ "--stat-accent": accent } as React.CSSProperties}
	>
		<div className="settings-summary-label">{label}</div>
		<div className="settings-summary-value">{value}</div>
	</div>
);

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "10px 12px",
	borderRadius: "8px",
	border: "1px solid #3f3f46",
	background: "#18181b",
	color: "#f4f4f5",
	fontSize: "0.85rem",
	outline: "none",
	fontFamily: "inherit",
	boxSizing: "border-box",
	transition: "border-color 0.2s ease",
};

const labelStyle: React.CSSProperties = {
	display: "block",
	fontSize: "0.78rem",
	fontWeight: 600,
	color: "#a1a1aa",
	marginBottom: "6px",
	textTransform: "uppercase",
	letterSpacing: "0.03em",
};

const slugifyLabel = (label: string) =>
	`agent-${label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")}`;

const formatAgentMessageDate = (value: string) => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
};

const AgentSelect: React.FC<{
	label: string;
	value: string;
	agents: AgentRecord[];
	onChange: (value: string) => void;
	includeBroadcast?: boolean;
}> = ({ label, value, agents, onChange, includeBroadcast }) => {
	const id = slugifyLabel(label);
	return (
		<div>
			<label htmlFor={id} style={labelStyle}>
				{label}
			</label>
			<select
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				style={{ ...inputStyle, appearance: "auto" }}
			>
				{includeBroadcast && <option value="broadcast">Broadcast</option>}
				{agents.map((agent) => (
					<option key={agent.id} value={agent.id}>
						{agent.name} ({agent.role})
					</option>
				))}
			</select>
		</div>
	);
};

const ModelSelect: React.FC<{
	label: string;
	value: string;
	groups: ModelOptionGroup[];
	onChange: (value: string) => void;
	placeholder?: string;
	allowEmpty?: boolean;
}> = ({ label, value, groups, onChange, placeholder, allowEmpty }) => {
	const id = slugifyLabel(label);
	const normalizedValue = normalizeModelValue(value, groups);
	const values = modelValues(groups);
	const hasOptions = values.length > 0;
	const showCustom = Boolean(
		normalizedValue && !values.includes(normalizedValue),
	);
	return (
		<div>
			<label htmlFor={id} style={labelStyle}>
				{label}
			</label>
			<select
				id={id}
				name={id}
				value={normalizedValue}
				onChange={(event) => onChange(event.target.value)}
				disabled={!hasOptions && !showCustom}
				style={{
					...inputStyle,
					appearance: "auto",
					opacity: !hasOptions && !showCustom ? 0.6 : 1,
				}}
			>
				{(allowEmpty || !normalizedValue) && (
					<option value="">
						{hasOptions
							? (placeholder ?? "Selecciona un modelo")
							: "Configura un proveedor primero"}
					</option>
				)}
				{showCustom && (
					<optgroup label="Modelo actual">
						<option value={normalizedValue}>{normalizedValue}</option>
					</optgroup>
				)}
				{groups.map((group) => (
					<optgroup key={group.providerKey} label={group.providerName}>
						{group.models.map((model) => (
							<option key={model.value} value={model.value}>
								{model.label}
							</option>
						))}
					</optgroup>
				))}
			</select>
		</div>
	);
};

const FormInput: React.FC<{
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	type?: string;
	disabled?: boolean;
}> = ({ label, value, onChange, placeholder, type = "text", disabled }) => {
	const id = slugifyLabel(label);
	return (
		<div>
			<label htmlFor={id} style={labelStyle}>
				{label}
			</label>
			<input
				id={id}
				name={id}
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				disabled={disabled}
				style={{
					...inputStyle,
					opacity: disabled ? 0.6 : 1,
					...(type === "color"
						? {
								padding: "4px 6px",
								height: "40px",
								cursor: "pointer",
							}
						: {}),
				}}
				onFocus={(e) => {
					e.currentTarget.style.borderColor = "#6366f1";
				}}
				onBlur={(e) => {
					e.currentTarget.style.borderColor = "#3f3f46";
				}}
			/>
		</div>
	);
};

const FormSelect: React.FC<{
	label: string;
	value: string;
	options: string[];
	onChange: (v: string) => void;
	disabled?: boolean;
}> = ({ label, value, options, onChange, disabled }) => {
	const id = slugifyLabel(label);
	return (
		<div>
			<label htmlFor={id} style={labelStyle}>
				{label}
			</label>
			<select
				id={id}
				name={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
				style={{
					...inputStyle,
					cursor: disabled ? "not-allowed" : "pointer",
					opacity: disabled ? 0.6 : 1,
					appearance: "auto",
				}}
			>
				{options.map((opt) => (
					<option key={opt} value={opt}>
						{ROLE_ICONS[opt] ?? ""} {opt.charAt(0).toUpperCase() + opt.slice(1)}
					</option>
				))}
			</select>
		</div>
	);
};

const FormTextarea: React.FC<{
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	rows?: number;
	disabled?: boolean;
}> = ({ label, value, onChange, placeholder, rows = 3, disabled }) => {
	const id = slugifyLabel(label);
	return (
		<div>
			<label htmlFor={id} style={labelStyle}>
				{label}
			</label>
			<textarea
				id={id}
				name={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				rows={rows}
				disabled={disabled}
				style={{
					...inputStyle,
					opacity: disabled ? 0.6 : 1,
					resize: "vertical",
					minHeight: "60px",
					lineHeight: 1.5,
				}}
				onFocus={(e) => {
					e.currentTarget.style.borderColor = "#6366f1";
				}}
				onBlur={(e) => {
					e.currentTarget.style.borderColor = "#3f3f46";
				}}
			/>
		</div>
	);
};

const actionBtnStyle: React.CSSProperties = {
	padding: "7px 14px",
	borderRadius: "9px",
	border: "1px solid #3f3f46",
	background: "#18181b",
	color: "#d4d4d8",
	fontSize: "0.8rem",
	fontWeight: 600,
	cursor: "pointer",
	transition: "all 0.18s ease",
};

const emptyMessageStyle: React.CSSProperties = {
	padding: "28px 18px",
	textAlign: "center",
	color: "#71717a",
	fontSize: "0.86rem",
};

const agentMessageItemStyle: React.CSSProperties = {
	padding: "14px",
	borderBottom: "1px solid #27272a",
};

const messageBadgeStyle: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	padding: "2px 8px",
	borderRadius: "999px",
	background: "rgba(59, 130, 246, 0.12)",
	border: "1px solid rgba(59, 130, 246, 0.24)",
	color: "#93c5fd",
	fontSize: "0.72rem",
	fontWeight: 700,
	marginRight: "8px",
};

const broadcastBadgeStyle: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	padding: "2px 8px",
	borderRadius: "999px",
	background: "rgba(168, 85, 247, 0.12)",
	border: "1px solid rgba(168, 85, 247, 0.24)",
	color: "#c4b5fd",
	fontSize: "0.72rem",
	fontWeight: 700,
	marginRight: "8px",
};

const dangerBtnStyle: React.CSSProperties = {
	padding: "7px 14px",
	borderRadius: "9px",
	border: "1px solid rgba(248, 113, 113, 0.3)",
	background: "rgba(248, 113, 113, 0.1)",
	color: "#f87171",
	fontSize: "0.8rem",
	fontWeight: 600,
	cursor: "pointer",
	transition: "all 0.18s ease",
};

const cancelBtnStyle: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: "10px",
	border: "1px solid #3f3f46",
	background: "#18181b",
	color: "#d4d4d8",
	fontSize: "0.9rem",
	fontWeight: 600,
	cursor: "pointer",
	transition: "all 0.18s ease",
};

const saveBtnStyle: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: "10px",
	border: "1px solid rgba(99, 102, 241, 0.4)",
	background: "linear-gradient(180deg, #6366f1, #4f46e5)",
	color: "#fff",
	fontSize: "0.9rem",
	fontWeight: 700,
	cursor: "pointer",
	transition: "all 0.18s ease",
	boxShadow: "0 6px 18px rgba(79, 70, 229, 0.28)",
};
