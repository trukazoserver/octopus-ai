import type React from "react";
import { useState } from "react";
import { showToast } from "../ui/Toast.js";

interface WhatsAppConfigProps {
	enabled: boolean;
	config: Record<string, unknown>;
	onSave: (config: Record<string, unknown>) => Promise<void>;
}

export const WhatsAppConfig: React.FC<WhatsAppConfigProps> = ({
	config,
	onSave,
}) => {
	const [phoneNumber, setPhoneNumber] = useState(
		(config.phoneNumber as string) ?? "",
	);
	const [saving, setSaving] = useState(false);

	const handleSave = async () => {
		if (!phoneNumber.trim()) return;
		setSaving(true);
		try {
			await onSave({ phoneNumber: phoneNumber.trim() });
			showToast("success", "Número de WhatsApp guardado");
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "Error al guardar WhatsApp",
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
					htmlFor="whatsapp-phone-number"
					style={{
						display: "block",
						fontSize: "0.8rem",
						color: "#a1a1aa",
						marginBottom: "6px",
						fontWeight: 500,
					}}
				>
					Número de teléfono
				</label>
				<input
					id="whatsapp-phone-number"
					name="phoneNumber"
					type="tel"
					value={phoneNumber}
					onChange={(e) => setPhoneNumber(e.target.value)}
					placeholder="+5215551234567"
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
					}}
				/>
				<div style={{ fontSize: "0.7rem", color: "#71717a", marginTop: "4px" }}>
					Completa el número en formato internacional. Las credenciales
					avanzadas de Meta Business se gestionan en Configuración.
				</div>
			</div>
			<button
				type="submit"
				disabled={!phoneNumber.trim() || saving}
				style={{
					padding: "8px 16px",
					borderRadius: "8px",
					border: "1px solid #2a2a2a",
					background: !phoneNumber.trim() || saving ? "#111" : "#f4f4f5",
					color: !phoneNumber.trim() || saving ? "#52525b" : "#050505",
					fontSize: "0.8rem",
					fontWeight: 600,
					cursor: !phoneNumber.trim() || saving ? "not-allowed" : "pointer",
					fontFamily: "inherit",
					alignSelf: "flex-start",
				}}
			>
				{saving ? "Guardando..." : "Guardar número"}
			</button>
		</form>
	);
};
