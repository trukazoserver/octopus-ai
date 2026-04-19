import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../hooks/useApi.js";

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
}

interface AgentFormData {
	name: string;
	role: string;
	personality: string;
	description: string;
	system_prompt: string;
	model: string;
	avatar: string;
	color: string;
}

const EMPTY_FORM: AgentFormData = {
	name: "",
	role: "assistant",
	personality: "",
	description: "",
	system_prompt: "",
	model: "",
	avatar: "",
	color: "",
};

const ROLE_OPTIONS = [
	"assistant",
	"analyst",
	"coder",
	"researcher",
	"writer",
	"manager",
	"custom",
];

const inputStyle: React.CSSProperties = {
	flex: 1,
	padding: "8px 12px",
	borderRadius: "8px",
	border: "1px solid #27272a",
	backgroundColor: "#0f1117",
	color: "#e4e4e7",
	fontSize: "13px",
	outline: "none",
};

const labelStyle: React.CSSProperties = {
	fontSize: "12px",
	color: "#71717a",
	marginBottom: "4px",
	display: "block",
};

const btnPrimary: React.CSSProperties = {
	padding: "8px 16px",
	borderRadius: "8px",
	backgroundColor: "#3b82f6",
	color: "#fff",
	border: "none",
	cursor: "pointer",
	fontSize: "13px",
};

const btnDanger: React.CSSProperties = {
	padding: "6px 12px",
	borderRadius: "6px",
	backgroundColor: "#991b1b",
	color: "#fca5a5",
	border: "none",
	cursor: "pointer",
	fontSize: "12px",
};

const btnGhost: React.CSSProperties = {
	padding: "6px 12px",
	borderRadius: "6px",
	backgroundColor: "#27272a",
	color: "#a1a1aa",
	border: "none",
	cursor: "pointer",
	fontSize: "12px",
};

export const Agents: React.FC = () => {
	const [agents, setAgents] = useState<AgentRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [showForm, setShowForm] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<AgentFormData>({ ...EMPTY_FORM });
	const [submitting, setSubmitting] = useState(false);

	const loadAgents = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await apiGet<AgentRecord[]>("/api/agents");
			setAgents(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load agents");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadAgents();
	}, [loadAgents]);

	const totalAgents = agents.length;
	const mainAgent = agents.find((a) => a.is_main === 1);
	const mainAgentName = mainAgent?.name ?? "None";
	const roleCounts: Record<string, number> = {};
	for (const a of agents) {
		roleCounts[a.role] = (roleCounts[a.role] || 0) + 1;
	}
	const uniqueRoles = Object.keys(roleCounts).length;

	const openCreate = () => {
		setEditingId(null);
		setForm({ ...EMPTY_FORM });
		setShowForm(true);
	};

	const openEdit = (agent: AgentRecord) => {
		setEditingId(agent.id);
		setForm({
			name: agent.name,
			role: agent.role,
			personality: agent.personality ?? "",
			description: agent.description ?? "",
			system_prompt: agent.system_prompt ?? "",
			model: agent.model ?? "",
			avatar: agent.avatar ?? "",
			color: agent.color ?? "",
		});
		setShowForm(true);
	};

	const handleSubmit = useCallback(async () => {
		if (!form.name.trim()) return;
		setSubmitting(true);
		setError(null);
		try {
			const body = {
				name: form.name,
				role: form.role,
				personality: form.personality || null,
				description: form.description || null,
				system_prompt: form.system_prompt,
				model: form.model || null,
				avatar: form.avatar || null,
				color: form.color || null,
			};
			if (editingId) {
				await apiPut(`/api/agents/${editingId}`, body);
			} else {
				await apiPost("/api/agents", body);
			}
			setShowForm(false);
			setEditingId(null);
			setForm({ ...EMPTY_FORM });
			await loadAgents();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save agent");
		} finally {
			setSubmitting(false);
		}
	}, [form, editingId, loadAgents]);

	const handleDelete = useCallback(
		async (id: string) => {
			setError(null);
			try {
				await apiGet<Record<string, unknown>>(`/api/agents/${id}`);
				await apiPost(`/api/agents/${id}/delete`, {});
				await loadAgents();
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to delete agent");
			}
		},
		[loadAgents],
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
					<h2 style={{ margin: "0 0 4px 0", fontSize: "20px" }}>Agents</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						Manage AI agents, their roles and configurations
					</p>
				</div>
				<div style={{ display: "flex", gap: "8px" }}>
					<button
						type="button"
						onClick={loadAgents}
						disabled={loading}
						style={{
							...btnGhost,
							opacity: loading ? 0.5 : 1,
						}}
					>
						{loading ? "Loading..." : "Refresh"}
					</button>
					<button type="button" onClick={openCreate} style={btnPrimary}>
						+ New Agent
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
						fontSize: "13px",
					}}
				>
					{error}
				</div>
			)}

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
					gap: "12px",
					marginBottom: "24px",
				}}
			>
				{[
					{ label: "Total Agents", value: totalAgents },
					{ label: "Main Agent", value: mainAgentName },
					{ label: "Unique Roles", value: uniqueRoles },
				].map((stat) => (
					<div
						key={stat.label}
						style={{
							padding: "16px",
							backgroundColor: "#18181b",
							borderRadius: "8px",
							border: "1px solid #27272a",
						}}
					>
						<div
							style={{
								fontSize: "12px",
								color: "#71717a",
								marginBottom: "4px",
							}}
						>
							{stat.label}
						</div>
						<div style={{ fontSize: "14px", fontWeight: 600 }}>
							{String(stat.value)}
						</div>
					</div>
				))}
			</div>

			{showForm && (
				<div
					style={{
						backgroundColor: "#18181b",
						borderRadius: "8px",
						border: "1px solid #27272a",
						padding: "20px",
						marginBottom: "24px",
					}}
				>
					<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>
						{editingId ? "Edit Agent" : "Create Agent"}
					</h3>

					<div
						style={{ display: "flex", flexDirection: "column", gap: "12px" }}
					>
						<div style={{ display: "flex", gap: "12px" }}>
							<div style={{ flex: 1 }}>
								<label style={labelStyle}>Name</label>
								<input
									type="text"
									value={form.name}
									onChange={(e) => setForm({ ...form, name: e.target.value })}
									style={inputStyle}
								/>
							</div>
							<div style={{ flex: 1 }}>
								<label style={labelStyle}>Role</label>
								<select
									value={form.role}
									onChange={(e) => setForm({ ...form, role: e.target.value })}
									style={inputStyle}
								>
									{ROLE_OPTIONS.map((r) => (
										<option key={r} value={r}>
											{r}
										</option>
									))}
								</select>
							</div>
							<div style={{ flex: 1 }}>
								<label style={labelStyle}>Model</label>
								<input
									type="text"
									value={form.model}
									onChange={(e) => setForm({ ...form, model: e.target.value })}
									placeholder="e.g. gpt-4o"
									style={inputStyle}
								/>
							</div>
						</div>

						<div style={{ display: "flex", gap: "12px" }}>
							<div style={{ flex: 1 }}>
								<label style={labelStyle}>Avatar</label>
								<input
									type="text"
									value={form.avatar}
									onChange={(e) => setForm({ ...form, avatar: e.target.value })}
									placeholder="emoji or URL"
									style={inputStyle}
								/>
							</div>
							<div style={{ flex: 1 }}>
								<label style={labelStyle}>Color</label>
								<input
									type="text"
									value={form.color}
									onChange={(e) => setForm({ ...form, color: e.target.value })}
									placeholder="e.g. #3b82f6"
									style={inputStyle}
								/>
							</div>
						</div>

						<div>
							<label style={labelStyle}>Description</label>
							<input
								type="text"
								value={form.description}
								onChange={(e) =>
									setForm({ ...form, description: e.target.value })
								}
								placeholder="Short description..."
								style={{ ...inputStyle, width: "100%" }}
							/>
						</div>

						<div>
							<label style={labelStyle}>Personality</label>
							<textarea
								value={form.personality}
								onChange={(e) =>
									setForm({ ...form, personality: e.target.value })
								}
								rows={2}
								placeholder="Agent personality traits..."
								style={{
									...inputStyle,
									width: "100%",
									resize: "vertical",
									fontFamily: "inherit",
								}}
							/>
						</div>

						<div>
							<label style={labelStyle}>System Prompt</label>
							<textarea
								value={form.system_prompt}
								onChange={(e) =>
									setForm({ ...form, system_prompt: e.target.value })
								}
								rows={4}
								placeholder="System prompt instructions..."
								style={{
									...inputStyle,
									width: "100%",
									resize: "vertical",
									fontFamily: "inherit",
								}}
							/>
						</div>

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
								style={btnGhost}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleSubmit}
								disabled={submitting || !form.name.trim()}
								style={{
									...btnPrimary,
									opacity: submitting || !form.name.trim() ? 0.5 : 1,
								}}
							>
								{submitting
									? "Saving..."
									: editingId
										? "Update Agent"
										: "Create Agent"}
							</button>
						</div>
					</div>
				</div>
			)}

			<div style={{ display: "grid", gap: "8px" }}>
				{agents.length > 0 ? (
					agents.map((agent) => (
						<div
							key={agent.id}
							style={{
								padding: "16px",
								backgroundColor: "#18181b",
								borderRadius: "8px",
								border: "1px solid #27272a",
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "flex-start",
									marginBottom: "8px",
								}}
							>
								<div
									style={{ display: "flex", alignItems: "center", gap: "10px" }}
								>
									{agent.avatar && (
										<span style={{ fontSize: "20px" }}>{agent.avatar}</span>
									)}
									<div>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												gap: "8px",
											}}
										>
											<span style={{ fontWeight: 600, fontSize: "14px" }}>
												{agent.name}
											</span>
											{agent.is_main === 1 && (
												<span
													style={{
														fontSize: "10px",
														padding: "2px 8px",
														borderRadius: "4px",
														backgroundColor: "#1e3a5f",
														color: "#60a5fa",
														fontWeight: 600,
													}}
												>
													MAIN
												</span>
											)}
											{agent.color && (
												<span
													style={{
														width: "10px",
														height: "10px",
														borderRadius: "50%",
														backgroundColor: agent.color,
														display: "inline-block",
													}}
												/>
											)}
										</div>
										<div
											style={{ display: "flex", gap: "6px", marginTop: "2px" }}
										>
											<span
												style={{
													fontSize: "11px",
													padding: "2px 8px",
													borderRadius: "4px",
													backgroundColor: "#1e1b4b",
													color: "#a78bfa",
												}}
											>
												{agent.role}
											</span>
											{agent.model && (
												<span
													style={{
														fontSize: "11px",
														padding: "2px 8px",
														borderRadius: "4px",
														backgroundColor: "#1a2e05",
														color: "#84cc16",
													}}
												>
													{agent.model}
												</span>
											)}
										</div>
									</div>
								</div>
								<div style={{ display: "flex", gap: "6px" }}>
									<button
										type="button"
										onClick={() => openEdit(agent)}
										style={btnGhost}
									>
										Edit
									</button>
									<button
										type="button"
										onClick={() => handleDelete(agent.id)}
										style={btnDanger}
									>
										Delete
									</button>
								</div>
							</div>

							{agent.description && (
								<div
									style={{
										color: "#a1a1aa",
										fontSize: "13px",
										marginBottom: "4px",
									}}
								>
									{agent.description}
								</div>
							)}

							{agent.personality && (
								<div
									style={{
										color: "#71717a",
										fontSize: "12px",
										fontStyle: "italic",
										marginBottom: "4px",
									}}
								>
									{agent.personality}
								</div>
							)}

							<div
								style={{ color: "#3f3f46", fontSize: "11px", marginTop: "6px" }}
							>
								Created: {new Date(agent.created_at).toLocaleDateString()}
								{agent.parent_id && (
									<> &middot; Parent: {agent.parent_id.slice(0, 8)}...</>
								)}
							</div>
						</div>
					))
				) : (
					<p
						style={{
							color: "#52525b",
							textAlign: "center",
							padding: "40px",
							fontSize: "13px",
						}}
					>
						{loading
							? "Loading..."
							: "No agents found. Create one to get started."}
					</p>
				)}
			</div>
		</div>
	);
};
