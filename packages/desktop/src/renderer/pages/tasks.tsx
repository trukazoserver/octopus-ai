import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../hooks/useApi.js";

interface Task {
	id: string;
	title: string;
	description: string;
	priority: "low" | "medium" | "high" | "critical";
	status: "pending" | "running" | "completed" | "failed";
	assignedAgent: string;
	createdAt: string;
	updatedAt: string;
}

interface TaskStats {
	pending: number;
	running: number;
	completed: number;
	failed: number;
}

interface Agent {
	id: string;
	name: string;
}

type StatusFilter = "all" | "pending" | "running" | "completed" | "failed";

const PRIORITY_COLORS: Record<string, { bg: string; color: string }> = {
	low: { bg: "#1a2e05", color: "#84cc16" },
	medium: { bg: "#1e1b4b", color: "#a78bfa" },
	high: { bg: "#451a03", color: "#fb923c" },
	critical: { bg: "#450a0a", color: "#fca5a5" },
};

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
	pending: { bg: "#1e1b4b", color: "#a78bfa" },
	running: { bg: "#0c4a6e", color: "#38bdf8" },
	completed: { bg: "#1a2e05", color: "#84cc16" },
	failed: { bg: "#450a0a", color: "#fca5a5" },
};

const emptyForm = {
	title: "",
	description: "",
	priority: "medium" as Task["priority"],
	assignedAgent: "",
};

export const Tasks: React.FC = () => {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [stats, setStats] = useState<TaskStats>({
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
	});
	const [agents, setAgents] = useState<Agent[]>([]);
	const [loading, setLoading] = useState(true);
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [showForm, setShowForm] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState(emptyForm);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadData = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [tasksData, statsData, agentsData] = await Promise.all([
				apiGet<{ tasks: Task[] }>("/api/tasks"),
				apiGet<TaskStats>("/api/tasks/stats"),
				apiGet<{ agents: Agent[] }>("/api/agents"),
			]);
			setTasks(tasksData.tasks ?? []);
			setStats(statsData);
			setAgents(agentsData.agents ?? []);
		} catch {
			setError("Failed to load tasks");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadData();
	}, [loadData]);

	const filteredTasks =
		statusFilter === "all"
			? tasks
			: tasks.filter((t) => t.status === statusFilter);

	const openCreate = () => {
		setEditingId(null);
		setForm(emptyForm);
		setShowForm(true);
	};

	const openEdit = (task: Task) => {
		setEditingId(task.id);
		setForm({
			title: task.title,
			description: task.description,
			priority: task.priority,
			assignedAgent: task.assignedAgent,
		});
		setShowForm(true);
	};

	const handleSubmit = useCallback(async () => {
		if (!form.title.trim()) return;
		setSubmitting(true);
		setError(null);
		try {
			if (editingId) {
				await apiPut(`/api/tasks/${editingId}`, form);
			} else {
				await apiPost("/api/tasks", form);
			}
			setShowForm(false);
			setForm(emptyForm);
			setEditingId(null);
			await loadData();
		} catch {
			setError(editingId ? "Failed to update task" : "Failed to create task");
		} finally {
			setSubmitting(false);
		}
	}, [form, editingId, loadData]);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await apiPut(`/api/tasks/${id}`, { _delete: true });
				await loadData();
			} catch {
				setError("Failed to delete task");
			}
		},
		[loadData],
	);

	const statEntries: Array<{
		key: StatusFilter;
		label: string;
		count: number;
		color: string;
	}> = [
		{
			key: "pending",
			label: "Pending",
			count: stats.pending,
			color: "#a78bfa",
		},
		{
			key: "running",
			label: "Running",
			count: stats.running,
			color: "#38bdf8",
		},
		{
			key: "completed",
			label: "Completed",
			count: stats.completed,
			color: "#84cc16",
		},
		{ key: "failed", label: "Failed", count: stats.failed, color: "#fca5a5" },
	];

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
					<h2 style={{ margin: "0 0 4px 0", fontSize: "20px" }}>Tasks</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						Manage and track tasks assigned to agents
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
						+ New Task
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

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(4, 1fr)",
					gap: "12px",
					marginBottom: "20px",
				}}
			>
				{statEntries.map((s) => (
					<button
						key={s.key}
						type="button"
						onClick={() =>
							setStatusFilter(statusFilter === s.key ? "all" : s.key)
						}
						style={{
							padding: "16px",
							backgroundColor: "#18181b",
							borderRadius: "8px",
							border: "1px solid #27272a",
							cursor: "pointer",
							textAlign: "left",
							outline: statusFilter === s.key ? `2px solid ${s.color}` : "none",
						}}
					>
						<div
							style={{
								fontSize: "12px",
								color: "#71717a",
								marginBottom: "4px",
							}}
						>
							{s.label}
						</div>
						<div style={{ fontSize: "24px", fontWeight: 700, color: s.color }}>
							{s.count}
						</div>
					</button>
				))}
			</div>

			<div
				style={{
					display: "flex",
					gap: "8px",
					marginBottom: "20px",
					borderBottom: "1px solid #27272a",
					paddingBottom: "12px",
				}}
			>
				{(
					["all", "pending", "running", "completed", "failed"] as StatusFilter[]
				).map((s) => (
					<button
						key={s}
						type="button"
						onClick={() => setStatusFilter(s)}
						style={{
							padding: "8px 16px",
							borderRadius: "8px",
							fontSize: "13px",
							border: "none",
							cursor: "pointer",
							backgroundColor: statusFilter === s ? "#3b82f6" : "transparent",
							color: statusFilter === s ? "#fff" : "#71717a",
							textTransform: "capitalize",
						}}
					>
						{s === "all"
							? `All (${tasks.length})`
							: `${s} (${stats[s as keyof TaskStats] ?? 0})`}
					</button>
				))}
			</div>

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
						{editingId ? "Edit Task" : "Create Task"}
					</h3>
					<div
						style={{ display: "flex", flexDirection: "column", gap: "12px" }}
					>
						<input
							type="text"
							placeholder="Task title"
							value={form.title}
							onChange={(e) =>
								setForm((f) => ({ ...f, title: e.target.value }))
							}
							style={{
								padding: "8px 12px",
								borderRadius: "8px",
								border: "1px solid #27272a",
								backgroundColor: "#0f1117",
								color: "#e4e4e7",
								fontSize: "13px",
								outline: "none",
							}}
						/>
						<textarea
							placeholder="Description"
							value={form.description}
							onChange={(e) =>
								setForm((f) => ({ ...f, description: e.target.value }))
							}
							rows={3}
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
							<select
								value={form.priority}
								onChange={(e) =>
									setForm((f) => ({
										...f,
										priority: e.target.value as Task["priority"],
									}))
								}
								style={{
									padding: "8px 12px",
									borderRadius: "8px",
									border: "1px solid #27272a",
									backgroundColor: "#0f1117",
									color: "#e4e4e7",
									fontSize: "13px",
									outline: "none",
									flex: 1,
								}}
							>
								<option value="low">Low Priority</option>
								<option value="medium">Medium Priority</option>
								<option value="high">High Priority</option>
								<option value="critical">Critical Priority</option>
							</select>
							<select
								value={form.assignedAgent}
								onChange={(e) =>
									setForm((f) => ({ ...f, assignedAgent: e.target.value }))
								}
								style={{
									padding: "8px 12px",
									borderRadius: "8px",
									border: "1px solid #27272a",
									backgroundColor: "#0f1117",
									color: "#e4e4e7",
									fontSize: "13px",
									outline: "none",
									flex: 1,
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
								disabled={submitting || !form.title.trim()}
								style={{
									padding: "8px 16px",
									borderRadius: "8px",
									fontSize: "13px",
									border: "none",
									cursor: "pointer",
									backgroundColor: "#3b82f6",
									color: "#fff",
									opacity: submitting || !form.title.trim() ? 0.5 : 1,
								}}
							>
								{submitting ? "Saving..." : editingId ? "Update" : "Create"}
							</button>
						</div>
					</div>
				</div>
			)}

			<div style={{ display: "grid", gap: "8px" }}>
				{filteredTasks.length > 0 ? (
					filteredTasks.map((task) => (
						<div
							key={task.id}
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
											{task.title}
										</span>
										<span
											style={{
												fontSize: "11px",
												padding: "2px 8px",
												borderRadius: "4px",
												backgroundColor: PRIORITY_COLORS[task.priority]?.bg,
												color: PRIORITY_COLORS[task.priority]?.color,
											}}
										>
											{task.priority}
										</span>
										<span
											style={{
												fontSize: "11px",
												padding: "2px 8px",
												borderRadius: "4px",
												backgroundColor: STATUS_COLORS[task.status]?.bg,
												color: STATUS_COLORS[task.status]?.color,
											}}
										>
											{task.status}
										</span>
									</div>
									{task.description && (
										<div
											style={{
												color: "#71717a",
												fontSize: "12px",
												marginBottom: "4px",
											}}
										>
											{task.description}
										</div>
									)}
								</div>
								<div
									style={{ display: "flex", gap: "4px", marginLeft: "12px" }}
								>
									<button
										type="button"
										onClick={() => openEdit(task)}
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
										onClick={() => handleDelete(task.id)}
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
							<div
								style={{
									display: "flex",
									gap: "16px",
									fontSize: "11px",
									color: "#52525b",
								}}
							>
								{task.assignedAgent && <span>Agent: {task.assignedAgent}</span>}
								<span>
									Created:{" "}
									{task.createdAt
										? new Date(task.createdAt).toLocaleString()
										: "N/A"}
								</span>
								<span>
									Updated:{" "}
									{task.updatedAt
										? new Date(task.updatedAt).toLocaleString()
										: "N/A"}
								</span>
							</div>
						</div>
					))
				) : (
					<p style={{ color: "#52525b", textAlign: "center", padding: "40px" }}>
						{loading ? "Loading..." : "No tasks found."}
					</p>
				)}
			</div>
		</div>
	);
};
