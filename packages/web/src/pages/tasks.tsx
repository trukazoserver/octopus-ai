import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../hooks/useApi.js";

interface Task {
	id: string;
	title: string;
	description: string | null;
	status: string;
	priority: number;
	assigned_agent_id: string | null;
	created_by: string | null;
	parent_task_id: string | null;
	result: string | null;
	error: string | null;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	metadata: string | null;
}

interface TaskStats {
	pending: number;
	running: number;
	completed: number;
	failed: number;
	total: number;
}

interface Agent {
	id: string;
	name: string;
	[key: string]: unknown;
}

type StatusFilter = "all" | "pending" | "running" | "completed" | "failed";

const STATUS_OPTIONS: StatusFilter[] = [
	"all",
	"pending",
	"running",
	"completed",
	"failed",
];

const STATUS_COLORS: Record<string, string> = {
	pending: "#f59e0b",
	running: "#3b82f6",
	completed: "#10b981",
	failed: "#ef4444",
};

const STATUS_LABELS: Record<string, string> = {
	pending: "Pending",
	running: "Running",
	completed: "Completed",
	failed: "Failed",
};

const EDITABLE_STATUSES = ["pending", "running", "completed", "failed"];

export const TasksPage: React.FC = () => {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [stats, setStats] = useState<TaskStats>({
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
		total: 0,
	});
	const [agents, setAgents] = useState<Agent[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [activeFilter, setActiveFilter] = useState<StatusFilter>("all");
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

	const [showCreateForm, setShowCreateForm] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	const [newDescription, setNewDescription] = useState("");
	const [newPriority, setNewPriority] = useState(5);
	const [newAgentId, setNewAgentId] = useState("");
	const [creating, setCreating] = useState(false);

	const [editingTask, setEditingTask] = useState<Task | null>(null);
	const [editTitle, setEditTitle] = useState("");
	const [editDescription, setEditDescription] = useState("");
	const [editStatus, setEditStatus] = useState("pending");
	const [editAgentId, setEditAgentId] = useState("");
	const [saving, setSaving] = useState(false);

	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	const loadStats = useCallback(async () => {
		try {
			const s = await apiGet<TaskStats>("/api/tasks/stats");
			setStats(s);
		} catch {
			// stats will remain default
		}
	}, []);

	const loadTasks = useCallback(async () => {
		try {
			const query = activeFilter !== "all" ? `?status=${activeFilter}` : "";
			const result = await apiGet<Task[]>(`/api/tasks${query}`);
			setTasks(Array.isArray(result) ? result : []);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [activeFilter]);

	const loadAgents = useCallback(async () => {
		try {
			const result = await apiGet<Agent[]>("/api/agents");
			setAgents(Array.isArray(result) ? result : []);
		} catch {
			setAgents([]);
		}
	}, []);

	useEffect(() => {
		Promise.all([loadStats(), loadTasks(), loadAgents()]).finally(() =>
			setLoading(false),
		);
	}, [loadStats, loadTasks, loadAgents]);

	useEffect(() => {
		if (!loading) {
			loadTasks();
			loadStats();
		}
	}, [activeFilter]);

	useEffect(() => {
		if (msg) {
			const t = setTimeout(() => setMsg(null), 4000);
			return () => clearTimeout(t);
		}
		return undefined;
	}, [msg]);

	const handleCreate = async () => {
		if (!newTitle.trim()) return;
		setCreating(true);
		setMsg(null);
		try {
			await apiPost("/api/tasks", {
				title: newTitle.trim(),
				description: newDescription.trim() || null,
				priority: newPriority,
				assignedAgentId: newAgentId || null,
			});
			setNewTitle("");
			setNewDescription("");
			setNewPriority(5);
			setNewAgentId("");
			setShowCreateForm(false);
			setMsg({ text: "Task created", ok: true });
			await Promise.all([loadTasks(), loadStats()]);
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		} finally {
			setCreating(false);
		}
	};

	const startEdit = (task: Task) => {
		setEditingTask(task);
		setEditTitle(task.title);
		setEditDescription(task.description ?? "");
		setEditStatus(task.status);
		setEditAgentId(task.assigned_agent_id ?? "");
		setConfirmDeleteId(null);
	};

	const handleSaveEdit = async () => {
		if (!editingTask) return;
		setSaving(true);
		setMsg(null);
		try {
			await apiPut(`/api/tasks/${editingTask.id}`, {
				title: editTitle.trim(),
				description: editDescription.trim() || null,
				status: editStatus,
				assignedAgentId: editAgentId || null,
			});
			setEditingTask(null);
			setMsg({ text: "Task updated", ok: true });
			await Promise.all([loadTasks(), loadStats()]);
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async (id: string) => {
		setDeletingId(id);
		setMsg(null);
		try {
			await fetch(`/api/tasks/${id}`, { method: "DELETE" });
			setConfirmDeleteId(null);
			setMsg({ text: "Task deleted", ok: true });
			await Promise.all([loadTasks(), loadStats()]);
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		} finally {
			setDeletingId(null);
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
						gap: 16,
					}}
				>
					<span
						style={{
							width: 32,
							height: 32,
							borderRadius: "50%",
							background: "#3b82f6",
							animation: "pulse 1.4s infinite ease-in-out",
						}}
					/>
					<span>Loading tasks...</span>
				</div>
			</div>
		);
	}

	if (error) {
		return <div style={{ padding: 40, color: "#ef4444" }}>Error: {error}</div>;
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
						Tasks
					</h2>
					<p
						style={{
							margin: "8px 0 0",
							color: "#a1a1aa",
							fontSize: "0.95rem",
							maxWidth: 700,
							lineHeight: 1.6,
						}}
					>
						Manage and track tasks across agents
					</p>
				</div>
				<button
					type="button"
					onClick={() => {
						setShowCreateForm(!showCreateForm);
						setEditingTask(null);
					}}
					style={{
						padding: "10px 20px",
						borderRadius: 10,
						border: "1px solid #27272a",
						background: showCreateForm ? "#27272a" : "#3b82f6",
						color: "#f4f4f5",
						cursor: "pointer",
						fontWeight: 600,
						fontSize: "0.9rem",
						flexShrink: 0,
					}}
				>
					{showCreateForm ? "Cancel" : "+ Create Task"}
				</button>
			</div>

			{msg && (
				<div
					style={{
						padding: "12px 16px",
						borderRadius: 10,
						marginBottom: 20,
						background: msg.ok
							? "rgba(16, 185, 129, 0.1)"
							: "rgba(239, 68, 68, 0.1)",
						color: msg.ok ? "#10b981" : "#ef4444",
						border: `1px solid ${msg.ok ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)"}`,
						fontSize: "0.9rem",
						fontWeight: 500,
					}}
				>
					{msg.text}
				</div>
			)}

			<div className="stats-grid" style={{ marginBottom: 24 }}>
				<StatCard icon="📋" label="Total" value={stats.total} color="#e4e4e7" />
				<StatCard
					icon="⏳"
					label="Pending"
					value={stats.pending}
					color={STATUS_COLORS.pending}
				/>
				<StatCard
					icon="▶️"
					label="Running"
					value={stats.running}
					color={STATUS_COLORS.running}
				/>
				<StatCard
					icon="✅"
					label="Completed"
					value={stats.completed}
					color={STATUS_COLORS.completed}
				/>
				<StatCard
					icon="❌"
					label="Failed"
					value={stats.failed}
					color={STATUS_COLORS.failed}
				/>
			</div>

			{showCreateForm && (
				<div
					style={{
						background: "#18181b",
						borderRadius: 14,
						border: "1px solid #27272a",
						padding: 20,
						marginBottom: 24,
					}}
				>
					<h3
						style={{
							margin: "0 0 16px",
							fontSize: "1.1rem",
							fontWeight: 700,
							color: "#f4f4f5",
						}}
					>
						Create New Task
					</h3>
					<div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
						<div>
							<label
								style={{
									display: "block",
									fontSize: "0.8rem",
									color: "#a1a1aa",
									marginBottom: 6,
									fontWeight: 600,
									textTransform: "uppercase",
									letterSpacing: "0.04em",
								}}
							>
								Title *
							</label>
							<input
								type="text"
								value={newTitle}
								onChange={(e) => setNewTitle(e.target.value)}
								placeholder="Task title"
								style={inputStyle}
							/>
						</div>
						<div>
							<label
								style={{
									display: "block",
									fontSize: "0.8rem",
									color: "#a1a1aa",
									marginBottom: 6,
									fontWeight: 600,
									textTransform: "uppercase",
									letterSpacing: "0.04em",
								}}
							>
								Description
							</label>
							<textarea
								value={newDescription}
								onChange={(e) => setNewDescription(e.target.value)}
								placeholder="Task description (optional)"
								rows={3}
								style={{
									...inputStyle,
									resize: "vertical",
									fontFamily: "inherit",
								}}
							/>
						</div>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 14,
							}}
						>
							<div>
								<label
									style={{
										display: "block",
										fontSize: "0.8rem",
										color: "#a1a1aa",
										marginBottom: 6,
										fontWeight: 600,
										textTransform: "uppercase",
										letterSpacing: "0.04em",
									}}
								>
									Priority: {newPriority}
								</label>
								<input
									type="range"
									min={1}
									max={10}
									value={newPriority}
									onChange={(e) => setNewPriority(Number(e.target.value))}
									style={{ width: "100%", accentColor: "#3b82f6" }}
								/>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										fontSize: "0.7rem",
										color: "#71717a",
									}}
								>
									<span>1 (Low)</span>
									<span>10 (Critical)</span>
								</div>
							</div>
							<div>
								<label
									style={{
										display: "block",
										fontSize: "0.8rem",
										color: "#a1a1aa",
										marginBottom: 6,
										fontWeight: 600,
										textTransform: "uppercase",
										letterSpacing: "0.04em",
									}}
								>
									Assign Agent
								</label>
								<select
									value={newAgentId}
									onChange={(e) => setNewAgentId(e.target.value)}
									style={selectStyle}
								>
									<option value="">Unassigned</option>
									{agents.map((a) => (
										<option key={a.id} value={a.id}>
											{a.name || a.id}
										</option>
									))}
								</select>
							</div>
						</div>
						<div
							style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}
						>
							<button
								type="button"
								onClick={() => setShowCreateForm(false)}
								style={cancelBtnStyle}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleCreate}
								disabled={creating || !newTitle.trim()}
								style={{
									...primaryBtnStyle,
									opacity: creating || !newTitle.trim() ? 0.5 : 1,
									cursor:
										creating || !newTitle.trim() ? "not-allowed" : "pointer",
								}}
							>
								{creating ? "Creating..." : "Create Task"}
							</button>
						</div>
					</div>
				</div>
			)}

			{editingTask && (
				<div
					style={{
						background: "#18181b",
						borderRadius: 14,
						border: "1px solid #27272a",
						padding: 20,
						marginBottom: 24,
					}}
				>
					<h3
						style={{
							margin: "0 0 16px",
							fontSize: "1.1rem",
							fontWeight: 700,
							color: "#f4f4f5",
						}}
					>
						Edit Task
					</h3>
					<div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
						<div>
							<label
								style={{
									display: "block",
									fontSize: "0.8rem",
									color: "#a1a1aa",
									marginBottom: 6,
									fontWeight: 600,
									textTransform: "uppercase",
									letterSpacing: "0.04em",
								}}
							>
								Title
							</label>
							<input
								type="text"
								value={editTitle}
								onChange={(e) => setEditTitle(e.target.value)}
								style={inputStyle}
							/>
						</div>
						<div>
							<label
								style={{
									display: "block",
									fontSize: "0.8rem",
									color: "#a1a1aa",
									marginBottom: 6,
									fontWeight: 600,
									textTransform: "uppercase",
									letterSpacing: "0.04em",
								}}
							>
								Description
							</label>
							<textarea
								value={editDescription}
								onChange={(e) => setEditDescription(e.target.value)}
								rows={3}
								style={{
									...inputStyle,
									resize: "vertical",
									fontFamily: "inherit",
								}}
							/>
						</div>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 14,
							}}
						>
							<div>
								<label
									style={{
										display: "block",
										fontSize: "0.8rem",
										color: "#a1a1aa",
										marginBottom: 6,
										fontWeight: 600,
										textTransform: "uppercase",
										letterSpacing: "0.04em",
									}}
								>
									Status
								</label>
								<select
									value={editStatus}
									onChange={(e) => setEditStatus(e.target.value)}
									style={selectStyle}
								>
									{EDITABLE_STATUSES.map((s) => (
										<option key={s} value={s}>
											{STATUS_LABELS[s] ?? s}
										</option>
									))}
								</select>
							</div>
							<div>
								<label
									style={{
										display: "block",
										fontSize: "0.8rem",
										color: "#a1a1aa",
										marginBottom: 6,
										fontWeight: 600,
										textTransform: "uppercase",
										letterSpacing: "0.04em",
									}}
								>
									Assign Agent
								</label>
								<select
									value={editAgentId}
									onChange={(e) => setEditAgentId(e.target.value)}
									style={selectStyle}
								>
									<option value="">Unassigned</option>
									{agents.map((a) => (
										<option key={a.id} value={a.id}>
											{a.name || a.id}
										</option>
									))}
								</select>
							</div>
						</div>
						<div
							style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}
						>
							<button
								type="button"
								onClick={() => setEditingTask(null)}
								style={cancelBtnStyle}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleSaveEdit}
								disabled={saving}
								style={{
									...primaryBtnStyle,
									opacity: saving ? 0.5 : 1,
									cursor: saving ? "not-allowed" : "pointer",
								}}
							>
								{saving ? "Saving..." : "Save Changes"}
							</button>
						</div>
					</div>
				</div>
			)}

			<div
				style={{
					display: "flex",
					gap: 8,
					marginBottom: 20,
					flexWrap: "wrap",
					borderBottom: "1px solid #27272a",
					paddingBottom: 12,
				}}
			>
				{STATUS_OPTIONS.map((s) => {
					const isActive = activeFilter === s;
					return (
						<button
							key={s}
							type="button"
							onClick={() => setActiveFilter(s)}
							style={{
								padding: "8px 16px",
								borderRadius: 8,
								border: `1px solid ${isActive ? "#3b82f6" : "#27272a"}`,
								background: isActive ? "rgba(59, 130, 246, 0.15)" : "#09090b",
								color: isActive ? "#3b82f6" : "#a1a1aa",
								cursor: "pointer",
								fontWeight: 600,
								fontSize: "0.85rem",
								transition: "all 0.15s ease",
							}}
						>
							{s === "all" ? "All" : (STATUS_LABELS[s] ?? s)}
							{s === "all" && stats.total > 0 && (
								<span style={{ marginLeft: 6, opacity: 0.7 }}>
									({stats.total})
								</span>
							)}
							{s !== "all" && stats[s as keyof TaskStats] > 0 && (
								<span style={{ marginLeft: 6, opacity: 0.7 }}>
									({stats[s as keyof TaskStats]})
								</span>
							)}
						</button>
					);
				})}
			</div>

			{tasks.length === 0 ? (
				<div
					style={{
						textAlign: "center",
						padding: "48px 20px",
						color: "#71717a",
						background: "#18181b",
						borderRadius: 14,
						border: "1px solid #27272a",
					}}
				>
					<div style={{ fontSize: "2rem", marginBottom: 12 }}>📋</div>
					<div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: 6 }}>
						No tasks found
					</div>
					<div style={{ fontSize: "0.85rem" }}>
						{activeFilter !== "all" ? "Try changing the filter or " : ""}
						Create a new task to get started
					</div>
				</div>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
					{tasks.map((task) => {
						const isConfirming = confirmDeleteId === task.id;
						const isDeleting = deletingId === task.id;
						return (
							<div
								key={task.id}
								style={{
									background: "#18181b",
									borderRadius: 12,
									border: "1px solid #27272a",
									padding: 16,
									transition: "border-color 0.2s ease",
								}}
								onMouseEnter={(e) => {
									e.currentTarget.style.borderColor = "#3f3f46";
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.borderColor = "#27272a";
								}}
							>
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
												marginBottom: 6,
												flexWrap: "wrap",
											}}
										>
											<span
												style={{
													fontSize: "1rem",
													fontWeight: 700,
													color: "#f4f4f5",
												}}
											>
												{task.title}
											</span>
											<span
												style={{
													padding: "2px 8px",
													borderRadius: 999,
													fontSize: "0.7rem",
													fontWeight: 700,
													textTransform: "uppercase",
													letterSpacing: "0.04em",
													background: `${STATUS_COLORS[task.status] ?? "#71717a"}20`,
													color: STATUS_COLORS[task.status] ?? "#71717a",
													border: `1px solid ${STATUS_COLORS[task.status] ?? "#71717a"}40`,
												}}
											>
												{STATUS_LABELS[task.status] ?? task.status}
											</span>
											<span
												style={{
													padding: "2px 8px",
													borderRadius: 6,
													fontSize: "0.7rem",
													fontWeight: 700,
													background:
														task.priority >= 8
															? "rgba(239, 68, 68, 0.15)"
															: task.priority >= 5
																? "rgba(245, 158, 11, 0.15)"
																: "rgba(99, 102, 241, 0.1)",
													color:
														task.priority >= 8
															? "#ef4444"
															: task.priority >= 5
																? "#f59e0b"
																: "#818cf8",
													border: `1px solid ${task.priority >= 8 ? "rgba(239, 68, 68, 0.25)" : task.priority >= 5 ? "rgba(245, 158, 11, 0.25)" : "rgba(99, 102, 241, 0.2)"}`,
												}}
											>
												P{task.priority}
											</span>
										</div>
										{task.description && (
											<div
												style={{
													fontSize: "0.85rem",
													color: "#a1a1aa",
													marginBottom: 8,
													lineHeight: 1.5,
												}}
											>
												{task.description}
											</div>
										)}
										<div
											style={{
												display: "flex",
												gap: 16,
												fontSize: "0.75rem",
												color: "#71717a",
												flexWrap: "wrap",
											}}
										>
											{task.assigned_agent_id && (
												<span>
													Agent:{" "}
													<span style={{ color: "#a1a1aa" }}>
														{agents.find((a) => a.id === task.assigned_agent_id)
															?.name ?? task.assigned_agent_id}
													</span>
												</span>
											)}
											<span>Created: {formatDate(task.created_at)}</span>
											{task.started_at && (
												<span>Started: {formatDate(task.started_at)}</span>
											)}
											{task.completed_at && (
												<span>Completed: {formatDate(task.completed_at)}</span>
											)}
										</div>
										{task.error && (
											<div
												style={{
													marginTop: 8,
													padding: "8px 12px",
													borderRadius: 8,
													background: "rgba(239, 68, 68, 0.08)",
													border: "1px solid rgba(239, 68, 68, 0.15)",
													fontSize: "0.8rem",
													color: "#f87171",
												}}
											>
												{task.error}
											</div>
										)}
										{task.result && (
											<div
												style={{
													marginTop: 8,
													padding: "8px 12px",
													borderRadius: 8,
													background: "rgba(16, 185, 129, 0.08)",
													border: "1px solid rgba(16, 185, 129, 0.15)",
													fontSize: "0.8rem",
													color: "#34d399",
												}}
											>
												{task.result}
											</div>
										)}
									</div>
									<div
										style={{
											display: "flex",
											gap: 6,
											flexShrink: 0,
											alignItems: "center",
										}}
									>
										{!isConfirming ? (
											<>
												<button
													type="button"
													onClick={() => startEdit(task)}
													style={actionBtnStyle}
													title="Edit"
												>
													✏️
												</button>
												<button
													type="button"
													onClick={() => setConfirmDeleteId(task.id)}
													style={actionBtnStyle}
													title="Delete"
												>
													🗑️
												</button>
											</>
										) : (
											<>
												<span
													style={{
														fontSize: "0.8rem",
														color: "#f87171",
														fontWeight: 600,
													}}
												>
													Delete?
												</span>
												<button
													type="button"
													onClick={() => handleDelete(task.id)}
													disabled={isDeleting}
													style={{
														padding: "6px 12px",
														borderRadius: 6,
														border: "1px solid rgba(239, 68, 68, 0.3)",
														background: "rgba(239, 68, 68, 0.15)",
														color: "#f87171",
														cursor: isDeleting ? "not-allowed" : "pointer",
														fontSize: "0.8rem",
														fontWeight: 600,
													}}
												>
													{isDeleting ? "..." : "Yes"}
												</button>
												<button
													type="button"
													onClick={() => setConfirmDeleteId(null)}
													style={{
														padding: "6px 12px",
														borderRadius: 6,
														border: "1px solid #27272a",
														background: "#27272a",
														color: "#a1a1aa",
														cursor: "pointer",
														fontSize: "0.8rem",
														fontWeight: 600,
													}}
												>
													No
												</button>
											</>
										)}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

function formatDate(iso: string | null): string {
	if (!iso) return "—";
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

const StatCard: React.FC<{
	icon: string;
	label: string;
	value: number;
	color: string;
}> = ({ icon, label, value, color }) => (
	<div className="settings-summary-card">
		<div className="settings-summary-label">
			{icon} {label}
		</div>
		<div className="settings-summary-value" style={{ color }}>
			{value}
		</div>
	</div>
);

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "10px 12px",
	borderRadius: 8,
	border: "1px solid #27272a",
	background: "#09090b",
	color: "#f4f4f5",
	fontSize: "0.9rem",
	outline: "none",
	boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
	width: "100%",
	padding: "10px 12px",
	borderRadius: 8,
	border: "1px solid #27272a",
	background: "#09090b",
	color: "#f4f4f5",
	fontSize: "0.9rem",
	outline: "none",
	boxSizing: "border-box",
};

const primaryBtnStyle: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: 8,
	border: "none",
	background: "#3b82f6",
	color: "#fff",
	fontWeight: 600,
	fontSize: "0.9rem",
};

const cancelBtnStyle: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: 8,
	border: "1px solid #27272a",
	background: "transparent",
	color: "#a1a1aa",
	cursor: "pointer",
	fontWeight: 600,
	fontSize: "0.9rem",
};

const actionBtnStyle: React.CSSProperties = {
	width: 34,
	height: 34,
	borderRadius: 8,
	border: "1px solid #27272a",
	background: "transparent",
	cursor: "pointer",
	fontSize: "0.9rem",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
};
