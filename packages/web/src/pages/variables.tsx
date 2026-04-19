import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { showToast } from "../components/ui/Toast.js";
import { apiDelete, apiGet, apiPost } from "../hooks/useApi.js";

interface EnvVar {
	key: string;
	value: string;
	description?: string;
	createdAt?: string;
}

export const VariablesPage: React.FC = () => {
	const [vars, setVars] = useState<EnvVar[]>([]);
	const [loading, setLoading] = useState(true);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const [newDesc, setNewDesc] = useState("");
	const [saving, setSaving] = useState(false);
	const [showValue, setShowValue] = useState<Set<string>>(new Set());

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
		if (!newKey.trim() || !newValue.trim()) return;
		setSaving(true);
		try {
			await apiPost("/api/env", {
				key: newKey.trim(),
				value: newValue.trim(),
				description: newDesc.trim() || undefined,
			});
			showToast("success", `Variable ${newKey.trim()} guardada`);
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

	const handleDelete = async (key: string) => {
		try {
			await apiDelete(`/api/env/${encodeURIComponent(key)}`);
			showToast("success", `Variable ${key} eliminada`);
			await load();
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "Error al eliminar",
			);
		}
	};

	const toggleShow = (key: string) => {
		setShowValue((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
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
					<input
						id="env-new-key"
						name="key"
						type="text"
						value={newKey}
						onChange={(e) => setNewKey(e.target.value)}
						placeholder="Nombre (ej: OPENAI_API_KEY)"
						autoComplete="off"
						style={{
							flex: "1 1 200px",
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
					<input
						id="env-new-value"
						name="value"
						type="password"
						value={newValue}
						onChange={(e) => setNewValue(e.target.value)}
						placeholder="Valor"
						autoComplete="off"
						style={{
							flex: "2 1 300px",
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
				</div>
				<div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
					<input
						id="env-new-desc"
						name="description"
						type="text"
						value={newDesc}
						onChange={(e) => setNewDesc(e.target.value)}
						placeholder="Descripción (opcional)"
						autoComplete="off"
						style={{
							flex: 1,
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
					{Array.from({ length: 3 }).map((_, i) => (
						<div
							key={i}
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
					<div style={{ fontSize: "48px", marginBottom: "16px" }}>🔐</div>
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
					{vars.map((v) => (
						<div
							key={v.key}
							className="animate-fade-in"
							style={{
								display: "flex",
								alignItems: "center",
								gap: "16px",
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
							<div style={{ flex: 1, minWidth: 0 }}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: "8px",
										marginBottom: "4px",
									}}
								>
									<span
										style={{
											padding: "2px 8px",
											borderRadius: "6px",
											background: "rgba(99,102,241,0.1)",
											border: "1px solid rgba(99,102,241,0.2)",
											fontSize: "0.8rem",
											fontWeight: 600,
											color: "#818cf8",
											fontFamily:
												"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
										}}
									>
										{v.key}
									</span>
									{v.description && (
										<span style={{ fontSize: "0.75rem", color: "#71717a" }}>
											{v.description}
										</span>
									)}
								</div>
								<div
									style={{
										fontSize: "0.8rem",
										color: showValue.has(v.key) ? "#a1a1aa" : "#52525b",
										fontFamily:
											"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
									}}
								>
									{showValue.has(v.key) ? v.value : "••••••••••••••••"}
								</div>
							</div>
							<button
								type="button"
								onClick={() => toggleShow(v.key)}
								style={{
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
								}}
							>
								{showValue.has(v.key) ? "Ocultar" : "Mostrar"}
							</button>
							<button
								type="button"
								onClick={() => handleDelete(v.key)}
								style={{
									padding: "6px 12px",
									borderRadius: "8px",
									border: "1px solid rgba(239,68,68,0.3)",
									background: "rgba(239,68,68,0.1)",
									color: "#ef4444",
									fontSize: "0.75rem",
									cursor: "pointer",
									fontFamily: "inherit",
									transition: "all 0.15s",
									whiteSpace: "nowrap",
								}}
							>
								Eliminar
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
};
