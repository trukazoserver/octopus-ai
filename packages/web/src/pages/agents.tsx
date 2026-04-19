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
	systemPrompt: string;
	model: string;
	avatar: string;
	color: string;
}

const ROLE_OPTIONS = [
	"assistant",
	"coder",
	"researcher",
	"writer",
	"analyst",
	"coordinator",
];

const ROLE_ICONS: Record<string, string> = {
	assistant: "🤖",
	coder: "💻",
	researcher: "🔍",
	writer: "✍️",
	analyst: "📊",
	coordinator: "🎯",
};

const API_BASE = `http://${window.location.hostname}:18789`;

const EMPTY_FORM: AgentFormData = {
	name: "",
	role: "assistant",
	personality: "",
	description: "",
	systemPrompt: "",
	model: "",
	avatar: "🤖",
	color: "#3b82f6",
};

async function deleteAgent(id: string): Promise<void> {
	const res = await fetch(`${API_BASE}/api/agents/${id}`, { method: "DELETE" });
	if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export const AgentsPage: React.FC = () => {
	const [agents, setAgents] = useState<AgentRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
	const [showForm, setShowForm] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<AgentFormData>({ ...EMPTY_FORM });
	const [saving, setSaving] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

	const loadAgents = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await apiGet<AgentRecord[]>("/api/agents");
			setAgents(data);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadAgents();
	}, [loadAgents]);

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
		setEditingId(agent.id);
		setForm({
			name: agent.name,
			role: agent.role,
			personality: agent.personality ?? "",
			description: agent.description ?? "",
			systemPrompt: agent.system_prompt,
			model: agent.model ?? "",
			avatar: agent.avatar ?? "🤖",
			color: agent.color ?? "#3b82f6",
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
			showMessage("Name is required", false);
			return;
		}
		setSaving(true);
		try {
			const payload = {
				name: form.name.trim(),
				role: form.role,
				personality: form.personality.trim(),
				description: form.description.trim(),
				systemPrompt: form.systemPrompt.trim(),
				model: form.model.trim(),
				avatar: form.avatar.trim(),
				color: form.color.trim(),
			};
			if (editingId) {
				await apiPut(`/api/agents/${editingId}`, payload);
				showMessage("Agent updated", true);
			} else {
				await apiPost("/api/agents", payload);
				showMessage("Agent created", true);
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
			showMessage("Agent deleted", true);
			setDeleteConfirm(null);
			await loadAgents();
		} catch (e) {
			showMessage(e instanceof Error ? e.message : String(e), false);
		} finally {
			setSaving(false);
		}
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
					<span>Loading agents...</span>
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
					Error loading agents: {error}
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
						Agents
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
						Manage your AI agents, their roles, personalities, and system
						prompts.
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
					Create Agent
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
				<StatCard label="Total Agents" value={agents.length} accent="#818cf8" />
				<StatCard label="Main Agent" value={mainCount} accent="#22c55e" />
				<StatCard
					label="Roles Used"
					value={Object.keys(roleCounts).length}
					accent="#f59e0b"
				/>
				<StatCard
					label="Custom Agents"
					value={agents.filter((a) => !a.is_main && !a.is_default).length}
					accent="#3b82f6"
				/>
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
						{editingId ? "Edit Agent" : "Create Agent"}
					</h3>

					<div
						className="responsive-grid-2"
						style={{ gap: "16px", marginBottom: "16px" }}
					>
						<FormInput
							label="Name"
							value={form.name}
							onChange={(v) => setForm((f) => ({ ...f, name: v }))}
							placeholder="Agent name"
						/>
						<FormSelect
							label="Role"
							value={form.role}
							options={ROLE_OPTIONS}
							onChange={(v) => setForm((f) => ({ ...f, role: v }))}
						/>
					</div>

					<div
						className="responsive-grid-2"
						style={{ gap: "16px", marginBottom: "16px" }}
					>
						<FormInput
							label="Model"
							value={form.model}
							onChange={(v) => setForm((f) => ({ ...f, model: v }))}
							placeholder="e.g. openai/gpt-4o"
						/>
						<FormInput
							label="Avatar (emoji or text)"
							value={form.avatar}
							onChange={(v) => setForm((f) => ({ ...f, avatar: v }))}
							placeholder="🤖"
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
							label="Description"
							value={form.description}
							onChange={(v) => setForm((f) => ({ ...f, description: v }))}
							placeholder="Short description"
						/>
					</div>

					<FormTextarea
						label="Personality"
						value={form.personality}
						onChange={(v) => setForm((f) => ({ ...f, personality: v }))}
						placeholder="Describe the agent's personality traits..."
						rows={3}
					/>

					<div style={{ height: "16px" }} />

					<FormTextarea
						label="System Prompt"
						value={form.systemPrompt}
						onChange={(v) => setForm((f) => ({ ...f, systemPrompt: v }))}
						placeholder="Define the agent's behavior and instructions..."
						rows={5}
					/>

					<div
						style={{
							display: "flex",
							gap: "10px",
							justifyContent: "flex-end",
							marginTop: "20px",
						}}
					>
						<button type="button" onClick={closeForm} style={cancelBtnStyle}>
							Cancel
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
								? "Saving..."
								: editingId
									? "Update Agent"
									: "Create Agent"}
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
					<div style={{ fontSize: "2.5rem", marginBottom: "16px" }}>🤖</div>
					<div
						style={{ fontSize: "1.1rem", fontWeight: 600, color: "#a1a1aa" }}
					>
						No agents yet
					</div>
					<div style={{ fontSize: "0.85rem", marginTop: "8px" }}>
						Click "Create Agent" to add your first agent.
					</div>
				</div>
			) : (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
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
									Main
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
							Delete?
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
							{saving ? "..." : "Yes"}
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
							Edit
						</button>
						<button type="button" onClick={onDelete} style={dangerBtnStyle}>
							Delete
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

const FormInput: React.FC<{
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	type?: string;
}> = ({ label, value, onChange, placeholder, type = "text" }) => (
	<div>
		<label style={labelStyle}>{label}</label>
		<input
			type={type}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			style={{
				...inputStyle,
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

const FormSelect: React.FC<{
	label: string;
	value: string;
	options: string[];
	onChange: (v: string) => void;
}> = ({ label, value, options, onChange }) => (
	<div>
		<label style={labelStyle}>{label}</label>
		<select
			value={value}
			onChange={(e) => onChange(e.target.value)}
			style={{
				...inputStyle,
				cursor: "pointer",
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

const FormTextarea: React.FC<{
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	rows?: number;
}> = ({ label, value, onChange, placeholder, rows = 3 }) => (
	<div>
		<label style={labelStyle}>{label}</label>
		<textarea
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			rows={rows}
			style={{
				...inputStyle,
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
