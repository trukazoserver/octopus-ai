import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon } from "../components/ui/AppIcon.js";
import { apiDelete, apiGet, apiPost, apiPutJson } from "../hooks/useApi.js";

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

interface WorkflowRun {
	id: string;
	conversation_id: string | null;
	root_agent_id: string | null;
	goal: string;
	status: string;
	current_phase: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	metadata: string | null;
}

interface WorkflowTask {
	id: string;
	run_id: string;
	assigned_agent_id: string | null;
	arm_key: string | null;
	title: string;
	status: string;
	attempt_count: number;
	stagnant_attempt_count: number;
	max_stagnant_attempts: number;
	updated_at: string;
	metadata: string | null;
}

interface WorkflowSnapshot {
	run: WorkflowRun;
	tasks: WorkflowTask[];
	events: Array<{
		id: string;
		event_type: string;
		message: string | null;
		created_at: string;
		metadata: string | null;
	}>;
	artifacts: Array<{
		id: string;
		artifact_type: string;
		url: string | null;
		path: string | null;
		description: string | null;
	}>;
}

type PageTab = "kanban" | "tasks" | "scheduled";
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
	running: "#6366f1",
	completed: "#10b981",
	failed: "#ef4444",
};

const STATUS_LABELS: Record<string, string> = {
	pending: "Pendiente",
	running: "En ejecución",
	completed: "Completada",
	failed: "Fallida",
};

const FILTER_LABELS: Record<StatusFilter, string> = {
	all: "Todas",
	pending: "Pendientes",
	running: "En ejecución",
	completed: "Completadas",
	failed: "Fallidas",
};

const EDITABLE_STATUSES = ["pending", "running", "completed", "failed"];

function taskStatusClass(status: string): string {
	if (status === "completed") return "is-done";
	if (status === "running") return "is-running";
	if (status === "pending") return "is-warning";
	if (status === "failed") return "is-failed";
	return "is-neutral";
}

function workflowStatusClass(status: string): string {
	if (status === "done") return "is-done";
	if (["running", "ready", "triage"].includes(status)) return "is-running";
	if (["waiting_dependency", "partial"].includes(status)) return "is-warning";
	if (["blocked", "failed", "timed_out"].includes(status)) return "is-failed";
	return "is-neutral";
}
const SELECTED_WORKFLOW_STORAGE_KEY = "octopus-selected-workflow-run";

function parseMetadata(
	value: string | null | undefined,
): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function metadataString(
	metadata: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

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
	const [workflows, setWorkflows] = useState<WorkflowRun[]>([]);
	const [selectedWorkflow, setSelectedWorkflow] =
		useState<WorkflowSnapshot | null>(null);
	const [workflowActioning, setWorkflowActioning] = useState<string | null>(
		null,
	);
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
	const [pageTab, setPageTab] = useState<PageTab>("kanban");

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
			setError(null);
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

	const loadWorkflows = useCallback(async () => {
		try {
			const result = await apiGet<WorkflowRun[]>("/api/workflows?limit=8");
			setWorkflows(Array.isArray(result) ? result : []);
		} catch {
			setWorkflows([]);
		}
	}, []);

	const openWorkflow = useCallback(async (id: string) => {
		try {
			setSelectedWorkflow(
				await apiGet<WorkflowSnapshot>(`/api/workflows/${id}`),
			);
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		}
	}, []);

	const refreshSelectedWorkflow = useCallback(async () => {
		if (!selectedWorkflow) return;
		await openWorkflow(selectedWorkflow.run.id);
	}, [openWorkflow, selectedWorkflow]);

	const recoverWorkflows = async () => {
		setWorkflowActioning("recover");
		try {
			const result = await apiPost("/api/workflows/recover");
			setMsg({
				text: `Recovery completado: ${String(result.runs ?? 0)} runs, ${String(result.tasks ?? 0)} subtareas`,
				ok: true,
			});
			await Promise.all([loadWorkflows(), refreshSelectedWorkflow()]);
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		} finally {
			setWorkflowActioning(null);
		}
	};

	const runWorkflowAction = async (id: string, action: "retry" | "cancel") => {
		setWorkflowActioning(`${action}:${id}`);
		try {
			await apiPost(
				`/api/workflows/${id}/${action}`,
				action === "cancel" ? { reason: "Cancelado desde Tasks" } : undefined,
			);
			setMsg({
				text: action === "retry" ? "Workflow reenviado" : "Workflow cancelado",
				ok: true,
			});
			await Promise.all([loadWorkflows(), openWorkflow(id)]);
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		} finally {
			setWorkflowActioning(null);
		}
	};

	useEffect(() => {
		let requestedWorkflowId: string | null = null;
		try {
			requestedWorkflowId = localStorage.getItem(SELECTED_WORKFLOW_STORAGE_KEY);
			if (requestedWorkflowId) {
				localStorage.removeItem(SELECTED_WORKFLOW_STORAGE_KEY);
			}
		} catch {
			requestedWorkflowId = null;
		}
		if (requestedWorkflowId) void openWorkflow(requestedWorkflowId);
	}, [openWorkflow]);

	useEffect(() => {
		Promise.all([
			loadStats(),
			loadTasks(),
			loadAgents(),
			loadWorkflows(),
		]).finally(() => setLoading(false));
	}, [loadStats, loadTasks, loadAgents, loadWorkflows]);

	useEffect(() => {
		if (!loading) {
			loadTasks();
			loadStats();
			loadWorkflows();
		}
	}, [loading, loadTasks, loadStats, loadWorkflows]);

	useEffect(() => {
		if (msg) {
			const t = setTimeout(() => setMsg(null), 4000);
			return () => clearTimeout(t);
		}
		return undefined;
	}, [msg]);

	const handleCreate = async () => {
		if (!newTitle.trim()) {
			setMsg({ text: "El título es obligatorio", ok: false });
			return;
		}
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
			setMsg({ text: "Tarea creada", ok: true });
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
		if (!editTitle.trim()) {
			setMsg({ text: "El título es obligatorio", ok: false });
			return;
		}
		setSaving(true);
		setMsg(null);
		try {
			await apiPutJson(`/api/tasks/${editingTask.id}`, {
				title: editTitle.trim(),
				description: editDescription.trim() || null,
				status: editStatus,
				assignedAgentId: editAgentId || null,
			});
			setEditingTask(null);
			setMsg({ text: "Tarea actualizada", ok: true });
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
			await apiDelete(`/api/tasks/${id}`);
			setConfirmDeleteId(null);
			setMsg({ text: "Tarea eliminada", ok: true });
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
							background: "#6366f1",
							animation: "pulse 1.4s infinite ease-in-out",
						}}
					/>
					<span>Cargando tareas...</span>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="page-shell">
				<div
					style={{
						padding: "32px",
						borderRadius: "16px",
						border: "1px solid rgba(239,68,68,0.25)",
						background: "rgba(239,68,68,0.08)",
						color: "#fca5a5",
						textAlign: "center",
					}}
				>
					<AppIcon name="warning" size={32} />
					<div style={{ fontWeight: 700, margin: "10px 0 6px" }}>
						No se pudieron cargar las tareas
					</div>
					<div style={{ fontSize: "0.85rem", marginBottom: 14 }}>{error}</div>
					<button
						type="button"
						onClick={() => {
							setError(null);
							void Promise.all([loadTasks(), loadStats()]);
						}}
						style={{
							padding: "8px 14px",
							borderRadius: 8,
							border: "1px solid #ef4444",
							background: "transparent",
							color: "#fca5a5",
							cursor: "pointer",
						}}
					>
						Reintentar
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="page-shell page-shell--xl">
			<div className="page-header">
				<div>
					<h2 className="ui-page-title">Tablero de Tareas</h2>
					<p className="ui-page-subtitle">
						{pageTab === "kanban"
							? "Tablero visual Kanban Swarm — flujos multi-agente con dependencias y artefactos."
							: pageTab === "tasks"
								? "Tareas individuales asignadas a agentes específicos."
								: "Tareas programadas que se ejecutan automáticamente según un horario o evento."}
					</p>
				</div>
				<button
					type="button"
					onClick={() => {
						setShowCreateForm(!showCreateForm);
						setEditingTask(null);
					}}
					className={`ui-btn ${showCreateForm ? "ui-btn--secondary" : "ui-btn--primary"}`}
					style={{ flexShrink: 0 }}
				>
					{showCreateForm ? "Cancelar" : "+ Crear tarea"}
				</button>
			</div>

			{/* Tabs de navegación */}
			<div className="ui-tabs" style={{ marginBottom: 24 }}>
				{(
					[
						{ id: "kanban" as PageTab, label: "Tablero Kanban", icon: "📋" },
						{
							id: "tasks" as PageTab,
							label: "Tareas Individuales",
							icon: "📝",
						},
						{
							id: "scheduled" as PageTab,
							label: "Tareas Programadas",
							icon: "⏰",
						},
					] as Array<{ id: PageTab; label: string; icon: string }>
				).map((tab) => {
					const isActive = pageTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							onClick={() => setPageTab(tab.id)}
							className={`ui-tab${isActive ? " is-active" : ""}`}
						>
							<span aria-hidden="true">{tab.icon}</span>
							{tab.label}
						</button>
					);
				})}
			</div>

			{msg && (
				<div
					className={`ui-notice ${msg.ok ? "is-ok" : "is-error"}`}
					style={{ marginBottom: 20 }}
				>
					{msg.text}
				</div>
			)}

			{pageTab === "tasks" && (
				<div className="stats-grid" style={{ marginBottom: 24 }}>
					<StatCard
						icon={<AppIcon name="folder" />}
						label="Total"
						value={stats.total}
						color="#e4e4e7"
					/>
					<StatCard
						icon={<AppIcon name="activity" />}
						label="Pendientes"
						value={stats.pending}
						color={STATUS_COLORS.pending}
					/>
					<StatCard
						icon={<AppIcon name="play" />}
						label="En ejecución"
						value={stats.running}
						color={STATUS_COLORS.running}
					/>
					<StatCard
						icon={<AppIcon name="check" />}
						label="Completadas"
						value={stats.completed}
						color={STATUS_COLORS.completed}
					/>
					<StatCard
						icon={<AppIcon name="warning" />}
						label="Fallidas"
						value={stats.failed}
						color={STATUS_COLORS.failed}
					/>
				</div>
			)}

			{pageTab === "kanban" && (
				<div className="ui-panel" style={{ marginBottom: 24 }}>
					<div className="ui-panel-header" style={{ marginBottom: 16 }}>
						<div>
							<h3 className="ui-section-title">
								Workflows durables de Octopus
							</h3>
							<p className="ui-section-subtitle">
								Runs multi-brazo con subtareas, reintentos, eventos y artefactos
								persistidos.
							</p>
						</div>
						<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
							<button
								type="button"
								onClick={loadWorkflows}
								className="ui-btn ui-btn--secondary"
								style={{ padding: "8px 14px", fontSize: "0.82rem" }}
							>
								Actualizar workflows
							</button>
							<button
								type="button"
								onClick={recoverWorkflows}
								disabled={workflowActioning === "recover"}
								className="ui-btn ui-btn--secondary"
								style={{
									padding: "8px 14px",
									fontSize: "0.82rem",
									opacity: workflowActioning === "recover" ? 0.6 : 1,
								}}
							>
								{workflowActioning === "recover"
									? "Recuperando..."
									: "Recuperar runs"}
							</button>
						</div>
					</div>

					{workflows.length === 0 ? (
						<div className="ui-empty" style={{ padding: "40px 20px" }}>
							<div className="ui-empty-icon">
								<AppIcon name="automation" size={40} strokeWidth={1.6} />
							</div>
							<div className="ui-empty-title">
								Aún no hay workflows durables
							</div>
							<div className="ui-empty-desc">
								Se crearán automáticamente cuando Octopus active sus brazos para
								una tarea.
							</div>
						</div>
					) : (
						<div style={{ display: "grid", gap: 10 }}>
							{workflows.map((workflow) => {
								return (
									<button
										key={workflow.id}
										type="button"
										onClick={() => openWorkflow(workflow.id)}
										className="ui-list-item"
										style={{
											display: "block",
											width: "100%",
											textAlign: "left",
											cursor: "pointer",
											fontFamily: "inherit",
											border: "1px solid #27272a",
											background: "#0c0c0f",
										}}
									>
										<div
											style={{
												display: "flex",
												justifyContent: "space-between",
												gap: 12,
												flexWrap: "wrap",
												alignItems: "center",
											}}
										>
											<strong style={{ color: "#f4f4f5", fontSize: "0.92rem" }}>
												{workflow.goal}
											</strong>
											<span
												className={`ui-status ${workflowStatusClass(workflow.status)}`}
											>
												{workflow.status}
											</span>
										</div>
										<div
											className="ui-meta"
											style={{ marginTop: 10, flexWrap: "wrap" }}
										>
											<span>ID: {workflow.id}</span>
											{workflow.current_phase && (
												<>
													<span className="ui-meta-divider">·</span>
													<span>Fase: {workflow.current_phase}</span>
												</>
											)}
											<span className="ui-meta-divider">·</span>
											<span>
												Actualizado: {formatDate(workflow.updated_at)}
											</span>
										</div>
									</button>
								);
							})}
						</div>
					)}

					{selectedWorkflow && (
						<div
							style={{
								marginTop: 16,
								paddingTop: 16,
								borderTop: "1px solid #27272a",
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									gap: 12,
									marginBottom: 12,
									flexWrap: "wrap",
								}}
							>
								<strong style={{ color: "#f4f4f5" }}>
									Detalle del workflow
								</strong>
								<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
									<button
										type="button"
										onClick={() =>
											runWorkflowAction(selectedWorkflow.run.id, "retry")
										}
										disabled={
											workflowActioning === `retry:${selectedWorkflow.run.id}`
										}
										className="ui-btn ui-btn--secondary"
										style={{ padding: "8px 14px", fontSize: "0.82rem" }}
									>
										Reintentar
									</button>
									<button
										type="button"
										onClick={() =>
											runWorkflowAction(selectedWorkflow.run.id, "cancel")
										}
										disabled={
											workflowActioning === `cancel:${selectedWorkflow.run.id}`
										}
										className="ui-btn ui-btn--danger"
										style={{ padding: "8px 14px", fontSize: "0.82rem" }}
									>
										Cancelar
									</button>
									<button
										type="button"
										onClick={() => setSelectedWorkflow(null)}
										className="ui-btn ui-btn--ghost"
										style={{ padding: "8px 14px", fontSize: "0.82rem" }}
									>
										Cerrar
									</button>
								</div>
							</div>
							<div className="responsive-grid-2" style={{ gap: 12 }}>
								<div style={workflowPanelStyle}>
									<div style={workflowPanelTitleStyle}>Subtareas</div>
									{selectedWorkflow.tasks.length === 0 ? (
										<div style={mutedSmallStyle}>
											Sin subtareas registradas.
										</div>
									) : (
										selectedWorkflow.tasks.map((task) => {
											const metadata = parseMetadata(task.metadata);
											const agentName = metadataString(metadata, "agentName");
											const avatar = metadataString(metadata, "avatar");
											const color =
												metadataString(metadata, "color") ??
												workflowStatusColor(task.status);
											return (
												<div
													key={task.id}
													style={{
														...workflowItemStyle,
														borderColor: `${color}44`,
													}}
												>
													<div
														style={{
															display: "flex",
															justifyContent: "space-between",
															gap: 8,
														}}
													>
														<span
															style={{
																color: "#e4e4e7",
																display: "flex",
																alignItems: "center",
																gap: 8,
															}}
														>
															{avatar?.startsWith("/") ||
															avatar?.startsWith("http") ? (
																<img
																	src={avatar}
																	alt=""
																	style={{
																		width: 24,
																		height: 24,
																		borderRadius: 999,
																		objectFit: "cover",
																	}}
																/>
															) : avatar ? (
																<span>{avatar}</span>
															) : null}
															<span>{task.title}</span>
														</span>
														<span
															className={`ui-status ${workflowStatusClass(task.status)}`}
														>
															{task.status}
														</span>
													</div>
													<div style={mutedSmallStyle}>
														Brazo: {agentName ?? task.arm_key ?? "-"} ·
														Intentos: {task.attempt_count}/
														{task.max_stagnant_attempts} · Sin avance:{" "}
														{task.stagnant_attempt_count}
													</div>
												</div>
											);
										})
									)}
								</div>
								<div style={workflowPanelStyle}>
									<div style={workflowPanelTitleStyle}>Eventos recientes</div>
									{selectedWorkflow.events.slice(-8).map((event) => (
										<div key={event.id} style={workflowItemStyle}>
											<div style={{ color: "#e4e4e7", fontSize: "0.8rem" }}>
												{event.event_type}
											</div>
											<div style={mutedSmallStyle}>
												{event.message ?? "Sin mensaje"}
											</div>
										</div>
									))}
									{selectedWorkflow.artifacts.length > 0 && (
										<div style={{ marginTop: 12 }}>
											<div style={workflowPanelTitleStyle}>Artefactos</div>
											{selectedWorkflow.artifacts.map((artifact) => (
												<div key={artifact.id} style={workflowItemStyle}>
													<div style={{ color: "#e4e4e7", fontSize: "0.8rem" }}>
														{artifact.artifact_type}
													</div>
													<div style={mutedSmallStyle}>
														{artifact.url ??
															artifact.path ??
															artifact.description ??
															"Artefacto registrado"}
													</div>
												</div>
											))}
										</div>
									)}
								</div>
							</div>
						</div>
					)}
				</div>
			)}

			{pageTab === "tasks" && (
				<>
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
								Crear nueva tarea
							</h3>
							<div
								style={{ display: "flex", flexDirection: "column", gap: 14 }}
							>
								<div>
									<label
										htmlFor="task-new-title"
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
										Título *
									</label>
									<input
										id="task-new-title"
										name="title"
										type="text"
										value={newTitle}
										onChange={(e) => setNewTitle(e.target.value)}
										placeholder="Título de la tarea"
										style={inputStyle}
									/>
								</div>
								<div>
									<label
										htmlFor="task-new-description"
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
										Descripción
									</label>
									<textarea
										id="task-new-description"
										name="description"
										value={newDescription}
										onChange={(e) => setNewDescription(e.target.value)}
										placeholder="Descripción opcional"
										rows={3}
										style={{
											...inputStyle,
											resize: "vertical",
											fontFamily: "inherit",
										}}
									/>
								</div>
								<div className="responsive-grid-2" style={{ gap: 14 }}>
									<div>
										<label
											htmlFor="task-new-priority"
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
											Prioridad: {newPriority}
										</label>
										<input
											id="task-new-priority"
											name="priority"
											type="range"
											min={1}
											max={10}
											value={newPriority}
											onChange={(e) => setNewPriority(Number(e.target.value))}
											style={{ width: "100%", accentColor: "#6366f1" }}
										/>
										<div
											style={{
												display: "flex",
												justifyContent: "space-between",
												fontSize: "0.7rem",
												color: "#71717a",
											}}
										>
											<span>1 (baja)</span>
											<span>10 (crítica)</span>
										</div>
									</div>
									<div>
										<label
											htmlFor="task-new-agent"
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
											Asignar agente
										</label>
										<select
											id="task-new-agent"
											name="assignedAgentId"
											value={newAgentId}
											onChange={(e) => setNewAgentId(e.target.value)}
											style={selectStyle}
										>
											<option value="">Sin asignar</option>
											{agents.map((a) => (
												<option key={a.id} value={a.id}>
													{a.name || a.id}
												</option>
											))}
										</select>
									</div>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "flex-end",
										gap: 10,
									}}
								>
									<button
										type="button"
										onClick={() => setShowCreateForm(false)}
										style={cancelBtnStyle}
									>
										Cancelar
									</button>
									<button
										type="button"
										onClick={handleCreate}
										disabled={creating || !newTitle.trim()}
										style={{
											...primaryBtnStyle,
											opacity: creating || !newTitle.trim() ? 0.5 : 1,
											cursor:
												creating || !newTitle.trim()
													? "not-allowed"
													: "pointer",
										}}
									>
										{creating ? "Creando..." : "Crear tarea"}
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
								Editar tarea
							</h3>
							<div
								style={{ display: "flex", flexDirection: "column", gap: 14 }}
							>
								<div>
									<label
										htmlFor="task-edit-title"
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
										Título
									</label>
									<input
										id="task-edit-title"
										name="title"
										type="text"
										value={editTitle}
										onChange={(e) => setEditTitle(e.target.value)}
										style={inputStyle}
									/>
								</div>
								<div>
									<label
										htmlFor="task-edit-description"
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
										Descripción
									</label>
									<textarea
										id="task-edit-description"
										name="description"
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
								<div className="responsive-grid-2" style={{ gap: 14 }}>
									<div>
										<label
											htmlFor="task-edit-status"
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
											Estado
										</label>
										<select
											id="task-edit-status"
											name="status"
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
											htmlFor="task-edit-agent"
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
											Asignar agente
										</label>
										<select
											id="task-edit-agent"
											name="assignedAgentId"
											value={editAgentId}
											onChange={(e) => setEditAgentId(e.target.value)}
											style={selectStyle}
										>
											<option value="">Sin asignar</option>
											{agents.map((a) => (
												<option key={a.id} value={a.id}>
													{a.name || a.id}
												</option>
											))}
										</select>
									</div>
								</div>
								<div
									style={{
										display: "flex",
										justifyContent: "flex-end",
										gap: 10,
									}}
								>
									<button
										type="button"
										onClick={() => setEditingTask(null)}
										style={cancelBtnStyle}
									>
										Cancelar
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
										{saving ? "Guardando..." : "Guardar cambios"}
									</button>
								</div>
							</div>
						</div>
					)}

					<div
						className="ui-tabs"
						style={{ marginBottom: 20, flexWrap: "wrap" }}
					>
						{STATUS_OPTIONS.map((s) => {
							const isActive = activeFilter === s;
							return (
								<button
									key={s}
									type="button"
									onClick={() => setActiveFilter(s)}
									className={`ui-tab${isActive ? " is-active" : ""}`}
								>
									{FILTER_LABELS[s] ?? STATUS_LABELS[s] ?? s}
									{s === "all" && stats.total > 0 && (
										<span style={{ opacity: 0.6 }}>({stats.total})</span>
									)}
									{s !== "all" && stats[s as keyof TaskStats] > 0 && (
										<span style={{ opacity: 0.6 }}>
											({stats[s as keyof TaskStats]})
										</span>
									)}
								</button>
							);
						})}
					</div>

					{tasks.length === 0 ? (
						<div className="ui-empty">
							<div className="ui-empty-icon">
								<AppIcon name="folder" size={42} strokeWidth={1.6} />
							</div>
							<div className="ui-empty-title">No hay tareas</div>
							<div className="ui-empty-desc">
								{activeFilter !== "all" ? "Cambia el filtro o " : ""}
								crea una tarea para empezar.
							</div>
							<button
								type="button"
								onClick={() => setShowCreateForm(true)}
								className="ui-btn ui-btn--primary"
								style={{ marginTop: 18 }}
							>
								Crear tarea
							</button>
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
														className={`ui-status ${taskStatusClass(task.status)}`}
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
													className="ui-meta"
													style={{ gap: 10, flexWrap: "wrap" }}
												>
													{task.assigned_agent_id && (
														<span>
															Agente:{" "}
															<span style={{ color: "#d4d4d8" }}>
																{agents.find(
																	(a) => a.id === task.assigned_agent_id,
																)?.name ?? task.assigned_agent_id}
															</span>
														</span>
													)}
													{task.assigned_agent_id && (
														<span className="ui-meta-divider">·</span>
													)}
													<span>Creada: {formatDate(task.created_at)}</span>
													{task.started_at && (
														<>
															<span className="ui-meta-divider">·</span>
															<span>
																Iniciada: {formatDate(task.started_at)}
															</span>
														</>
													)}
													{task.completed_at && (
														<>
															<span className="ui-meta-divider">·</span>
															<span>
																Completada: {formatDate(task.completed_at)}
															</span>
														</>
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
															data-tooltip="Editar"
															aria-label={`Editar tarea ${task.title}`}
														>
															<AppIcon name="edit" size={15} />
														</button>
														<button
															type="button"
															onClick={() => setConfirmDeleteId(task.id)}
															style={actionBtnStyle}
															data-tooltip="Eliminar"
															aria-label={`Eliminar tarea ${task.title}`}
														>
															<AppIcon name="trash" size={15} />
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
															¿Eliminar?
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
															{isDeleting ? "..." : "Sí"}
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
				</>
			)}

			{pageTab === "scheduled" && (
				<div
					className="ui-panel"
					style={{ textAlign: "center", maxWidth: 640, margin: "0 auto" }}
				>
					<div className="ui-empty-icon" style={{ marginBottom: 16 }}>
						<AppIcon name="automation" size={40} strokeWidth={1.6} />
					</div>
					<div className="ui-section-title" style={{ fontSize: "1.15rem" }}>
						Tareas Programadas
					</div>
					<div
						className="ui-section-subtitle"
						style={{ margin: "8px auto 20px", maxWidth: 480 }}
					>
						Las tareas programadas te permiten definir acciones que se ejecutan
						automáticamente según un horario (cron), un evento o un webhook.
						Cada tarea puede ser asignada a un agente específico.
					</div>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
							gap: 12,
							maxWidth: 560,
							margin: "0 auto 24px",
						}}
					>
						{[
							{
								icon: "📅",
								title: "Cron",
								desc: "Ejecución periódica programada",
							},
							{
								icon: "🔗",
								title: "Evento",
								desc: "Se activa al ocurrir un evento",
							},
							{
								icon: "🌐",
								title: "Webhook",
								desc: "Responde a llamadas externas",
							},
						].map((item) => (
							<div
								key={item.title}
								style={{
									background: "#0c0c0f",
									border: "1px solid #27272a",
									borderRadius: 12,
									padding: "16px 12px",
									textAlign: "center",
								}}
							>
								<div style={{ fontSize: "1.6rem", marginBottom: 6 }}>
									{item.icon}
								</div>
								<div
									style={{
										color: "#f4f4f5",
										fontWeight: 700,
										fontSize: "0.85rem",
									}}
								>
									{item.title}
								</div>
								<div
									style={{
										color: "#a1a1aa",
										fontSize: "0.75rem",
										marginTop: 4,
									}}
								>
									{item.desc}
								</div>
							</div>
						))}
					</div>
					<button
						type="button"
						onClick={() => {
							try {
								localStorage.setItem("octopus-active-tab", "automations");
							} catch {
								// ignore storage errors
							}
							window.location.reload();
						}}
						className="ui-btn ui-btn--primary"
					>
						Ir a Automatizaciones
					</button>
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

function workflowStatusColor(status: string): string {
	return (
		{
			ready: "#38bdf8",
			triage: "#a78bfa",
			running: "#6366f1",
			waiting_dependency: "#f59e0b",
			blocked: "#fb7185",
			partial: "#f59e0b",
			done: "#10b981",
			failed: "#ef4444",
			timed_out: "#ef4444",
			cancelled: "#a1a1aa",
			archived: "#71717a",
		}[status] ?? "#a1a1aa"
	);
}

const StatCard: React.FC<{
	icon: React.ReactNode;
	label: string;
	value: number;
	color: string;
}> = ({ icon, label, value, color }) => (
	<div
		className="settings-summary-card"
		style={{ "--stat-accent": color } as React.CSSProperties}
	>
		<div className="settings-summary-label">
			<span
				style={{
					display: "inline-flex",
					verticalAlign: "-3px",
					marginRight: 6,
				}}
			>
				{icon}
			</span>
			{label}
		</div>
		<div className="settings-summary-value">{value}</div>
	</div>
);

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "10px 12px",
	borderRadius: 9,
	border: "1px solid #3f3f46",
	background: "#0c0c0f",
	color: "#f4f4f5",
	fontSize: "0.9rem",
	outline: "none",
	boxSizing: "border-box",
	transition: "border-color 0.18s ease",
};

const selectStyle: React.CSSProperties = {
	width: "100%",
	padding: "10px 12px",
	borderRadius: 9,
	border: "1px solid #3f3f46",
	background: "#0c0c0f",
	color: "#f4f4f5",
	fontSize: "0.9rem",
	outline: "none",
	boxSizing: "border-box",
	transition: "border-color 0.18s ease",
};

const primaryBtnStyle: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: 10,
	border: "1px solid rgba(99, 102, 241, 0.4)",
	background: "linear-gradient(180deg, #6366f1, #4f46e5)",
	color: "#fff",
	fontWeight: 700,
	fontSize: "0.9rem",
	cursor: "pointer",
	boxShadow: "0 6px 18px rgba(79, 70, 229, 0.28)",
};

const cancelBtnStyle: React.CSSProperties = {
	padding: "10px 20px",
	borderRadius: 10,
	border: "1px solid #3f3f46",
	background: "#18181b",
	color: "#d4d4d8",
	cursor: "pointer",
	fontWeight: 600,
	fontSize: "0.9rem",
};

const secondaryBtnStyle: React.CSSProperties = {
	padding: "8px 12px",
	borderRadius: 9,
	border: "1px solid #3f3f46",
	background: "#18181b",
	color: "#d4d4d8",
	cursor: "pointer",
	fontWeight: 700,
	fontSize: "0.82rem",
};

const workflowPanelStyle: React.CSSProperties = {
	background: "#0c0c0f",
	border: "1px solid #27272a",
	borderRadius: 12,
	padding: 14,
	minWidth: 0,
};

const workflowPanelTitleStyle: React.CSSProperties = {
	color: "#f4f4f5",
	fontSize: "0.78rem",
	fontWeight: 800,
	marginBottom: 10,
	textTransform: "uppercase",
	letterSpacing: "0.05em",
};

const workflowItemStyle: React.CSSProperties = {
	borderTop: "1px solid #1f1f23",
	padding: "12px 0",
};

const mutedSmallStyle: React.CSSProperties = {
	color: "#a1a1aa",
	fontSize: "0.76rem",
	lineHeight: 1.45,
	marginTop: 4,
};

const actionBtnStyle: React.CSSProperties = {
	width: 34,
	height: 34,
	borderRadius: 9,
	border: "1px solid #3f3f46",
	background: "transparent",
	cursor: "pointer",
	color: "#a1a1aa",
	fontSize: "0.9rem",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	transition: "all 0.18s ease",
};
