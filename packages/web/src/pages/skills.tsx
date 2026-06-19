import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon, type AppIconName } from "../components/ui/AppIcon.js";
import { Loading } from "../components/ui/Loading.js";
import { Modal } from "../components/ui/Modal.js";
import {
	apiDelete,
	apiGet,
	apiPost,
	apiPut,
	apiPutJson,
} from "../hooks/useApi.js";

type TabId = "builtin" | "generated" | "create";

interface DbSkill {
	id?: string;
	name?: string;
	description?: string;
	content?: string;
	instructions?: string;
	domain?: string;
	version?: string;
	tags?: string[];
	successRate?: number;
	usageCount?: number;
	metrics?: {
		timesUsed?: number;
		successRate?: number;
		avgUserRating?: number;
		lastUsed?: string;
		improvementsCount?: number;
		createdAt?: string;
	};
	triggerConditions?: {
		keywords?: string[];
		domains?: string[];
	};
	recentUsage?: Array<{
		id: string;
		task: string;
		success: boolean;
		failureReason?: string;
		userFeedback?: string;
		successReason?: string;
		timestamp: string;
	}>;
}

interface SkillsData {
	enabled: boolean;
	autoCreate: boolean;
	autoImprove: boolean;
	effectiveAutoCreate?: boolean;
	learningAutoCreateSkills?: boolean;
	builtinSkills: string[];
	dbSkills: DbSkill[];
}

export const SkillsPage: React.FC = () => {
	const [skills, setSkills] = useState<SkillsData | null>(null);
	const [loading, setLoading] = useState(true);
	const [activeTab, setActiveTab] = useState<TabId>("builtin");
	const [msg, setMsg] = useState<string | null>(null);

	// Create form
	const [newName, setNewName] = useState("");
	const [newDesc, setNewDesc] = useState("");
	const [newContent, setNewContent] = useState("");
	const [newDomain, setNewDomain] = useState("general");
	const [creating, setCreating] = useState(false);

	// Edit modal
	const [editing, setEditing] = useState<DbSkill | null>(null);
	const [editContent, setEditContent] = useState("");
	const [editDesc, setEditDesc] = useState("");
	const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(
		null,
	);
	const [togglingSkillName, setTogglingSkillName] = useState<string | null>(
		null,
	);
	const [savingSkillConfigKey, setSavingSkillConfigKey] = useState<
		string | null
	>(null);

	const loadSkills = useCallback(async () => {
		setLoading(true);
		try {
			const s = await apiGet<SkillsData>("/api/skills");
			setSkills(s);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadSkills();
	}, [loadSkills]);

	const handleCreate = async () => {
		if (!newName.trim() || !newContent.trim()) return;
		setCreating(true);
		setMsg(null);
		try {
			await apiPost("/api/skills/create", {
				name: newName,
				description: newDesc,
				content: newContent,
				domain: newDomain,
			});
			setMsg(`✓ Habilidad '${newName}' creada`);
			setNewName("");
			setNewDesc("");
			setNewContent("");
			setNewDomain("general");
			loadSkills();
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setCreating(false);
		}
	};

	const handleDelete = async (name: string) => {
		if (!name) return;
		if (confirmDeleteName !== name) {
			setConfirmDeleteName(name);
			return;
		}
		try {
			await apiDelete(`/api/skills/${encodeURIComponent(name)}`);
			setMsg(`✓ Habilidad '${name}' eliminada`);
			setConfirmDeleteName(null);
			loadSkills();
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const openEdit = (skill: DbSkill) => {
		setEditing(skill);
		setEditContent(getSkillInstructions(skill));
		setEditDesc(skill.description ?? "");
	};

	const handleSaveEdit = async () => {
		if (!editing?.name) return;
		try {
			await apiPutJson(`/api/skills/${encodeURIComponent(editing.name)}`, {
				description: editDesc,
				content: editContent,
			});
			setMsg(`✓ Habilidad '${editing.name}' actualizada`);
			setEditing(null);
			loadSkills();
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const handleToggleSkill = async (skill: DbSkill) => {
		if (!skill.name) return;
		setTogglingSkillName(skill.name);
		try {
			const result = await apiPost(
				`/api/skills/${encodeURIComponent(skill.name)}/toggle`,
			);
			setMsg(
				`✓ Habilidad '${skill.name}' ${result.enabled === true ? "activada" : "desactivada"}`,
			);
			loadSkills();
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setTogglingSkillName(null);
		}
	};

	const handleSkillConfigToggle = async (
		key: "enabled" | "autoCreate" | "autoImprove",
	) => {
		if (!skills) return;
		const nextValue = !skills[key];
		setSavingSkillConfigKey(key);
		setSkills({ ...skills, [key]: nextValue });
		try {
			await apiPut(`/api/config/skills.${key}`, nextValue);
			setMsg(`✓ Configuración '${key}' actualizada`);
		} catch (e) {
			setSkills(skills);
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setSavingSkillConfigKey(null);
		}
	};

	const tabs: { id: TabId; label: string; icon: AppIconName }[] = [
		{ id: "builtin", label: "Incluidas", icon: "folder" },
		{ id: "generated", label: "Personalizadas", icon: "agent" },
		{ id: "create", label: "Crear Nueva", icon: "edit" },
	];

	useEffect(() => {
		if (!editing) return undefined;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setEditing(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [editing]);

	const S = {
		section: {
			padding: "16px",
			backgroundColor: "#18181b",
			borderRadius: "10px",
			border: "1px solid #27272a",
			marginBottom: "12px",
		} as React.CSSProperties,
		input: {
			width: "100%",
			padding: "8px 12px",
			borderRadius: "8px",
			border: "1px solid #27272a",
			backgroundColor: "#0f1117",
			color: "#e4e4e7",
			fontSize: "13px",
			outline: "none",
			boxSizing: "border-box" as const,
		},
		textarea: {
			width: "100%",
			minHeight: "180px",
			padding: "12px",
			borderRadius: "8px",
			border: "1px solid #27272a",
			backgroundColor: "#0f1117",
			color: "#e4e4e7",
			fontFamily: '"JetBrains Mono", monospace',
			fontSize: "13px",
			lineHeight: "1.5",
			resize: "vertical" as const,
			outline: "none",
			boxSizing: "border-box" as const,
		},
	};

	if (loading) return <Loading text="Cargando habilidades..." />;

	return (
		<div
			className="page-shell page-shell--xl"
			style={{ padding: "24px", overflowY: "auto", height: "100%" }}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "24px",
					flexWrap: "wrap",
					gap: "12px",
				}}
			>
				<div>
					<h2
						className="ui-page-title"
						style={{ display: "flex", alignItems: "center", gap: 10 }}
					>
						<AppIcon name="spark" size={24} /> Habilidades
					</h2>
					<p className="ui-page-subtitle" style={{ marginTop: 6 }}>
						{skills?.builtinSkills?.length ?? 0} incluidas ·{" "}
						{skills?.dbSkills?.length ?? 0} personalizadas
						{skills?.enabled ? " · Activas" : " · Desactivadas"}
					</p>
				</div>
				<div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => setActiveTab(t.id)}
							style={{
								padding: "7px 14px",
								borderRadius: "8px",
								border: "none",
								cursor: "pointer",
								fontSize: "13px",
								fontWeight: 500,
								backgroundColor: activeTab === t.id ? "#6366f1" : "#27272a",
								color: activeTab === t.id ? "#fff" : "#a1a1aa",
							}}
						>
							<span
								style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
							>
								<AppIcon name={t.icon} size={14} /> {t.label}
							</span>
						</button>
					))}
				</div>
			</div>

			{msg && (
				<div
					style={{
						padding: "10px 16px",
						borderRadius: 8,
						marginBottom: 12,
						fontSize: "0.85rem",
						background: msg.startsWith("✓")
							? "rgba(34,197,94,0.1)"
							: "rgba(239,68,68,0.1)",
						color: msg.startsWith("✓") ? "#22c55e" : "#ef4444",
					}}
				>
					{msg}
				</div>
			)}

			<div
				style={{
					...S.section,
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
					gap: 10,
				}}
			>
				<SkillConfigToggle
					label="Motor de habilidades"
					description="Permite cargar skills en el contexto del agente."
					checked={skills?.enabled ?? false}
					saving={savingSkillConfigKey === "enabled"}
					onClick={() => handleSkillConfigToggle("enabled")}
				/>
				<SkillConfigToggle
					label="Auto-crear"
					description="Crea nuevas habilidades tras patrones exitosos."
					checked={skills?.autoCreate ?? false}
					saving={savingSkillConfigKey === "autoCreate"}
					onClick={() => handleSkillConfigToggle("autoCreate")}
				/>
				<SkillConfigToggle
					label="Auto-mejorar"
					description="Refina habilidades con métricas y feedback."
					checked={skills?.autoImprove ?? false}
					saving={savingSkillConfigKey === "autoImprove"}
					onClick={() => handleSkillConfigToggle("autoImprove")}
				/>
			</div>

			{skills?.autoCreate && skills.effectiveAutoCreate === false && (
				<div
					style={{
						padding: "10px 14px",
						borderRadius: 8,
						marginBottom: 12,
						fontSize: "0.82rem",
						background: "rgba(245,158,11,0.1)",
						border: "1px solid rgba(245,158,11,0.2)",
						color: "#f59e0b",
					}}
				>
					Auto-crear está activado aquí, pero no está efectivo porque Learning o
					`learning.autoCreateSkills` está desactivado.
				</div>
			)}

			{/* Edit Modal */}
			<Modal
				open={Boolean(editing)}
				onClose={() => setEditing(null)}
				title={`Editar: ${editing?.name ?? "habilidad"}`}
				maxWidth="640px"
			>
				{editing && (
					<div>
						<label
							htmlFor="skill-edit-description"
							style={{
								display: "block",
								fontSize: "12px",
								color: "#71717a",
								marginBottom: "4px",
							}}
						>
							Descripción
						</label>
						<input
							id="skill-edit-description"
							name="description"
							type="text"
							value={editDesc}
							onChange={(e) => setEditDesc(e.target.value)}
							style={{ ...S.input, marginBottom: 12 }}
						/>
						<label
							htmlFor="skill-edit-content"
							style={{
								display: "block",
								fontSize: "12px",
								color: "#71717a",
								marginBottom: "4px",
							}}
						>
							Contenido / Instrucciones
						</label>
						<textarea
							id="skill-edit-content"
							name="content"
							value={editContent}
							onChange={(e) => setEditContent(e.target.value)}
							style={S.textarea}
						/>
						<div style={{ marginTop: 12, display: "flex", gap: 8 }}>
							<button
								type="button"
								onClick={handleSaveEdit}
								style={{
									padding: "10px 24px",
									borderRadius: 8,
									border: "none",
									backgroundColor: "#22c55e",
									color: "#fff",
									cursor: "pointer",
									fontWeight: 600,
									fontSize: "14px",
								}}
							>
								Guardar
							</button>
							<button
								type="button"
								onClick={() => setEditing(null)}
								style={{
									padding: "10px 24px",
									borderRadius: 8,
									border: "1px solid #27272a",
									backgroundColor: "transparent",
									color: "#a1a1aa",
									cursor: "pointer",
									fontSize: "14px",
								}}
							>
								Cancelar
							</button>
						</div>
					</div>
				)}
			</Modal>

			{activeTab === "builtin" && (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
						gap: 10,
					}}
				>
					{(skills?.builtinSkills ?? []).length === 0 && (
						<div
							style={{
								...S.section,
								textAlign: "center",
								color: "#71717a",
								gridColumn: "1 / -1",
							}}
						>
							No hay habilidades incluidas registradas.
						</div>
					)}
					{(skills?.builtinSkills ?? []).map((name) => (
						<div key={name} style={{ ...S.section, marginBottom: 0 }}>
							<div
								style={{
									fontWeight: 600,
									fontSize: "0.9rem",
									color: "#e0e0e0",
									marginBottom: 4,
									display: "flex",
									alignItems: "center",
									gap: 6,
								}}
							>
								<AppIcon name="folder" size={16} /> {name}
							</div>
							<div style={{ fontSize: "0.78rem", color: "#71717a" }}>
								{getSkillDesc(name)}
							</div>
						</div>
					))}
				</div>
			)}

			{activeTab === "generated" && (
				<div>
					{(skills?.dbSkills ?? []).length === 0 ? (
						<div
							style={{
								...S.section,
								textAlign: "center",
								color: "#a1a1aa",
								padding: "40px",
							}}
						>
							<div style={{ color: "#818cf8", marginBottom: 8 }}>
								<AppIcon name="spark" size={36} />
							</div>
							<div
								style={{ color: "#f4f4f5", fontWeight: 700, marginBottom: 6 }}
							>
								No hay habilidades personalizadas
							</div>
							Crea una habilidad manual o deja que el agente genere nuevas
							capacidades con el uso.
							<div>
								<button
									type="button"
									onClick={() => setActiveTab("create")}
									style={{
										marginTop: 16,
										padding: "8px 14px",
										borderRadius: 8,
										border: "none",
										background: "#6366f1",
										color: "#fff",
										cursor: "pointer",
										fontWeight: 700,
									}}
								>
									Crear habilidad
								</button>
							</div>
						</div>
					) : (
						(skills?.dbSkills ?? []).map((skill, i) => {
							const successRate = getSkillSuccessRate(skill);
							const usageCount = getSkillUsageCount(skill);
							const domains = getSkillDomains(skill);
							const tags = getSkillTags(skill);
							const enabled = isSkillEnabled(skill);
							const recentUsage = skill.recentUsage ?? [];
							return (
								<div
									key={skill.id ?? skill.name ?? `skill-${i}`}
									style={{
										...S.section,
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										gap: 12,
										flexWrap: "wrap",
									}}
								>
									<div style={{ flex: 1, minWidth: 200 }}>
										<div
											style={{
												fontWeight: 600,
												color: "#e0e0e0",
												display: "flex",
												alignItems: "center",
												gap: 6,
											}}
										>
											<AppIcon name="agent" size={16} />{" "}
											{skill.name ?? `Skill ${i + 1}`}
											{skill.version && (
												<span style={{ fontSize: "0.7rem", color: "#71717a" }}>
													v{skill.version}
												</span>
											)}
											<span
												style={{
													fontSize: "0.68rem",
													color: enabled ? "#22c55e" : "#f59e0b",
													background: enabled
														? "rgba(34,197,94,0.1)"
														: "rgba(245,158,11,0.1)",
													padding: "2px 6px",
													borderRadius: 999,
												}}
											>
												{enabled ? "Activa" : "Pausada"}
											</span>
										</div>
										<div
											style={{
												fontSize: "0.78rem",
												color: "#71717a",
												marginTop: 2,
											}}
										>
											{skill.description ?? ""}
										</div>
										{domains.length > 0 && (
											<div style={{ fontSize: "0.7rem", color: "#525252" }}>
												Dominios: {domains.join(", ")}
											</div>
										)}
										{tags.length > 0 && (
											<div
												style={{
													display: "flex",
													gap: 5,
													flexWrap: "wrap",
													marginTop: 8,
												}}
											>
												{tags.slice(0, 8).map((tag) => (
													<span
														key={tag}
														style={{
															fontSize: "0.68rem",
															color: "#a1a1aa",
															background: "#27272a",
															padding: "2px 6px",
															borderRadius: 999,
														}}
													>
														{tag}
													</span>
												))}
											</div>
										)}
										{recentUsage.length > 0 && (
											<div style={{ marginTop: 10 }}>
												<div style={{ fontSize: "0.7rem", color: "#71717a" }}>
													Últimos usos
												</div>
												<div
													style={{
														display: "flex",
														flexDirection: "column",
														gap: 5,
														marginTop: 5,
													}}
												>
													{recentUsage.slice(0, 3).map((usage) => (
														<div
															key={usage.id}
															style={{
																padding: "6px 8px",
																borderRadius: 7,
																background: "#0f1117",
																border: `1px solid ${usage.success ? "#22c55e33" : "#ef444433"}`,
																fontSize: "0.72rem",
																color: "#a1a1aa",
															}}
														>
															<span
																style={{
																	color: usage.success ? "#22c55e" : "#ef4444",
																}}
															>
																{usage.success ? "éxito" : "fallo"}
															</span>
															{" · "}
															{truncateText(usage.task, 90)}
															{usage.userFeedback
																? ` · rating ${usage.userFeedback}`
																: ""}
															{usage.successReason
																? ` · ${truncateText(usage.successReason, 80)}`
																: ""}
															{usage.failureReason
																? ` · ${truncateText(usage.failureReason, 80)}`
																: ""}
														</div>
													))}
												</div>
											</div>
										)}
									</div>
									<div
										style={{ display: "flex", gap: 6, alignItems: "center" }}
									>
										{usageCount !== undefined && (
											<span style={{ fontSize: "0.75rem", color: "#71717a" }}>
												{usageCount} usos
											</span>
										)}
										{successRate !== undefined && (
											<span
												style={{
													fontSize: "0.85rem",
													fontWeight: 600,
													color:
														successRate >= 0.7
															? "#22c55e"
															: successRate >= 0.4
																? "#f59e0b"
																: "#ef4444",
												}}
											>
												{Math.round(successRate * 100)}%
											</span>
										)}
										<button
											type="button"
											onClick={() => handleToggleSkill(skill)}
											disabled={togglingSkillName === skill.name}
											style={{
												padding: "5px 12px",
												borderRadius: 6,
												border: enabled
													? "1px solid #f59e0b44"
													: "1px solid #22c55e44",
												background: "transparent",
												color: enabled ? "#f59e0b" : "#22c55e",
												cursor:
													togglingSkillName === skill.name ? "wait" : "pointer",
												fontSize: "12px",
											}}
										>
											{enabled ? "Pausar" : "Activar"}
										</button>
										<button
											type="button"
											onClick={() => openEdit(skill)}
											style={{
												padding: "5px 12px",
												borderRadius: 6,
												border: "1px solid #6366f144",
												background: "transparent",
												color: "#6366f1",
												cursor: "pointer",
												fontSize: "12px",
											}}
										>
											Editar
										</button>
										<button
											type="button"
											onClick={() => handleDelete(skill.name ?? "")}
											style={{
												padding: "5px 12px",
												borderRadius: 6,
												border: "1px solid #ef444444",
												background: "transparent",
												color: "#ef4444",
												cursor: "pointer",
												fontSize: "12px",
											}}
										>
											{confirmDeleteName === skill.name
												? "Confirmar"
												: "Eliminar"}
										</button>
										{confirmDeleteName === skill.name && (
											<button
												type="button"
												onClick={() => setConfirmDeleteName(null)}
												style={{
													padding: "5px 12px",
													borderRadius: 6,
													border: "1px solid #27272a",
													background: "transparent",
													color: "#a1a1aa",
													cursor: "pointer",
													fontSize: "12px",
												}}
											>
												Cancelar
											</button>
										)}
									</div>
								</div>
							);
						})
					)}
				</div>
			)}

			{activeTab === "create" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 12px 0", fontSize: "16px" }}>
						Crear Nueva Habilidad
					</h3>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
							gap: "12px",
							marginBottom: "12px",
						}}
					>
						<div>
							<label
								htmlFor="skill-new-name"
								style={{
									display: "block",
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Nombre
							</label>
							<input
								id="skill-new-name"
								name="name"
								type="text"
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								placeholder="analisis-datos"
								style={S.input}
							/>
						</div>
						<div>
							<label
								htmlFor="skill-new-domain"
								style={{
									display: "block",
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Dominio
							</label>
							<input
								id="skill-new-domain"
								name="domain"
								type="text"
								value={newDomain}
								onChange={(e) => setNewDomain(e.target.value)}
								placeholder="general"
								style={S.input}
							/>
						</div>
					</div>
					<div style={{ marginBottom: "12px" }}>
						<label
							htmlFor="skill-new-description"
							style={{
								display: "block",
								fontSize: "12px",
								color: "#71717a",
								marginBottom: "4px",
							}}
						>
							Descripción
						</label>
						<input
							id="skill-new-description"
							name="description"
							type="text"
							value={newDesc}
							onChange={(e) => setNewDesc(e.target.value)}
							placeholder="Qué hace esta habilidad..."
							style={S.input}
						/>
					</div>
					<label
						htmlFor="skill-new-content"
						style={{
							display: "block",
							fontSize: "12px",
							color: "#71717a",
							marginBottom: "4px",
						}}
					>
						Instrucciones / Contenido
					</label>
					<textarea
						id="skill-new-content"
						name="content"
						value={newContent}
						onChange={(e) => setNewContent(e.target.value)}
						placeholder="Cuando el usuario pida análisis de datos, sigue estos pasos:&#10;1. Identifica la fuente de datos&#10;2. Aplica las transformaciones necesarias&#10;3. Presenta resultados con gráficos si es posible"
						style={S.textarea}
					/>
					<div style={{ marginTop: "12px" }}>
						<button
							type="button"
							onClick={handleCreate}
							disabled={creating || !newName.trim() || !newContent.trim()}
							style={{
								padding: "10px 24px",
								borderRadius: 8,
								border: "none",
								backgroundColor: creating ? "#3f3f46" : "#7c3aed",
								color: "#fff",
								cursor: creating ? "not-allowed" : "pointer",
								fontSize: "14px",
								fontWeight: 600,
							}}
						>
							{creating ? "Creando..." : "Crear Habilidad"}
						</button>
					</div>
				</div>
			)}
		</div>
	);
};

const SkillConfigToggle: React.FC<{
	label: string;
	description: string;
	checked: boolean;
	saving: boolean;
	onClick: () => void;
}> = ({ label, description, checked, saving, onClick }) => (
	<button
		type="button"
		onClick={onClick}
		disabled={saving}
		style={{
			padding: 12,
			borderRadius: 10,
			border: checked ? "1px solid #22c55e55" : "1px solid #27272a",
			background: checked ? "rgba(34,197,94,0.08)" : "#0f1117",
			color: "#e4e4e7",
			cursor: saving ? "wait" : "pointer",
			textAlign: "left",
		}}
	>
		<div
			style={{
				display: "flex",
				justifyContent: "space-between",
				gap: 8,
				alignItems: "center",
			}}
		>
			<span style={{ fontWeight: 700, fontSize: "0.85rem" }}>{label}</span>
			<span
				style={{
					fontSize: "0.7rem",
					color: checked ? "#22c55e" : "#71717a",
				}}
			>
				{saving ? "..." : checked ? "ON" : "OFF"}
			</span>
		</div>
		<div style={{ color: "#71717a", fontSize: "0.75rem", marginTop: 5 }}>
			{description}
		</div>
	</button>
);

function getSkillDesc(name: string): string {
	const descs: Record<string, string> = {
		"general-reasoning": "Razonamiento general y resolución de problemas",
		"code-generation": "Generación, revisión y refactorización de código",
		writing: "Escritura asistida: emails, documentos, creativa",
		research: "Investigación, búsqueda y síntesis de información",
	};
	return descs[name] ?? "Habilidad personalizada";
}

function getSkillInstructions(skill: DbSkill): string {
	return skill.instructions ?? skill.content ?? "";
}

function getSkillSuccessRate(skill: DbSkill): number | undefined {
	return skill.metrics?.successRate ?? skill.successRate;
}

function getSkillUsageCount(skill: DbSkill): number | undefined {
	return skill.metrics?.timesUsed ?? skill.usageCount;
}

function getSkillDomains(skill: DbSkill): string[] {
	return Array.from(
		new Set([
			...(skill.domain ? [skill.domain] : []),
			...(skill.triggerConditions?.domains ?? []),
		]),
	).filter(Boolean);
}

function getSkillTags(skill: DbSkill): string[] {
	return Array.from(
		new Set([
			...(skill.tags ?? []),
			...(skill.triggerConditions?.keywords ?? []),
		]),
	).filter((tag) => Boolean(tag) && tag !== "disabled");
}

function isSkillEnabled(skill: DbSkill): boolean {
	return !(skill.tags ?? []).includes("disabled");
}

function truncateText(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
