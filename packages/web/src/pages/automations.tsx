import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../hooks/useApi.js";

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

const BG = "#09090b";
const PANEL = "#18181b";
const BORDER = "#27272a";
const PRIMARY = "#3b82f6";
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

export const AutomationsPage: React.FC = () => {
	const [automations, setAutomations] = useState<Automation[]>([]);
	const [agents, setAgents] = useState<Agent[]>([]);
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState<string | null>(null);
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
			setMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const showMsg = (text: string) => {
		setMsg(text);
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
			showMsg("Name is required");
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
				await apiPut(`/api/automations/${editingId}`, payload);
				showMsg("Automation updated");
			} else {
				await apiPost("/api/automations", payload);
				showMsg("Automation created");
			}
			closeForm();
			await load();
		} catch (e) {
			showMsg(e instanceof Error ? e.message : String(e));
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
			showMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setTogglingId(null);
		}
	};

	const handleDelete = async (id: string) => {
		try {
			await fetch(`/api/automations/${id}`, { method: "DELETE" });
			showMsg("Automation deleted");
			setDeleteConfirm(null);
			await load();
		} catch (e) {
			showMsg(e instanceof Error ? e.message : String(e));
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
			<div className="page-shell" style={{ padding: 40, color: MUTED }}>
				Loading automations...
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
				<h2 style={{ margin: 0, fontSize: "1.3rem" }}>Automations</h2>
				<button type="button" style={btnPrimary} onClick={openCreate}>
					+ Create Automation
				</button>
			</div>

			{msg && (
				<div
					style={{
						padding: "10px 16px",
						borderRadius: 8,
						marginBottom: 12,
						background:
							msg.includes("Error") || msg.startsWith("\u2717")
								? "rgba(239,68,68,0.12)"
								: "rgba(34,197,94,0.12)",
						color:
							msg.includes("Error") || msg.startsWith("\u2717")
								? DANGER
								: SUCCESS,
						fontSize: "0.85rem",
					}}
				>
					{msg}
				</div>
			)}

			{showForm && (
				<div style={{ ...panelStyle, marginBottom: 24 }}>
					<h3 style={{ margin: "0 0 16px", fontSize: "1.05rem" }}>
						{editingId ? "Edit Automation" : "Create Automation"}
					</h3>

					<div
						style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
					>
						<div style={{ gridColumn: "1 / -1" }}>
							<label
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Name *
							</label>
							<input
								type="text"
								value={form.name}
								onChange={(e) =>
									setForm((f) => ({ ...f, name: e.target.value }))
								}
								placeholder="Automation name"
								style={inputStyle}
							/>
						</div>

						<div style={{ gridColumn: "1 / -1" }}>
							<label
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Description
							</label>
							<input
								type="text"
								value={form.description}
								onChange={(e) =>
									setForm((f) => ({ ...f, description: e.target.value }))
								}
								placeholder="Optional description"
								style={inputStyle}
							/>
						</div>

						<div>
							<label
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Trigger Type
							</label>
							<select
								value={form.triggerType}
								onChange={(e) =>
									setForm((f) => ({ ...f, triggerType: e.target.value }))
								}
								style={selectStyle}
							>
								{TRIGGER_TYPES.map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
						</div>

						<div>
							<label
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Action Type
							</label>
							<select
								value={form.actionType}
								onChange={(e) =>
									setForm((f) => ({ ...f, actionType: e.target.value }))
								}
								style={selectStyle}
							>
								{ACTION_TYPES.map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
						</div>

						<div style={{ gridColumn: "1 / -1" }}>
							<label
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Trigger Config (JSON)
							</label>
							<textarea
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
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Action Config (JSON)
							</label>
							<textarea
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
								style={{
									fontSize: "0.8rem",
									color: MUTED,
									marginBottom: 4,
									display: "block",
								}}
							>
								Agent
							</label>
							<select
								value={form.agentId}
								onChange={(e) =>
									setForm((f) => ({ ...f, agentId: e.target.value }))
								}
								style={selectStyle}
							>
								<option value="">None</option>
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
							<label style={{ fontSize: "0.8rem", color: MUTED }}>
								Enabled
							</label>
							<button
								type="button"
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
							{saving ? "Saving..." : editingId ? "Update" : "Create"}
						</button>
						<button type="button" onClick={closeForm} style={btnSecondary}>
							Cancel
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
					<div style={{ fontSize: "2rem", marginBottom: 8 }}>
						No automations yet
					</div>
					<div style={{ fontSize: "0.9rem" }}>
						Click "Create Automation" to get started.
					</div>
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
										{a.enabled ? "Enabled" : "Disabled"}
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
										Trigger:{" "}
										<span style={{ color: PRIMARY, fontWeight: 600 }}>
											{a.trigger_type}
										</span>
										{a.trigger_config && a.trigger_config !== "{}" && (
											<span style={{ color: "#52525b", marginLeft: 4 }}>
												({configSummary(a.trigger_config)})
											</span>
										)}
									</span>
									<span>
										Action:{" "}
										<span style={{ color: "#a78bfa", fontWeight: 600 }}>
											{a.action_type}
										</span>
									</span>
									<span>
										Runs: <span style={{ color: TEXT }}>{a.run_count}</span>
									</span>
									{a.last_run && (
										<span>
											Last run:{" "}
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
									Edit
								</button>
								{deleteConfirm === a.id ? (
									<>
										<button
											type="button"
											style={btnSmallDanger}
											onClick={() => handleDelete(a.id)}
										>
											Confirm
										</button>
										<button
											type="button"
											style={btnSmall}
											onClick={() => setDeleteConfirm(null)}
										>
											Cancel
										</button>
									</>
								) : (
									<button
										type="button"
										style={btnSmallDanger}
										onClick={() => setDeleteConfirm(a.id)}
									>
										Delete
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
