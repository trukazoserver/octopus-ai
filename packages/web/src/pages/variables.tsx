import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon } from "../components/ui/AppIcon.js";
import { showToast } from "../components/ui/Toast.js";
import { apiDelete, apiGet, apiPost } from "../hooks/useApi.js";

interface EnvVar {
	key: string;
	value: string;
	description?: string;
	is_secret?: number;
	createdAt?: string;
}

const VARIABLE_SKELETON_KEYS = [
	"env-skeleton-1",
	"env-skeleton-2",
	"env-skeleton-3",
];

export const VariablesPage: React.FC = () => {
	const [vars, setVars] = useState<EnvVar[]>([]);
	const [loading, setLoading] = useState(true);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const [newDesc, setNewDesc] = useState("");
	const [saving, setSaving] = useState(false);
	const [showValue, setShowValue] = useState<Set<string>>(new Set());
	const [revealingKey, setRevealingKey] = useState<string | null>(null);
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const [editDesc, setEditDesc] = useState("");
	const [editSecret, setEditSecret] = useState(true);
	const [savingEditKey, setSavingEditKey] = useState<string | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const data = await apiGet<EnvVar[]>("/api/env");
			setVars(Array.isArray(data) ? data : []);
		} catch {
			setVars([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const handleSave = async () => {
		const normalizedKey = newKey.trim().toUpperCase();
		if (!normalizedKey || !newValue.trim()) {
			showToast("error", "Nombre y valor son obligatorios");
			return;
		}
		if (!/^[A-Z0-9_]+$/.test(normalizedKey)) {
			showToast(
				"error",
				"Usa solo mayúsculas, números y guiones bajos en el nombre",
			);
			return;
		}
		if (vars.some((v) => v.key === normalizedKey)) {
			showToast("error", `La variable ${normalizedKey} ya existe`);
			return;
		}
		setSaving(true);
		try {
			await apiPost("/api/env", {
				key: normalizedKey,
				value: newValue,
				description: newDesc.trim() || undefined,
				isSecret: true,
			});
			showToast("success", `Variable ${normalizedKey} guardada`);
			setNewKey("");
			setNewValue("");
			setNewDesc("");
			await load();
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "Error al guardar",
			);
		} finally {
			setSaving(false);
		}
	};

	const revealValue = async (key: string): Promise<EnvVar | null> => {
		setRevealingKey(key);
		try {
			const revealed = await apiGet<EnvVar>(
				`/api/env/${encodeURIComponent(key)}`,
			);
			setVars((current) =>
				current.map((v) => (v.key === key ? { ...v, ...revealed } : v)),
			);
			setShowValue((prev) => new Set(prev).add(key));
			return revealed;
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "No se pudo revelar el secreto",
			);
			return null;
		} finally {
			setRevealingKey(null);
		}
	};

	const handleDelete = async (key: string) => {
		try {
			await apiDelete(`/api/env/${encodeURIComponent(key)}`);
			showToast("success", `Variable ${key} eliminada`);
			setDeleteConfirm(null);
			await load();
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "Error al eliminar",
			);
		}
	};

	const toggleShow = async (key: string) => {
		if (showValue.has(key)) {
			setShowValue((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
			return;
		}

		const revealed = await revealValue(key);
		if (revealed) {
			showToast("info", "El valor se ocultará automáticamente en 10 segundos");
			setTimeout(() => {
				setShowValue((current) => {
					const updated = new Set(current);
					updated.delete(key);
					return updated;
				});
			}, 10000);
		}
	};

	const startEdit = async (variable: EnvVar) => {
		const revealed = showValue.has(variable.key)
			? variable
			: await revealValue(variable.key);
		if (!revealed) return;
		setEditingKey(variable.key);
		setEditValue(revealed.value);
		setEditDesc(revealed.description ?? "");
		setEditSecret(revealed.is_secret !== 0);
	};

	const cancelEdit = () => {
		setEditingKey(null);
		setEditValue("");
		setEditDesc("");
		setEditSecret(true);
	};

	const handleUpdate = async (key: string) => {
		if (!editValue.length) {
			showToast("error", "El valor no puede quedar vacío");
			return;
		}
		setSavingEditKey(key);
		try {
			await apiPost("/api/env", {
				key,
				value: editValue,
				description: editDesc.trim() || undefined,
				isSecret: editSecret,
			});
			showToast("success", `Variable ${key} actualizada`);
			cancelEdit();
			await load();
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "Error al actualizar",
			);
		} finally {
			setSavingEditKey(null);
		}
	};

	return (
		<div className="page-shell">
			<div className="animate-fade-in" style={{ marginBottom: "28px" }}>
				<h1
					style={{
						fontSize: "1.6rem",
						fontWeight: 700,
						color: "#f4f4f5",
						margin: "0 0 6px",
						letterSpacing: "-0.02em",
					}}
				>
					Variables de Entorno
				</h1>
				<p style={{ fontSize: "0.95rem", color: "#a1a1aa", margin: 0 }}>
					Gestiona API keys y variables seguras para el agente. Los valores se
					almacenan encriptados.
				</p>
			</div>

			{/* Add new variable */}
			<div
				style={{
					padding: "20px",
					borderRadius: "16px",
					background: "rgba(24,24,27,0.6)",
					border: "1px solid #27272a",
					marginBottom: "24px",
				}}
			>
				<h3
					style={{
						fontSize: "0.95rem",
						fontWeight: 700,
						color: "#f4f4f5",
						margin: "0 0 16px",
					}}
				>
					Agregar Variable
				</h3>
				<div
					style={{
						display: "flex",
						gap: "10px",
						flexWrap: "wrap",
						marginBottom: "12px",
					}}
				>
					<label style={{ flex: "1 1 200px", minWidth: 0 }}>
						<span style={fieldLabelStyle}>Nombre</span>
						<input
							id="env-new-key"
							name="key"
							type="text"
							value={newKey}
							onChange={(e) => setNewKey(e.target.value.toUpperCase())}
							placeholder="OPENAI_API_KEY"
							autoComplete="off"
							style={{
								width: "100%",
								padding: "10px 14px",
								borderRadius: "10px",
								border: "1px solid #3f3f46",
								background: "#18181b",
								color: "#f4f4f5",
								fontSize: "0.85rem",
								outline: "none",
								fontFamily:
									"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
								boxSizing: "border-box",
								minWidth: 0,
							}}
							onFocus={(e) => {
								e.target.style.borderColor = "#6366f1";
							}}
							onBlur={(e) => {
								e.target.style.borderColor = "#3f3f46";
							}}
						/>
					</label>
					<label style={{ flex: "2 1 300px", minWidth: 0 }}>
						<span style={fieldLabelStyle}>Valor secreto</span>
						<input
							id="env-new-value"
							name="value"
							type="password"
							value={newValue}
							onChange={(e) => setNewValue(e.target.value)}
							placeholder="Valor"
							autoComplete="off"
							style={{
								width: "100%",
								padding: "10px 14px",
								borderRadius: "10px",
								border: "1px solid #3f3f46",
								background: "#18181b",
								color: "#f4f4f5",
								fontSize: "0.85rem",
								outline: "none",
								fontFamily:
									"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
								boxSizing: "border-box",
								minWidth: 0,
							}}
							onFocus={(e) => {
								e.target.style.borderColor = "#6366f1";
							}}
							onBlur={(e) => {
								e.target.style.borderColor = "#3f3f46";
							}}
						/>
					</label>
				</div>
				<div
					style={{
						display: "flex",
						gap: "10px",
						alignItems: "flex-end",
						flexWrap: "wrap",
					}}
				>
					<label style={{ flex: 1, minWidth: 220 }}>
						<span style={fieldLabelStyle}>Descripción opcional</span>
						<input
							id="env-new-desc"
							name="description"
							type="text"
							value={newDesc}
							onChange={(e) => setNewDesc(e.target.value)}
							placeholder="Descripción (opcional)"
							autoComplete="off"
							style={{
								width: "100%",
								padding: "8px 14px",
								borderRadius: "10px",
								border: "1px solid #3f3f46",
								background: "#18181b",
								color: "#f4f4f5",
								fontSize: "0.85rem",
								outline: "none",
								boxSizing: "border-box",
							}}
							onFocus={(e) => {
								e.target.style.borderColor = "#6366f1";
							}}
							onBlur={(e) => {
								e.target.style.borderColor = "#3f3f46";
							}}
						/>
					</label>
					<button
						type="button"
						onClick={handleSave}
						disabled={!newKey.trim() || !newValue.trim() || saving}
						style={{
							padding: "10px 24px",
							borderRadius: "10px",
							border: "none",
							background:
								!newKey.trim() || !newValue.trim() || saving
									? "#27272a"
									: "#6366f1",
							color:
								!newKey.trim() || !newValue.trim() || saving
									? "#52525b"
									: "#fff",
							fontSize: "0.85rem",
							fontWeight: 600,
							cursor:
								!newKey.trim() || !newValue.trim() || saving
									? "not-allowed"
									: "pointer",
							fontFamily: "inherit",
							transition: "all 0.15s",
							whiteSpace: "nowrap",
						}}
					>
						{saving ? "Guardando..." : "Guardar"}
					</button>
				</div>
			</div>

			{/* Variables list */}
			{loading ? (
				<div style={{ display: "grid", gap: "12px" }}>
					{VARIABLE_SKELETON_KEYS.map((key) => (
						<div
							key={key}
							className="skeleton"
							style={{ height: "72px", borderRadius: "12px" }}
						/>
					))}
				</div>
			) : vars.length === 0 ? (
				<div
					style={{
						textAlign: "center",
						padding: "48px 20px",
						color: "#52525b",
					}}
				>
					<div style={{ color: "#818cf8", marginBottom: "16px" }}>
						<AppIcon name="key" size={48} strokeWidth={1.5} />
					</div>
					<div
						style={{
							fontSize: "1rem",
							fontWeight: 600,
							color: "#71717a",
							marginBottom: "8px",
						}}
					>
						Sin variables configuradas
					</div>
					<div style={{ fontSize: "0.85rem" }}>
						Agrega API keys y variables de entorno para que el agente las use de
						forma segura
					</div>
				</div>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
					{vars.map((v) => {
						const editing = editingKey === v.key;
						return (
							<div
								key={v.key}
								className="animate-fade-in"
								style={{
									padding: "16px 20px",
									borderRadius: "12px",
									background: "rgba(24,24,27,0.6)",
									border: "1px solid #27272a",
									transition: "border-color 0.15s",
								}}
								onMouseEnter={(e) => {
									e.currentTarget.style.borderColor = "#3f3f46";
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.borderColor = "#27272a";
								}}
							>
								<div style={variableRowStyle}>
									<div style={{ flex: 1, minWidth: 0 }}>
										<div style={variableHeaderStyle}>
											<span style={variableKeyStyle}>{v.key}</span>
											{v.description && (
												<span style={{ fontSize: "0.75rem", color: "#71717a" }}>
													{v.description}
												</span>
											)}
										</div>
										<div
											style={{
												...variableValueStyle,
												color: showValue.has(v.key) ? "#a1a1aa" : "#52525b",
											}}
										>
											{showValue.has(v.key) ? v.value : "••••••••••••••••"}
										</div>
									</div>
									<div style={buttonGroupStyle}>
										<button
											type="button"
											onClick={() => void toggleShow(v.key)}
											disabled={revealingKey === v.key}
											style={secondaryButtonStyle}
										>
											{revealingKey === v.key
												? "Cargando..."
												: showValue.has(v.key)
													? "Ocultar"
													: "Mostrar"}
										</button>
										<button
											type="button"
											onClick={() => void startEdit(v)}
											disabled={revealingKey === v.key}
											style={secondaryButtonStyle}
										>
											Editar
										</button>
										<button
											type="button"
											onClick={() => {
												if (deleteConfirm === v.key) void handleDelete(v.key);
												else setDeleteConfirm(v.key);
											}}
											style={dangerButtonStyle}
										>
											{deleteConfirm === v.key ? "Confirmar" : "Eliminar"}
										</button>
										{deleteConfirm === v.key && (
											<button
												type="button"
												onClick={() => setDeleteConfirm(null)}
												style={secondaryButtonStyle}
											>
												Cancelar
											</button>
										)}
									</div>
								</div>

								{editing && (
									<div style={editPanelStyle}>
										<label>
											<span style={fieldLabelStyle}>Valor</span>
											<input
												type={editSecret ? "password" : "text"}
												value={editValue}
												onChange={(e) => setEditValue(e.target.value)}
												autoComplete="off"
												style={inputStyle}
											/>
										</label>
										<label>
											<span style={fieldLabelStyle}>Descripción</span>
											<input
												type="text"
												value={editDesc}
												onChange={(e) => setEditDesc(e.target.value)}
												placeholder="Descripción (opcional)"
												autoComplete="off"
												style={inputStyle}
											/>
										</label>
										<div style={editActionsStyle}>
											<label style={checkboxLabelStyle}>
												<input
													type="checkbox"
													checked={editSecret}
													onChange={(e) => setEditSecret(e.target.checked)}
												/>
												Guardar como secreto
											</label>
											<div style={buttonGroupStyle}>
												<button
													type="button"
													onClick={() => void handleUpdate(v.key)}
													disabled={savingEditKey === v.key}
													style={primaryButtonStyle}
												>
													{savingEditKey === v.key ? "Guardando..." : "Guardar"}
												</button>
												<button
													type="button"
													onClick={cancelEdit}
													style={secondaryButtonStyle}
												>
													Cancelar
												</button>
											</div>
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

const fieldLabelStyle: React.CSSProperties = {
	display: "block",
	fontSize: "0.72rem",
	fontWeight: 700,
	color: "#a1a1aa",
	letterSpacing: "0.04em",
	textTransform: "uppercase",
	marginBottom: "6px",
};

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "10px 14px",
	borderRadius: "10px",
	border: "1px solid #3f3f46",
	background: "#18181b",
	color: "#f4f4f5",
	fontSize: "0.85rem",
	outline: "none",
	fontFamily:
		"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
	boxSizing: "border-box",
	minWidth: 0,
};

const primaryButtonStyle: React.CSSProperties = {
	padding: "6px 12px",
	borderRadius: "8px",
	border: "1px solid #6366f1",
	background: "#6366f1",
	color: "#fff",
	fontSize: "0.75rem",
	cursor: "pointer",
	fontFamily: "inherit",
	transition: "all 0.15s",
	whiteSpace: "nowrap",
};

const secondaryButtonStyle: React.CSSProperties = {
	padding: "6px 12px",
	borderRadius: "8px",
	border: "1px solid #3f3f46",
	background: "#27272a",
	color: "#a1a1aa",
	fontSize: "0.75rem",
	cursor: "pointer",
	fontFamily: "inherit",
	transition: "all 0.15s",
	whiteSpace: "nowrap",
};

const dangerButtonStyle: React.CSSProperties = {
	...secondaryButtonStyle,
	border: "1px solid rgba(239,68,68,0.3)",
	background: "rgba(239,68,68,0.1)",
	color: "#ef4444",
};

const variableRowStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "16px",
	flexWrap: "wrap",
};

const variableHeaderStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "8px",
	marginBottom: "4px",
	flexWrap: "wrap",
};

const variableKeyStyle: React.CSSProperties = {
	padding: "2px 8px",
	borderRadius: "6px",
	background: "rgba(99,102,241,0.1)",
	border: "1px solid rgba(99,102,241,0.2)",
	fontSize: "0.8rem",
	fontWeight: 600,
	color: "#818cf8",
	fontFamily:
		"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

const variableValueStyle: React.CSSProperties = {
	fontSize: "0.8rem",
	fontFamily:
		"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
};

const buttonGroupStyle: React.CSSProperties = {
	display: "flex",
	gap: "8px",
	flexWrap: "wrap",
};

const editPanelStyle: React.CSSProperties = {
	marginTop: "14px",
	paddingTop: "14px",
	borderTop: "1px solid #27272a",
	display: "grid",
	gap: "10px",
};

const editActionsStyle: React.CSSProperties = {
	display: "flex",
	gap: "10px",
	alignItems: "center",
	justifyContent: "space-between",
	flexWrap: "wrap",
};

const checkboxLabelStyle: React.CSSProperties = {
	display: "inline-flex",
	gap: "8px",
	alignItems: "center",
	color: "#a1a1aa",
	fontSize: "0.82rem",
};
