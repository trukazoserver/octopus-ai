import type React from "react";
import { useState } from "react";
import { showToast } from "../ui/Toast.js";

interface DiscordConfigProps {
	enabled: boolean;
	config: Record<string, unknown>;
	onSave: (config: Record<string, unknown>) => void;
}

export const DiscordConfig: React.FC<DiscordConfigProps> = ({
	enabled,
	config,
	onSave,
}) => {
	const [token, setToken] = useState((config.botToken as string) ?? "");
	const [saving, setSaving] = useState(false);

	const handleSave = () => {
		if (!token.trim()) return;
		setSaving(true);
		try {
			onSave({ botToken: token.trim() });
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
		<div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
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
					disabled={!enabled}
					autoComplete="off"
					style={{
						width: "100%",
						padding: "8px 12px",
						borderRadius: "8px",
						border: "1px solid #3f3f46",
						background: "#18181b",
						color: "#f4f4f5",
						fontSize: "0.85rem",
						outline: "none",
						fontFamily:
							"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
						boxSizing: "border-box",
						opacity: enabled ? 1 : 0.5,
						transition: "border-color 0.15s",
					}}
					onFocus={(e) => {
						e.target.style.borderColor = "#6366f1";
					}}
					onBlur={(e) => {
						e.target.style.borderColor = "#3f3f46";
					}}
				/>
				<div style={{ fontSize: "0.7rem", color: "#52525b", marginTop: "4px" }}>
					Obtenlo en Discord Developer Portal → Bot → Token
				</div>
			</div>
			<button
				type="button"
				onClick={handleSave}
				disabled={!token.trim() || saving || !enabled}
				style={{
					padding: "8px 16px",
					borderRadius: "8px",
					border: "none",
					background:
						!token.trim() || saving || !enabled ? "#27272a" : "#6366f1",
					color: !token.trim() || saving || !enabled ? "#52525b" : "#fff",
					fontSize: "0.8rem",
					fontWeight: 600,
					cursor:
						!token.trim() || saving || !enabled ? "not-allowed" : "pointer",
					fontFamily: "inherit",
					transition: "all 0.15s",
					alignSelf: "flex-start",
				}}
			>
				{saving ? "Guardando..." : "Guardar Token"}
			</button>
		</div>
	);
};
