import type React from "react";
import { showToast } from "../ui/Toast.js";

interface WhatsAppConfigProps {
	enabled: boolean;
	config: Record<string, unknown>;
	onSave: (config: Record<string, unknown>) => void;
}

export const WhatsAppConfig: React.FC<WhatsAppConfigProps> = ({ enabled }) => {
	if (!enabled) return null;

	return (
		<div
			style={{
				padding: "12px 16px",
				borderRadius: "10px",
				background: "rgba(245, 158, 11, 0.05)",
				border: "1px solid rgba(245, 158, 11, 0.2)",
				fontSize: "0.8rem",
				color: "#a1a1aa",
			}}
		>
			WhatsApp requiere integración con la API de Meta Business.
			<div style={{ fontSize: "0.7rem", color: "#52525b", marginTop: "6px" }}>
				Configúralo en Meta Business Suite → WhatsApp → Configuración
			</div>
		</div>
	);
};
