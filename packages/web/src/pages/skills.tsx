import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPutJson } from "../hooks/useApi.js";

type TabId = "builtin" | "generated" | "create";

interface DbSkill {
	name?: string;
	description?: string;
	content?: string;
	domain?: string;
	successRate?: number;
	usageCount?: number;
}

interface SkillsData {
	enabled: boolean;
	autoCreate: boolean;
	autoImprove: boolean;
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
	const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);

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

	useEffect(() => { loadSkills(); }, [loadSkills]);

	const handleCreate = async () => {
		if (!newName.trim() || !newContent.trim()) return;
		setCreating(true); setMsg(null);
		try {
			await apiPost("/api/skills/create", {
				name: newName, description: newDesc, content: newContent, domain: newDomain,
			});
			setMsg(`✓ Habilidad '${newName}' creada`);
			setNewName(""); setNewDesc(""); setNewContent(""); setNewDomain("general");
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
		setEditContent(skill.content ?? "");
		setEditDesc(skill.description ?? "");
	};

	const handleSaveEdit = async () => {
		if (!editing?.name) return;
		try {
			await apiPutJson(`/api/skills/${encodeURIComponent(editing.name)}`, {
				description: editDesc, content: editContent,
			});
			setMsg(`✓ Habilidad '${editing.name}' actualizada`);
			setEditing(null);
			loadSkills();
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const tabs: { id: TabId; label: string; icon: string }[] = [
		{ id: "builtin", label: "Incluidas", icon: "📦" },
		{ id: "generated", label: "Personalizadas", icon: "🤖" },
		{ id: "create", label: "Crear Nueva", icon: "➕" },
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
		section: { padding: "16px", backgroundColor: "#18181b", borderRadius: "10px", border: "1px solid #27272a", marginBottom: "12px" } as React.CSSProperties,
		input: { width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #27272a", backgroundColor: "#0f1117", color: "#e4e4e7", fontSize: "13px", outline: "none", boxSizing: "border-box" as const },
		textarea: { width: "100%", minHeight: "180px", padding: "12px", borderRadius: "8px", border: "1px solid #27272a", backgroundColor: "#0f1117", color: "#e4e4e7", fontFamily: '"JetBrains Mono", monospace', fontSize: "13px", lineHeight: "1.5", resize: "vertical" as const, outline: "none", boxSizing: "border-box" as const },
	};

	if (loading) return <div style={{ padding: 40, color: "#666" }}>Cargando habilidades...</div>;

	return (
		<div className="page-shell page-shell--xl" style={{ padding: "24px", overflowY: "auto", height: "100%" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", flexWrap: "wrap", gap: "12px" }}>
				<div>
					<h2 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: 700 }}>⚡ Habilidades</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						{skills?.builtinSkills?.length ?? 0} incluidas · {skills?.dbSkills?.length ?? 0} personalizadas
						{skills?.enabled ? " · Activas" : " · Desactivadas"}
					</p>
				</div>
				<div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
					{tabs.map((t) => (
						<button key={t.id} type="button" onClick={() => setActiveTab(t.id)} style={{
							padding: "7px 14px", borderRadius: "8px", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 500,
							backgroundColor: activeTab === t.id ? "#3b82f6" : "#27272a",
							color: activeTab === t.id ? "#fff" : "#a1a1aa",
						}}>
							{t.icon} {t.label}
						</button>
					))}
				</div>
			</div>

			{msg && (
				<div style={{
					padding: "10px 16px", borderRadius: 8, marginBottom: 12, fontSize: "0.85rem",
					background: msg.startsWith("✓") ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
					color: msg.startsWith("✓") ? "#22c55e" : "#ef4444",
				}}>
					{msg}
				</div>
			)}

			{/* Edit Modal */}
			{editing && (
				<div role="dialog" aria-modal="true" aria-label={`Editar habilidad ${editing.name ?? ""}`} onClick={() => setEditing(null)} style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
					<div onClick={(e) => e.stopPropagation()} style={{ ...S.section, width: "90%", maxWidth: 600, maxHeight: "80vh", overflowY: "auto" }}>
						<h3 style={{ margin: "0 0 12px", fontSize: "16px" }}>✏️ Editar: {editing.name}</h3>
						<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Descripción</label>
						<input id="skill-edit-description" name="description" type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} style={{ ...S.input, marginBottom: 12 }} />
						<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Contenido / Instrucciones</label>
						<textarea id="skill-edit-content" name="content" value={editContent} onChange={(e) => setEditContent(e.target.value)} style={S.textarea} />
						<div style={{ marginTop: 12, display: "flex", gap: 8 }}>
							<button type="button" onClick={handleSaveEdit} style={{ padding: "10px 24px", borderRadius: 8, border: "none", backgroundColor: "#22c55e", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: "14px" }}>
								Guardar
							</button>
							<button type="button" onClick={() => setEditing(null)} style={{ padding: "10px 24px", borderRadius: 8, border: "1px solid #27272a", backgroundColor: "transparent", color: "#a1a1aa", cursor: "pointer", fontSize: "14px" }}>
								Cancelar
							</button>
						</div>
					</div>
				</div>
			)}

			{activeTab === "builtin" && (
				<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
					{(skills?.builtinSkills ?? []).length === 0 && (
						<div style={{ ...S.section, textAlign: "center", color: "#71717a", gridColumn: "1 / -1" }}>
							No hay habilidades incluidas registradas.
						</div>
					)}
					{(skills?.builtinSkills ?? []).map((name) => (
						<div key={name} style={{ ...S.section, marginBottom: 0 }}>
							<div style={{ fontWeight: 600, fontSize: "0.9rem", color: "#e0e0e0", marginBottom: 4 }}>📦 {name}</div>
							<div style={{ fontSize: "0.78rem", color: "#71717a" }}>{getSkillDesc(name)}</div>
						</div>
					))}
				</div>
			)}

			{activeTab === "generated" && (
				<div>
					{(skills?.dbSkills ?? []).length === 0 ? (
						<div style={{ ...S.section, textAlign: "center", color: "#a1a1aa", padding: "40px" }}>
							<div style={{ fontSize: "2rem", marginBottom: 8 }}>⚡</div>
							<div style={{ color: "#f4f4f5", fontWeight: 700, marginBottom: 6 }}>No hay habilidades personalizadas</div>
							Crea una habilidad manual o deja que el agente genere nuevas capacidades con el uso.
						</div>
					) : (
						(skills?.dbSkills ?? []).map((skill, i) => (
							<div key={skill.name ?? `skill-${i}`} style={{ ...S.section, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
								<div style={{ flex: 1, minWidth: 200 }}>
									<div style={{ fontWeight: 600, color: "#e0e0e0" }}>🤖 {skill.name ?? `Skill ${i + 1}`}</div>
									<div style={{ fontSize: "0.78rem", color: "#71717a", marginTop: 2 }}>{skill.description ?? ""}</div>
									{skill.domain && <span style={{ fontSize: "0.7rem", color: "#525252" }}>Dominio: {skill.domain}</span>}
								</div>
								<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
									{skill.successRate !== undefined && (
										<span style={{
											fontSize: "0.85rem", fontWeight: 600,
											color: skill.successRate >= 0.7 ? "#22c55e" : skill.successRate >= 0.4 ? "#f59e0b" : "#ef4444",
										}}>
											{Math.round(skill.successRate * 100)}%
										</span>
									)}
									<button type="button" onClick={() => openEdit(skill)} style={{
										padding: "5px 12px", borderRadius: 6, border: "1px solid #3b82f644", background: "transparent", color: "#3b82f6", cursor: "pointer", fontSize: "12px",
									}}>
										Editar
									</button>
									<button type="button" onClick={() => handleDelete(skill.name ?? "")} style={{
										padding: "5px 12px", borderRadius: 6, border: "1px solid #ef444444", background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: "12px",
									}}>
										{confirmDeleteName === skill.name ? "Confirmar" : "Eliminar"}
									</button>
									{confirmDeleteName === skill.name && (
										<button type="button" onClick={() => setConfirmDeleteName(null)} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid #27272a", background: "transparent", color: "#a1a1aa", cursor: "pointer", fontSize: "12px" }}>
											Cancelar
										</button>
									)}
								</div>
							</div>
						))
					)}
				</div>
			)}

			{activeTab === "create" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 12px 0", fontSize: "16px" }}>Crear Nueva Habilidad</h3>
					<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginBottom: "12px" }}>
						<div>
							<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Nombre</label>
							<input id="skill-new-name" name="name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="analisis-datos" style={S.input} />
						</div>
						<div>
							<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Dominio</label>
							<input id="skill-new-domain" name="domain" type="text" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="general" style={S.input} />
						</div>
					</div>
					<div style={{ marginBottom: "12px" }}>
						<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Descripción</label>
						<input id="skill-new-description" name="description" type="text" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Qué hace esta habilidad..." style={S.input} />
					</div>
					<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Instrucciones / Contenido</label>
					<textarea id="skill-new-content" name="content" value={newContent} onChange={(e) => setNewContent(e.target.value)}
						placeholder="Cuando el usuario pida análisis de datos, sigue estos pasos:&#10;1. Identifica la fuente de datos&#10;2. Aplica las transformaciones necesarias&#10;3. Presenta resultados con gráficos si es posible"
						style={S.textarea} />
					<div style={{ marginTop: "12px" }}>
						<button type="button" onClick={handleCreate} disabled={creating || !newName.trim() || !newContent.trim()} style={{
							padding: "10px 24px", borderRadius: 8, border: "none",
							backgroundColor: creating ? "#3f3f46" : "#7c3aed", color: "#fff",
							cursor: creating ? "not-allowed" : "pointer", fontSize: "14px", fontWeight: 600,
						}}>
							{creating ? "Creando..." : "Crear Habilidad"}
						</button>
					</div>
				</div>
			)}
		</div>
	);
};

function getSkillDesc(name: string): string {
	const descs: Record<string, string> = {
		"general-reasoning": "Razonamiento general y resolución de problemas",
		"code-generation": "Generación, revisión y refactorización de código",
		writing: "Escritura asistida: emails, documentos, creativa",
		research: "Investigación, búsqueda y síntesis de información",
	};
	return descs[name] ?? "Habilidad personalizada";
}
