import type React from "react";
import { useState } from "react";
import { showToast } from "../ui/Toast.js";

interface DiscordConfigProps {
	enabled: boolean;
	config: Record<string, unknown>;
	onSave: (config: Record<string, unknown>) => Promise<void>;
}

export const DiscordConfig: React.FC<DiscordConfigProps> = ({
	enabled,
	config,
	onSave,
}) => {
	const tokenConfigured = Boolean(config.botTokenConfigured);
	const tokenPreview = config.botTokenPreview as string | undefined;
	const [token, setToken] = useState("");
	const [saving, setSaving] = useState(false);

	const handleSave = async () => {
		if (!token.trim()) return;
		setSaving(true);
		try {
			await onSave({ botToken: token.trim() });
			showToast("success", "Token de Discord guardado");
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "Error al guardar",
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void handleSave();
			}}
			style={{ display: "flex", flexDirection: "column", gap: "12px" }}
		>
			<div>
				<label
					htmlFor="discord-bot-token"
					style={{
						display: "block",
						fontSize: "0.8rem",
						color: "#a1a1aa",
						marginBottom: "6px",
						fontWeight: 500,
					}}
				>
					Bot Token
				</label>
				<input
					id="discord-bot-token"
					name="botToken"
					type="password"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="MTk4NjIy..."
					autoComplete="off"
					style={{
						width: "100%",
						padding: "8px 12px",
						borderRadius: "8px",
						border: "1px solid #202020",
						background: "#000",
						color: "#f4f4f5",
						fontSize: "0.85rem",
						outline: "none",
						fontFamily:
							"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
						boxSizing: "border-box",
						opacity: 1,
						transition: "border-color 0.15s",
					}}
					onFocus={(e) => {
						e.target.style.borderColor = "#4a4a4a";
					}}
					onBlur={(e) => {
						e.target.style.borderColor = "#202020";
					}}
				/>
				<div style={{ fontSize: "0.7rem", color: "#52525b", marginTop: "4px" }}>
					{tokenConfigured
						? `Token configurado${tokenPreview ? ` (${tokenPreview})` : ""}. Escribe uno nuevo solo si quieres reemplazarlo.`
						: "Obtenlo en Discord Developer Portal → Bot → Token"}
				</div>
			</div>
			<button
				type="submit"
				disabled={!token.trim() || saving}
				style={{
					padding: "8px 16px",
					borderRadius: "8px",
					border: "1px solid #2a2a2a",
					background: !token.trim() || saving ? "#111" : "#f4f4f5",
					color: !token.trim() || saving ? "#52525b" : "#050505",
					fontSize: "0.8rem",
					fontWeight: 600,
					cursor: !token.trim() || saving ? "not-allowed" : "pointer",
					fontFamily: "inherit",
					transition: "all 0.15s",
					alignSelf: "flex-start",
				}}
			>
				{saving ? "Guardando..." : "Guardar Token"}
			</button>
		</form>
	);
};
