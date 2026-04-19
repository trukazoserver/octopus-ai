import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../hooks/useApi.js";

interface Automation {
	id: string;
	name: string;
	description: string;
	triggerType: string;
	triggerConfig: string;
	actionType: string;
	actionConfig: string;
	agent: string;
	enabled: boolean;
	runCount: number;
	createdAt: string;
	updatedAt: string;
}

interface Agent {
	id: string;
	name: string;
}

const TRIGGER_TYPES = ["cron", "webhook", "event", "schedule", "manual"];
const ACTION_TYPES = [
	"run_agent",
	"send_notification",
	"call_webhook",
	"execute_code",
	"create_task",
];

const emptyForm = {
	name: "",
	description: "",
	triggerType: "cron",
	triggerConfig: "{}",
	actionType: "run_agent",
	actionConfig: "{}",
	agent: "",
};

export const Automations: React.FC = () => {
	const [automations, setAutomations] = useState<Automation[]>([]);
	const [agents, setAgents] = useState<Agent[]>([]);
	const [loading, setLoading] = useState(true);
	const [showForm, setShowForm] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState(emptyForm);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [jsonError, setJsonError] = useState<string | null>(null);

	const loadData = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [automationsData, agentsData] = await Promise.all([
				apiGet<{ automations: Automation[] }>("/api/automations"),
				apiGet<{ agents: Agent[] }>("/api/agents"),
			]);
			setAutomations(automationsData.automations ?? []);
			setAgents(agentsData.agents ?? []);
		} catch {
			setError("Failed to load automations");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadData();
	}, [loadData]);

	const validateJson = (str: string): boolean => {
		try {
			JSON.parse(str);
			setJsonError(null);
			return true;
		} catch {
			setJsonError("Invalid JSON");
			return false;
		}
	};

	const openCreate = () => {
		setEditingId(null);
		setForm(emptyForm);
		setJsonError(null);
		setShowForm(true);
	};

	const openEdit = (auto: Automation) => {
		setEditingId(auto.id);
		setForm({
			name: auto.name,
			description: auto.description,
			triggerType: auto.triggerType,
			triggerConfig: auto.triggerConfig,
			actionType: auto.actionType,
			actionConfig: auto.actionConfig,
			agent: auto.agent,
		});
		setJsonError(null);
		setShowForm(true);
	};

	const handleSubmit = useCallback(async () => {
		if (!form.name.trim()) return;
		if (!validateJson(form.triggerConfig)) return;
		if (!validateJson(form.actionConfig)) return;
		setSubmitting(true);
		setError(null);
		try {
			if (editingId) {
				await apiPut(`/api/automations/${editingId}`, form);
			} else {
				await apiPost("/api/automations", form);
			}
			setShowForm(false);
			setForm(emptyForm);
			setEditingId(null);
			await loadData();
		} catch {
			setError(
				editingId
					? "Failed to update automation"
					: "Failed to create automation",
			);
		} finally {
			setSubmitting(false);
		}
	}, [form, editingId, loadData]);

	const handleToggle = useCallback(
		async (auto: Automation) => {
			try {
				await apiPost(`/api/automations/${auto.id}/toggle`);
				await loadData();
			} catch {
				setError("Failed to toggle automation");
			}
		},
		[loadData],
	);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await apiPut(`/api/automations/${id}`, { _delete: true });
				await loadData();
			} catch {
				setError("Failed to delete automation");
			}
		},
		[loadData],
	);

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
				<div>
					<h2 style={{ margin: "0 0 4px 0", fontSize: "20px" }}>Automations</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						Configure automated workflows and triggers
					</p>
				</div>
				<div style={{ display: "flex", gap: "8px" }}>
					<button
						type="button"
						onClick={loadData}
						disabled={loading}
						style={{
							padding: "8px 16px",
							borderRadius: "8px",
							fontSize: "13px",
							border: "none",
							cursor: "pointer",
							backgroundColor: "#27272a",
							color: "#a1a1aa",
						}}
					>
						{loading ? "Loading..." : "Refresh"}
					</button>
					<button
						type="button"
						onClick={openCreate}
						style={{
							padding: "8px 16px",
							borderRadius: "8px",
							fontSize: "13px",
							border: "none",
							cursor: "pointer",
							backgroundColor: "#3b82f6",
							color: "#fff",
						}}
					>
						+ New Automation
					</button>
				</div>
			</div>

			{error && (
				<div
					style={{
						padding: "12px",
						backgroundColor: "#450a0a",
						borderRadius: "8px",
						marginBottom: "16px",
						color: "#fca5a5",
					}}
				>
					{error}
				</div>
			)}

			{showForm && (
				<div
					style={{
						padding: "20px",
						backgroundColor: "#18181b",
						borderRadius: "8px",
						border: "1px solid #27272a",
						marginBottom: "20px",
					}}
				>
					<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>
						{editingId ? "Edit Automation" : "Create Automation"}
					</h3>
					<div
						style={{ display: "flex", flexDirection: "column", gap: "12px" }}
					>
						<div style={{ display: "flex", gap: "12px" }}>
							<input
								type="text"
								placeholder="Automation name"
								value={form.name}
								onChange={(e) =>
									setForm((f) => ({ ...f, name: e.target.value }))
								}
								style={{
									flex: 1,
									padding: "8px 12px",
									borderRadius: "8px",
									border: "1px solid #27272a",
									backgroundColor: "#0f1117",
									color: "#e4e4e7",
									fontSize: "13px",
									outline: "none",
								}}
							/>
							<select
								value={form.agent}
								onChange={(e) =>
									setForm((f) => ({ ...f, agent: e.target.value }))
								}
								style={{
									padding: "8px 12px",
									borderRadius: "8px",
									border: "1px solid #27272a",
									backgroundColor: "#0f1117",
									color: "#e4e4e7",
									fontSize: "13px",
									outline: "none",
									width: "180px",
								}}
							>
								<option value="">No Agent</option>
								{agents.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name}
									</option>
								))}
							</select>
						</div>
						<textarea
							placeholder="Description"
							value={form.description}
							onChange={(e) =>
								setForm((f) => ({ ...f, description: e.target.value }))
							}
							rows={2}
							style={{
								padding: "8px 12px",
								borderRadius: "8px",
								border: "1px solid #27272a",
								backgroundColor: "#0f1117",
								color: "#e4e4e7",
								fontSize: "13px",
								outline: "none",
								resize: "vertical",
								fontFamily: "inherit",
							}}
						/>
						<div style={{ display: "flex", gap: "12px" }}>
							<div style={{ flex: 1 }}>
								<label
									style={{
										fontSize: "12px",
										color: "#71717a",
										marginBottom: "4px",
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
									style={{
										width: "100%",
										padding: "8px 12px",
										borderRadius: "8px",
										border: "1px solid #27272a",
										backgroundColor: "#0f1117",
										color: "#e4e4e7",
										fontSize: "13px",
										outline: "none",
									}}
								>
									{TRIGGER_TYPES.map((t) => (
										<option key={t} value={t}>
											{t}
										</option>
									))}
								</select>
							</div>
							<div style={{ flex: 1 }}>
								<label
									style={{
										fontSize: "12px",
										color: "#71717a",
										marginBottom: "4px",
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
									style={{
										width: "100%",
										padding: "8px 12px",
										borderRadius: "8px",
										border: "1px solid #27272a",
										backgroundColor: "#0f1117",
										color: "#e4e4e7",
										fontSize: "13px",
										outline: "none",
									}}
								>
									{ACTION_TYPES.map((t) => (
										<option key={t} value={t}>
											{t}
										</option>
									))}
								</select>
							</div>
						</div>
						<div style={{ display: "flex", gap: "12px" }}>
							<div style={{ flex: 1 }}>
								<label
									style={{
										fontSize: "12px",
										color: "#71717a",
										marginBottom: "4px",
										display: "block",
									}}
								>
									Trigger Config (JSON)
								</label>
								<textarea
									value={form.triggerConfig}
									onChange={(e) => {
										setForm((f) => ({ ...f, triggerConfig: e.target.value }));
										validateJson(e.target.value);
									}}
									rows={3}
									style={{
										width: "100%",
										padding: "8px 12px",
										borderRadius: "8px",
										border: "1px solid #27272a",
										backgroundColor: "#0f1117",
										color: "#e4e4e7",
										fontSize: "12px",
										outline: "none",
										resize: "vertical",
										fontFamily: "monospace",
										borderColor: jsonError ? "#ef4444" : "#27272a",
									}}
								/>
							</div>
							<div style={{ flex: 1 }}>
								<label
									style={{
										fontSize: "12px",
										color: "#71717a",
										marginBottom: "4px",
										display: "block",
									}}
								>
									Action Config (JSON)
								</label>
								<textarea
									value={form.actionConfig}
									onChange={(e) => {
										setForm((f) => ({ ...f, actionConfig: e.target.value }));
										validateJson(e.target.value);
									}}
									rows={3}
									style={{
										width: "100%",
										padding: "8px 12px",
										borderRadius: "8px",
										border: "1px solid #27272a",
										backgroundColor: "#0f1117",
										color: "#e4e4e7",
										fontSize: "12px",
										outline: "none",
										resize: "vertical",
										fontFamily: "monospace",
										borderColor: jsonError ? "#ef4444" : "#27272a",
									}}
								/>
							</div>
						</div>
						{jsonError && (
							<div style={{ fontSize: "12px", color: "#ef4444" }}>
								{jsonError}
							</div>
						)}
						<div
							style={{
								display: "flex",
								gap: "8px",
								justifyContent: "flex-end",
							}}
						>
							<button
								type="button"
								onClick={() => {
									setShowForm(false);
									setEditingId(null);
								}}
								style={{
									padding: "8px 16px",
									borderRadius: "8px",
									fontSize: "13px",
									border: "none",
									cursor: "pointer",
									backgroundColor: "#27272a",
									color: "#a1a1aa",
								}}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleSubmit}
								disabled={submitting || !form.name.trim()}
								style={{
									padding: "8px 16px",
									borderRadius: "8px",
									fontSize: "13px",
									border: "none",
									cursor: "pointer",
									backgroundColor: "#3b82f6",
									color: "#fff",
									opacity: submitting || !form.name.trim() ? 0.5 : 1,
								}}
							>
								{submitting ? "Saving..." : editingId ? "Update" : "Create"}
							</button>
						</div>
					</div>
				</div>
			)}

			<div style={{ display: "grid", gap: "8px" }}>
				{automations.length > 0 ? (
					automations.map((auto) => (
						<div
							key={auto.id}
							style={{
								padding: "16px",
								backgroundColor: "#18181b",
								borderRadius: "8px",
								border: "1px solid #27272a",
								opacity: auto.enabled ? 1 : 0.6,
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "flex-start",
								}}
							>
								<div style={{ flex: 1 }}>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
											marginBottom: "4px",
										}}
									>
										<span style={{ fontWeight: 600, fontSize: "14px" }}>
											{auto.name}
										</span>
										<span
											style={{
												fontSize: "11px",
												padding: "2px 8px",
												borderRadius: "4px",
												backgroundColor: "#1e1b4b",
												color: "#a78bfa",
											}}
										>
											{auto.triggerType}
										</span>
										<span
											style={{
												fontSize: "11px",
												padding: "2px 8px",
												borderRadius: "4px",
												backgroundColor: "#0c4a6e",
												color: "#38bdf8",
											}}
										>
											{auto.actionType}
										</span>
										<span
											style={{
												fontSize: "11px",
												padding: "2px 8px",
												borderRadius: "4px",
												backgroundColor: auto.enabled ? "#1a2e05" : "#27272a",
												color: auto.enabled ? "#84cc16" : "#71717a",
											}}
										>
											{auto.enabled ? "Enabled" : "Disabled"}
										</span>
									</div>
									{auto.description && (
										<div
											style={{
												color: "#71717a",
												fontSize: "12px",
												marginBottom: "4px",
											}}
										>
											{auto.description}
										</div>
									)}
									<div
										style={{
											display: "flex",
											gap: "16px",
											fontSize: "11px",
											color: "#52525b",
										}}
									>
										{auto.agent && <span>Agent: {auto.agent}</span>}
										<span>Runs: {auto.runCount}</span>
										<span>
											Created:{" "}
											{auto.createdAt
												? new Date(auto.createdAt).toLocaleString()
												: "N/A"}
										</span>
									</div>
								</div>
								<div
									style={{
										display: "flex",
										gap: "4px",
										marginLeft: "12px",
										alignItems: "center",
									}}
								>
									<button
										type="button"
										onClick={() => handleToggle(auto)}
										style={{
											padding: "4px 10px",
											borderRadius: "6px",
											fontSize: "12px",
											border: "1px solid #27272a",
											backgroundColor: "transparent",
											color: auto.enabled ? "#fca5a5" : "#84cc16",
											cursor: "pointer",
										}}
									>
										{auto.enabled ? "Disable" : "Enable"}
									</button>
									<button
										type="button"
										onClick={() => openEdit(auto)}
										style={{
											padding: "4px 10px",
											borderRadius: "6px",
											fontSize: "12px",
											border: "1px solid #27272a",
											backgroundColor: "transparent",
											color: "#a1a1aa",
											cursor: "pointer",
										}}
									>
										Edit
									</button>
									<button
										type="button"
										onClick={() => handleDelete(auto.id)}
										style={{
											padding: "4px 10px",
											borderRadius: "6px",
											fontSize: "12px",
											border: "1px solid #450a0a",
											backgroundColor: "transparent",
											color: "#fca5a5",
											cursor: "pointer",
										}}
									>
										Delete
									</button>
								</div>
							</div>
						</div>
					))
				) : (
					<p style={{ color: "#52525b", textAlign: "center", padding: "40px" }}>
						{loading ? "Loading..." : "No automations configured."}
					</p>
				)}
			</div>
		</div>
	);
};
