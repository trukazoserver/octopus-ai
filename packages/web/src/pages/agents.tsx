import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon } from "../components/ui/AppIcon.js";
import { API_BASE, apiGet, apiPost, apiPutJson } from "../hooks/useApi.js";

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
}

interface AgentFormData {
	name: string;
	role: string;
	personality: string;
	description: string;
	systemPrompt: string;
	model: string;
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

const ROLE_OPTIONS = [
	"assistant",
	"coder",
	"researcher",
	"writer",
	"analyst",
	"coordinator",
];

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

async function deleteAgent(id: string): Promise<void> {
	const res = await fetch(`${API_BASE}/api/agents/${id}`, { method: "DELETE" });
	if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export const AgentsPage: React.FC = () => {
	const [agents, setAgents] = useState<AgentRecord[]>([]);
	const [knowledgeCollections, setKnowledgeCollections] = useState<KnowledgeCollection[]>([]);
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
	const editingAgent = editingId
		? agents.find((agent) => agent.id === editingId) ?? null
		: null;
	const editingBuiltinArm = editingAgent?.is_builtin_arm === 1;

	const loadAgents = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [data, collections] = await Promise.all([
				apiGet<AgentRecord[]>("/api/agents"),
				apiGet<KnowledgeCollection[]>("/api/memory/knowledge/collections").catch(() => []),
			]);
			setAgents(data);
			setKnowledgeCollections(collections);
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
		setMessagesLoading(true);
		try {
			const params = new URLSearchParams({
				includeBroadcasts: "true",
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
	}, [selectedInboxAgentId, unreadOnly]);

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
			model: agent.model ?? "",
			fallbackModel: agent.fallback_model ?? "",
			avatar: agent.avatar ?? "🤖",
			color: agent.color ?? "#3b82f6",
			capabilitiesText: joinList(parseJsonStringArray(agent.capabilities ?? null)),
			toolPermissionMode:
				typeof toolPermissions.mode === "string" ? toolPermissions.mode : "inherit",
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
				typeof config.temperature === "number" ? String(config.temperature) : "",
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
			if (Number.isNaN(maxSpawnDepth) || maxSpawnDepth < 0 || maxSpawnDepth > 5) {
				showMessage("La profundidad máxima debe estar entre 0 y 5", false);
				return;
			}
			if (maxTokens !== undefined && (Number.isNaN(maxTokens) || maxTokens < 1)) {
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
				model: form.model.trim(),
				fallbackModel: form.fallbackModel.trim(),
				avatar: form.avatar.trim(),
				color: form.color.trim(),
				capabilities: splitList(form.capabilitiesText),
				toolPermissions,
				knowledgeBaseIds: form.knowledgeBaseIds,
				canSpawnSubagents: form.canSpawnSubagents,
				maxSpawnDepth,
				config,
			};
			if (!payload.fallbackModel) delete payload.fallbackModel;
			if ((payload.capabilities as string[]).length === 0) delete payload.capabilities;
			if (!toolPermissions) delete payload.toolPermissions;
			if (form.knowledgeBaseIds.length === 0) delete payload.knowledgeBaseIds;
			if (Object.keys(config).length === 0) delete payload.config;
			if (editingBuiltinArm) {
				delete payload.name;
				delete payload.role;
				delete payload.systemPrompt;
				delete payload.avatar;
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
				messageType: selectedToAgentId === "broadcast" ? "broadcast" : messageType,
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
					<h2
						style={{
							margin: 0,
							fontSize: "1.9rem",
							fontWeight: 700,
							color: "#f4f4f5",
							letterSpacing: "-0.02em",
						}}
					>
						Agentes
					</h2>
					<p
						style={{
							margin: "8px 0 0",
							color: "#a1a1aa",
							fontSize: "0.95rem",
							maxWidth: "700px",
							lineHeight: 1.6,
						}}
					>
						Gestiona tus agentes IA, sus roles, personalidad y prompts del
						sistema.
					</p>
				</div>
				<button
					type="button"
					onClick={openCreate}
					style={{
						padding: "10px 20px",
						borderRadius: "10px",
						border: "1px solid rgba(59, 130, 246, 0.3)",
						background: "rgba(59, 130, 246, 0.12)",
						color: "#3b82f6",
						fontSize: "0.9rem",
						fontWeight: 600,
						cursor: "pointer",
						transition: "all 0.2s ease",
						display: "flex",
						alignItems: "center",
						gap: "8px",
						flexShrink: 0,
					}}
				>
					<span style={{ fontSize: "1.1rem", lineHeight: 1 }}>+</span>
					Crear agente
				</button>
			</div>

			{msg && (
				<div
					style={{
						padding: "12px 16px",
						borderRadius: "10px",
						marginBottom: "20px",
						background: msg.ok
							? "rgba(34, 197, 94, 0.1)"
							: "rgba(239, 68, 68, 0.1)",
						color: msg.ok ? "#22c55e" : "#ef4444",
						border: `1px solid ${msg.ok ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)"}`,
						fontSize: "0.9rem",
						fontWeight: 500,
					}}
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
							workers también usan esta bandeja para coordinarse durante workflows
							durables.
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
							<label
								style={{
									display: "flex",
									alignItems: "center",
									gap: "8px",
									color: "#a1a1aa",
									fontSize: "0.82rem",
									paddingBottom: "10px",
								}}
							>
								<input
									type="checkbox"
									checked={unreadOnly}
									onChange={(event) => setUnreadOnly(event.target.checked)}
								/>
								Solo sin leer
							</label>
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
								<div style={emptyMessageStyle}>Sin mensajes para esta bandeja.</div>
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
												{getAgentLabel(message.from_agent_id)} hacia {getAgentLabel(message.to_agent_id)}
											</strong>
											<span style={{ color: "#71717a", fontSize: "0.72rem" }}>
												{formatAgentMessageDate(message.created_at)}
											</span>
										</div>
										<div style={{ color: "#a1a1aa", fontSize: "0.8rem", marginBottom: "8px" }}>
											<span style={messageBadgeStyle}>{message.message_type}</span>
											{message.run_id && <span> Run: {message.run_id}</span>}
											{message.to_agent_id === selectedInboxAgentId && !message.read_at && (
												<span style={{ color: "#f59e0b", marginLeft: "8px" }}>Sin leer</span>
											)}
										</div>
										<div style={{ color: "#d4d4d8", fontSize: "0.86rem", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
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
						<FormInput
							label="Modelo"
							value={form.model}
							onChange={(v) => setForm((f) => ({ ...f, model: v }))}
							placeholder="e.g. openai/gpt-4o"
						/>
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
							<div style={{ color: "#e0e7ff", fontWeight: 800, fontSize: "0.95rem" }}>
								Configuración avanzada
							</div>
							<div style={{ color: "#a1a1aa", fontSize: "0.8rem", marginTop: 4 }}>
								Ajusta permisos, contexto, subagentes y límites del runtime. Los agentes personalizados heredan permisos completos si no restringes herramientas.
							</div>
						</div>

						<div className="responsive-grid-2" style={{ gap: "16px", marginBottom: "16px" }}>
							<FormInput
								label="Modelo fallback"
								value={form.fallbackModel}
								onChange={(v) => setForm((f) => ({ ...f, fallbackModel: v }))}
								placeholder="e.g. ollama/llama3.1"
							/>
							<FormSelect
								label="Permisos de herramientas"
								value={form.toolPermissionMode}
								options={["inherit", "allowlist", "denylist"]}
								onChange={(v) => setForm((f) => ({ ...f, toolPermissionMode: v }))}
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
							onChange={(v) => setForm((f) => ({ ...f, toolPermissionTools: v }))}
							placeholder="Una herramienta por línea. Vacío = sin lista específica."
							rows={3}
							disabled={form.toolPermissionMode === "inherit"}
						/>

						<div style={{ height: "14px" }} />

						<div className="responsive-grid-2" style={{ gap: "16px", marginBottom: "16px" }}>
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

						<div className="responsive-grid-2" style={{ gap: "16px", marginBottom: "16px" }}>
							<FormInput
								label="Profundidad subagentes"
								value={form.maxSpawnDepth}
								onChange={(v) => setForm((f) => ({ ...f, maxSpawnDepth: v }))}
								placeholder="0-5"
								type="number"
							/>
							<label style={{ display: "flex", alignItems: "center", gap: "10px", color: "#a1a1aa", fontSize: "0.86rem", paddingTop: "22px" }}>
								<input
									type="checkbox"
									checked={form.canSpawnSubagents}
									onChange={(e) => setForm((f) => ({ ...f, canSpawnSubagents: e.target.checked }))}
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
										const selected = form.knowledgeBaseIds.includes(collection.id);
										return (
											<button
												key={collection.id}
												type="button"
												onClick={() => toggleKnowledgeBase(collection.id)}
												style={{
													padding: "7px 10px",
													borderRadius: "999px",
													border: selected ? "1px solid #818cf8" : "1px solid #3f3f46",
													background: selected ? "rgba(129, 140, 248, 0.16)" : "#18181b",
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
				<div
					style={{
						padding: "60px 20px",
						textAlign: "center",
						color: "#71717a",
						borderRadius: "14px",
						border: "1px dashed #27272a",
						background: "rgba(24, 24, 27, 0.5)",
					}}
				>
					<div style={{ color: "#818cf8", marginBottom: "16px" }}>
						<AppIcon name="agent" size={48} strokeWidth={1.5} />
					</div>
					<div
						style={{ fontSize: "1.1rem", fontWeight: 600, color: "#a1a1aa" }}
					>
						Aún no hay agentes
					</div>
					<div style={{ fontSize: "0.85rem", marginTop: "8px" }}>
						Crea tu primer agente o conecta una plantilla especializada para
						empezar.
					</div>
					<button
						type="button"
						onClick={openCreate}
						style={{
							marginTop: "18px",
							padding: "10px 18px",
							borderRadius: 10,
							border: "1px solid #3b82f6",
							background: "#3b82f6",
							color: "#fff",
							fontWeight: 700,
							cursor: "pointer",
						}}
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
						}}
					>
						{agent.avatar ?? roleIcon}
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
								{agent.name}
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

			{agent.description && (
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
					{agent.description}
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
	<div className="settings-summary-card">
		<div className="settings-summary-label">{label}</div>
		<div className="settings-summary-value" style={{ color: accent }}>
			{value}
		</div>
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
					e.currentTarget.style.borderColor = "#3b82f6";
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
					e.currentTarget.style.borderColor = "#3b82f6";
				}}
				onBlur={(e) => {
					e.currentTarget.style.borderColor = "#3f3f46";
				}}
			/>
		</div>
	);
};

const actionBtnStyle: React.CSSProperties = {
	padding: "6px 14px",
	borderRadius: "8px",
	border: "1px solid #27272a",
	background: "#18181b",
	color: "#a1a1aa",
	fontSize: "0.8rem",
	fontWeight: 600,
	cursor: "pointer",
	transition: "all 0.2s ease",
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

const dangerBtnStyle: React.CSSProperties = {
	padding: "6px 14px",
	borderRadius: "8px",
	border: "1px solid rgba(239, 68, 68, 0.3)",
	background: "rgba(239, 68, 68, 0.08)",
	color: "#ef4444",
	fontSize: "0.8rem",
	fontWeight: 600,
	cursor: "pointer",
	transition: "all 0.2s ease",
};

const cancelBtnStyle: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: "10px",
	border: "1px solid #27272a",
	background: "#18181b",
	color: "#a1a1aa",
	fontSize: "0.9rem",
	fontWeight: 600,
	cursor: "pointer",
	transition: "all 0.2s ease",
};

const saveBtnStyle: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: "10px",
	border: "1px solid rgba(59, 130, 246, 0.3)",
	background: "rgba(59, 130, 246, 0.12)",
	color: "#3b82f6",
	fontSize: "0.9rem",
	fontWeight: 600,
	cursor: "pointer",
	transition: "all 0.2s ease",
};
