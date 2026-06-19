import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon } from "../components/ui/AppIcon.js";
import { Loading } from "../components/ui/Loading.js";
import { apiDelete, apiGet, apiPost, apiPutJson } from "../hooks/useApi.js";

interface Automation {
	id: string;
	name: string;
	description: string | null;
	trigger_type: string;
	trigger_config: string;
	action_type: string;
	action_config: string;
	agent_id: string | null;
	enabled: number;
	last_run: string | null;
	run_count: number;
	created_at: string;
	updated_at: string;
}

interface Agent {
	id: string;
	name?: string;
}

const TRIGGER_TYPES = ["cron", "event", "webhook"] as const;
const ACTION_TYPES = ["agent_task", "notify", "code", "api_call"] as const;

const TRIGGER_LABELS: Record<string, string> = {
	cron: "Programada",
	event: "Evento",
	webhook: "Webhook",
};

const ACTION_LABELS: Record<string, string> = {
	agent_task: "Tarea de agente",
	notify: "Notificación",
	code: "Código",
	api_call: "Llamada API",
};

const BG = "#09090b";
const PANEL = "#18181b";
const BORDER = "#27272a";
const PRIMARY = "#6366f1";
const TEXT = "#fafafa";
const MUTED = "#71717a";
const DANGER = "#ef4444";
const SUCCESS = "#22c55e";

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "10px 14px",
	borderRadius: 8,
	border: `1px solid ${BORDER}`,
	background: BG,
	color: TEXT,
	fontSize: "0.9rem",
	outline: "none",
	boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
	...inputStyle,
	cursor: "pointer",
};

const textareaStyle: React.CSSProperties = {
	...inputStyle,
	fontFamily:
		"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
	fontSize: "0.82rem",
	minHeight: 80,
	resize: "vertical" as const,
};

const panelStyle: React.CSSProperties = {
	background: PANEL,
	borderRadius: 12,
	border: `1px solid ${BORDER}`,
	padding: 20,
};

const btnPrimary: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: 8,
	border: "none",
	background: PRIMARY,
	color: "#fff",
	cursor: "pointer",
	fontWeight: 600,
	fontSize: "0.9rem",
};

const btnSecondary: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: 8,
	border: `1px solid ${BORDER}`,
	background: "transparent",
	color: TEXT,
	cursor: "pointer",
	fontWeight: 600,
	fontSize: "0.9rem",
};

const btnDanger: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: 8,
	border: "none",
	background: DANGER,
	color: "#fff",
	cursor: "pointer",
	fontWeight: 600,
	fontSize: "0.9rem",
};

const btnSmall: React.CSSProperties = {
	padding: "6px 14px",
	borderRadius: 6,
	border: `1px solid ${BORDER}`,
	background: "transparent",
	color: "#a1a1aa",
	cursor: "pointer",
	fontSize: "0.8rem",
	fontWeight: 600,
};

const btnSmallDanger: React.CSSProperties = {
	...btnSmall,
	borderColor: DANGER,
	color: DANGER,
};

interface FormData {
	name: string;
	description: string;
	triggerType: string;
	triggerConfig: string;
	actionType: string;
	actionConfig: string;
	agentId: string;
	enabled: boolean;
}

const emptyForm = (): FormData => ({
	name: "",
	description: "",
	triggerType: "cron",
	triggerConfig: "{}",
	actionType: "agent_task",
	actionConfig: "{}",
	agentId: "",
	enabled: true,
});

const validateJson = (value: string, label: string): string | null => {
	try {
		JSON.parse(value || "{}");
		return null;
	} catch (err) {
		return `${label} debe ser JSON válido: ${err instanceof Error ? err.message : String(err)}`;
	}
};

export const AutomationsPage: React.FC = () => {
	const [automations, setAutomations] = useState<Automation[]>([]);
	const [agents, setAgents] = useState<Agent[]>([]);
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
	const [showForm, setShowForm] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<FormData>(emptyForm());
	const [saving, setSaving] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
	const [togglingId, setTogglingId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [autosRes, agentsRes] = await Promise.all([
				apiGet<Automation[]>("/api/automations"),
				apiGet<Agent[]>("/api/agents").catch(() => []),
			]);
			setAutomations(Array.isArray(autosRes) ? autosRes : []);
			setAgents(Array.isArray(agentsRes) ? agentsRes : []);
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const showMsg = (text: string, ok = true) => {
		setMsg({ text, ok });
		setTimeout(() => setMsg(null), 4000);
	};

	const openCreate = () => {
		setEditingId(null);
		setForm(emptyForm());
		setShowForm(true);
	};

	const openEdit = (a: Automation) => {
		setEditingId(a.id);
		setForm({
			name: a.name,
			description: a.description ?? "",
			triggerType: a.trigger_type,
			triggerConfig: a.trigger_config,
			actionType: a.action_type,
			actionConfig: a.action_config,
			agentId: a.agent_id ?? "",
			enabled: a.enabled === 1,
		});
		setShowForm(true);
	};

	const closeForm = () => {
		setShowForm(false);
		setEditingId(null);
	};

	const handleSubmit = async () => {
		if (!form.name.trim()) {
			showMsg("El nombre es obligatorio", false);
			return;
		}
		const triggerError = validateJson(
			form.triggerConfig,
			"La configuración del disparador",
		);
		const actionError = validateJson(
			form.actionConfig,
			"La configuración de la acción",
		);
		if (triggerError || actionError) {
			showMsg(triggerError ?? actionError ?? "JSON inválido", false);
			return;
		}
		setSaving(true);
		setMsg(null);
		try {
			const payload = {
				name: form.name.trim(),
				description: form.description.trim() || null,
				triggerType: form.triggerType,
				triggerConfig: form.triggerConfig,
				actionType: form.actionType,
				actionConfig: form.actionConfig,
				agentId: form.agentId || null,
				enabled: form.enabled ? 1 : 0,
			};
			if (editingId) {
				await apiPutJson(`/api/automations/${editingId}`, payload);
				showMsg("Automatización actualizada");
			} else {
				await apiPost("/api/automations", payload);
				showMsg("Automatización creada");
			}
			closeForm();
			await load();
		} catch (e) {
			showMsg(e instanceof Error ? e.message : String(e), false);
		} finally {
			setSaving(false);
		}
	};

	const handleToggle = async (id: string) => {
		setTogglingId(id);
		try {
			await apiPost(`/api/automations/${id}/toggle`);
			await load();
		} catch (e) {
			showMsg(e instanceof Error ? e.message : String(e), false);
		} finally {
			setTogglingId(null);
		}
	};

	const handleDelete = async (id: string) => {
		try {
			await apiDelete(`/api/automations/${id}`);
			showMsg("Automatización eliminada");
			setDeleteConfirm(null);
			await load();
		} catch (e) {
			showMsg(e instanceof Error ? e.message : String(e), false);
		}
	};

	const configSummary = (json: string): string => {
		try {
			const obj = JSON.parse(json);
			const keys = Object.keys(obj);
			if (keys.length === 0) return "No config";
			return keys
				.slice(0, 2)
				.map((k) => `${k}: ${JSON.stringify(obj[k])}`)
				.join(", ");
		} catch {
			return json.slice(0, 40);
		}
	};

	if (loading) {
		return (
			<div className="page-shell">
				<Loading text="Cargando automatizaciones..." />
			</div>
		);
	}

	return (
		<div
			className="page-shell"
			style={{
				padding: 20,
				maxWidth: 1220,
				margin: "0 auto",
				overflowY: "auto",
				height: "100%",
				width: "100%",
			}}
		>
			<div className="page-header">
				<div>
					<h2
						className="ui-page-title"
						style={{ display: "flex", alignItems: "center", gap: 10 }}
					>
						<AppIcon name="automation" size={24} /> Automatizaciones
					</h2>
					<p className="ui-page-subtitle">
						Programa tareas, webhooks y acciones automáticas conectadas a
						agentes.
					</p>
				</div>
				<button
					type="button"
					className="ui-btn ui-btn--primary"
					onClick={openCreate}
				>
					Crear automatización
				</button>
			</div>

			{msg && (
				<div
					style={{
						padding: "10px 16px",
						borderRadius: 8,
						marginBottom: 12,
						background: msg.ok
							? "rgba(34,197,94,0.12)"
							: "rgba(239,68,68,0.12)",
						color: msg.ok ? SUCCESS : DANGER,
						fontSize: "0.85rem",
					}}
				>
					{msg.text}
				</div>
			)}

			{showForm && (
				<div style={{ ...panelStyle, marginBottom: 24 }}>
					<h3 style={{ margin: "0 0 16px", fontSize: "1.05rem" }}>
						{editingId ? "Editar automatización" : "Crear automatización"}
					</h3>

					<div className="responsive-grid-2" style={{ gap: 14 }}>
						<div style={{ gridColumn: "1 / -1" }}>
							<label
								htmlFor="automation-name"
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Nombre *
							</label>
							<input
								id="automation-name"
								name="name"
								type="text"
								value={form.name}
								onChange={(e) =>
									setForm((f) => ({ ...f, name: e.target.value }))
								}
								placeholder="Nombre de la automatización"
								style={inputStyle}
							/>
						</div>

						<div style={{ gridColumn: "1 / -1" }}>
							<label
								htmlFor="automation-description"
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Descripción
							</label>
							<input
								id="automation-description"
								name="description"
								type="text"
								value={form.description}
								onChange={(e) =>
									setForm((f) => ({ ...f, description: e.target.value }))
								}
								placeholder="Descripción opcional"
								style={inputStyle}
							/>
						</div>

						<div>
							<label
								htmlFor="automation-trigger-type"
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Disparador
							</label>
							<select
								id="automation-trigger-type"
								name="triggerType"
								value={form.triggerType}
								onChange={(e) =>
									setForm((f) => ({ ...f, triggerType: e.target.value }))
								}
								style={selectStyle}
							>
								{TRIGGER_TYPES.map((t) => (
									<option key={t} value={t}>
										{TRIGGER_LABELS[t] ?? t}
									</option>
								))}
							</select>
						</div>

						<div>
							<label
								htmlFor="automation-action-type"
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Acción
							</label>
							<select
								id="automation-action-type"
								name="actionType"
								value={form.actionType}
								onChange={(e) =>
									setForm((f) => ({ ...f, actionType: e.target.value }))
								}
								style={selectStyle}
							>
								{ACTION_TYPES.map((t) => (
									<option key={t} value={t}>
										{ACTION_LABELS[t] ?? t}
									</option>
								))}
							</select>
						</div>

						<div style={{ gridColumn: "1 / -1" }}>
							<label
								htmlFor="automation-trigger-config"
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Configuración del disparador (JSON)
							</label>
							<textarea
								id="automation-trigger-config"
								name="triggerConfig"
								value={form.triggerConfig}
								onChange={(e) =>
									setForm((f) => ({ ...f, triggerConfig: e.target.value }))
								}
								placeholder='{"schedule": "0 * * * *"}'
								style={textareaStyle}
							/>
						</div>

						<div style={{ gridColumn: "1 / -1" }}>
							<label
								htmlFor="automation-action-config"
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Configuración de la acción (JSON)
							</label>
							<textarea
								id="automation-action-config"
								name="actionConfig"
								value={form.actionConfig}
								onChange={(e) =>
									setForm((f) => ({ ...f, actionConfig: e.target.value }))
								}
								placeholder='{"task": "Run daily report"}'
								style={textareaStyle}
							/>
						</div>

						<div>
							<label
								htmlFor="automation-agent"
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Agente
							</label>
							<select
								id="automation-agent"
								name="agentId"
								value={form.agentId}
								onChange={(e) =>
									setForm((f) => ({ ...f, agentId: e.target.value }))
								}
								style={selectStyle}
							>
								<option value="">Ninguno</option>
								{agents.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name ?? a.id}
									</option>
								))}
							</select>
						</div>

						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 10,
								paddingTop: 20,
							}}
						>
							<span style={{ fontSize: "0.8rem", color: MUTED }}>Activa</span>
							<button
								type="button"
								aria-label={
									form.enabled
										? "Desactivar automatización"
										: "Activar automatización"
								}
								aria-pressed={form.enabled}
								onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
								style={{
									width: 44,
									height: 24,
									borderRadius: 12,
									border: "none",
									background: form.enabled ? SUCCESS : "#3f3f46",
									cursor: "pointer",
									position: "relative",
									transition: "background 0.2s",
								}}
							>
								<span
									style={{
										position: "absolute",
										top: 2,
										left: form.enabled ? 22 : 2,
										width: 20,
										height: 20,
										borderRadius: "50%",
										background: "#fff",
										transition: "left 0.2s",
									}}
								/>
							</button>
						</div>
					</div>

					<div style={{ display: "flex", gap: 10, marginTop: 20 }}>
						<button
							type="button"
							onClick={handleSubmit}
							disabled={saving}
							style={{
								...btnPrimary,
								opacity: saving ? 0.6 : 1,
								cursor: saving ? "not-allowed" : "pointer",
							}}
						>
							{saving ? "Guardando..." : editingId ? "Actualizar" : "Crear"}
						</button>
						<button type="button" onClick={closeForm} style={btnSecondary}>
							Cancelar
						</button>
					</div>
				</div>
			)}

			{automations.length === 0 && !showForm && (
				<div
					style={{
						textAlign: "center",
						padding: 60,
						color: MUTED,
						border: `1px dashed ${BORDER}`,
						borderRadius: 12,
					}}
				>
					<div style={{ color: PRIMARY, marginBottom: 12 }}>
						<AppIcon name="automation" size={42} strokeWidth={1.5} />
					</div>
					<div
						style={{
							color: TEXT,
							fontWeight: 700,
							fontSize: "1.05rem",
							marginBottom: 8,
						}}
					>
						Aún no hay automatizaciones
					</div>
					<div style={{ fontSize: "0.9rem" }}>
						Crea una automatización programada, por evento o webhook para
						empezar.
					</div>
					<button
						type="button"
						onClick={openCreate}
						style={{ ...btnPrimary, marginTop: 18 }}
					>
						Crear automatización
					</button>
				</div>
			)}

			<div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
				{automations.map((a) => (
					<div key={a.id} style={panelStyle}>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "flex-start",
								gap: 12,
								flexWrap: "wrap",
							}}
						>
							<div style={{ flex: 1, minWidth: 0 }}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 10,
										marginBottom: 4,
									}}
								>
									<span
										style={{
											fontWeight: 700,
											fontSize: "1rem",
											color: TEXT,
										}}
									>
										{a.name}
									</span>
									<span
										style={{
											padding: "3px 10px",
											borderRadius: 999,
											fontSize: "0.7rem",
											fontWeight: 700,
											textTransform: "uppercase",
											letterSpacing: "0.04em",
											background: a.enabled
												? "rgba(34,197,94,0.12)"
												: "rgba(113,113,122,0.15)",
											color: a.enabled ? SUCCESS : MUTED,
										}}
									>
										{a.enabled ? "Activa" : "Inactiva"}
									</span>
								</div>
								{a.description && (
									<div
										style={{
											fontSize: "0.85rem",
											color: "#a1a1aa",
											marginBottom: 8,
										}}
									>
										{a.description}
									</div>
								)}
								<div
									style={{
										display: "flex",
										gap: 16,
										flexWrap: "wrap",
										fontSize: "0.8rem",
										color: MUTED,
									}}
								>
									<span>
										Disparador:{" "}
										<span style={{ color: PRIMARY, fontWeight: 600 }}>
											{TRIGGER_LABELS[a.trigger_type] ?? a.trigger_type}
										</span>
										{a.trigger_config && a.trigger_config !== "{}" && (
											<span style={{ color: "#52525b", marginLeft: 4 }}>
												({configSummary(a.trigger_config)})
											</span>
										)}
									</span>
									<span>
										Acción:{" "}
										<span style={{ color: "#a78bfa", fontWeight: 600 }}>
											{ACTION_LABELS[a.action_type] ?? a.action_type}
										</span>
									</span>
									<span>
										Ejecuciones:{" "}
										<span style={{ color: TEXT }}>{a.run_count}</span>
									</span>
									{a.last_run && (
										<span>
											Última ejecución:{" "}
											<span style={{ color: TEXT }}>
												{new Date(a.last_run).toLocaleString()}
											</span>
										</span>
									)}
								</div>
							</div>

							<div
								style={{
									display: "flex",
									gap: 8,
									alignItems: "center",
									flexShrink: 0,
								}}
							>
								<button
									type="button"
									onClick={() => handleToggle(a.id)}
									disabled={togglingId === a.id}
									aria-label={
										a.enabled ? `Desactivar ${a.name}` : `Activar ${a.name}`
									}
									aria-pressed={Boolean(a.enabled)}
									style={{
										width: 44,
										height: 24,
										borderRadius: 12,
										border: "none",
										background: a.enabled ? SUCCESS : "#3f3f46",
										cursor: togglingId === a.id ? "not-allowed" : "pointer",
										position: "relative",
										transition: "background 0.2s",
										opacity: togglingId === a.id ? 0.5 : 1,
									}}
								>
									<span
										style={{
											position: "absolute",
											top: 2,
											left: a.enabled ? 22 : 2,
											width: 20,
											height: 20,
											borderRadius: "50%",
											background: "#fff",
											transition: "left 0.2s",
										}}
									/>
								</button>
								<button
									type="button"
									style={btnSmall}
									onClick={() => openEdit(a)}
								>
									Editar
								</button>
								{deleteConfirm === a.id ? (
									<>
										<button
											type="button"
											style={btnSmallDanger}
											onClick={() => handleDelete(a.id)}
										>
											Confirmar
										</button>
										<button
											type="button"
											style={btnSmall}
											onClick={() => setDeleteConfirm(null)}
										>
											Cancelar
										</button>
									</>
								) : (
									<button
										type="button"
										style={btnSmallDanger}
										onClick={() => setDeleteConfirm(a.id)}
									>
										Eliminar
									</button>
								)}
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
};
