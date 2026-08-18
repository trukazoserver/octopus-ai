import type React from "react";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { apiGet, apiPost } from "../../hooks/useApi.js";
import { showToast } from "../ui/Toast.js";

interface WhatsAppConfigProps {
	enabled: boolean;
	config: Record<string, unknown>;
	onSave: (config: Record<string, unknown>) => Promise<void>;
	onReload?: () => Promise<void>;
}

interface WhatsAppStatus {
	status: "connecting" | "qr" | "connected" | "disconnected" | "logged_out";
	connected: boolean;
	qr?: string;
}

export const WhatsAppConfig: React.FC<WhatsAppConfigProps> = ({
	enabled,
	config,
	onReload,
}) => {
	const [status, setStatus] = useState<WhatsAppStatus>({
		status: "disconnected",
		connected: false,
	});
	const [qrDataUrl, setQrDataUrl] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [pollEpoch, setPollEpoch] = useState(0);
	const pollGeneration = useRef(0);

	useEffect(() => {
		if (!enabled) {
			setStatus({ status: "disconnected", connected: false });
			setQrDataUrl(undefined);
			return;
		}
		let active = true;
		const currentPollEpoch = pollEpoch;
		const generation = ++pollGeneration.current;
		let timer: number | undefined;
		const refresh = async () => {
			try {
				const next = await apiGet<WhatsAppStatus>(
					"/api/channels/whatsapp/status",
				);
				const nextQrDataUrl =
					next.qr
						? await QRCode.toDataURL(next.qr, {
								width: 240,
								margin: 2,
								errorCorrectionLevel: "M",
							})
						: undefined;
				if (
					!active ||
					currentPollEpoch !== pollEpoch ||
					generation !== pollGeneration.current
				)
					return;
				setStatus(next);
				setQrDataUrl(nextQrDataUrl);
			} catch {
				if (active && generation === pollGeneration.current) {
					setStatus({ status: "disconnected", connected: false });
					setQrDataUrl(undefined);
				}
			} finally {
				if (active && generation === pollGeneration.current) {
					timer = window.setTimeout(() => void refresh(), 2000);
				}
			}
		};
		void refresh();
		return () => {
			active = false;
			pollGeneration.current++;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [enabled, pollEpoch]);

	const logout = async () => {
		pollGeneration.current++;
		setBusy(true);
		try {
			await apiPost("/api/channels/whatsapp/logout");
			setStatus({ status: "logged_out", connected: false });
			setQrDataUrl(undefined);
			await onReload?.();
			showToast("success", "Sesión de WhatsApp cerrada");
		} catch (error) {
			setPollEpoch((value) => value + 1);
			showToast(
				"error",
				error instanceof Error ? error.message : "No se pudo cerrar la sesión",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
			<div style={{ color: "#a1a1aa", fontSize: "0.78rem" }}>
				Estado:{" "}
				<strong style={{ color: status.connected ? "#4ade80" : "#f4f4f5" }}>
					{status.status}
				</strong>
			</div>
			{qrDataUrl && (
				<div
					style={{
						alignSelf: "flex-start",
						padding: "10px",
						borderRadius: "12px",
						background: "#fff",
					}}
				>
					<img
						src={qrDataUrl}
						alt="Código QR para vincular WhatsApp"
						width={240}
						height={240}
					/>
				</div>
			)}
			{enabled && status.status === "connecting" && (
				<div style={{ color: "#a1a1aa", fontSize: "0.75rem" }}>
					Iniciando sesión local de WhatsApp...
				</div>
			)}
			{enabled && status.status === "qr" && (
				<div style={{ color: "#a1a1aa", fontSize: "0.75rem" }}>
					Escanea el código desde WhatsApp, Dispositivos vinculados. El QR se
					genera y renderiza localmente.
				</div>
			)}
			<div style={{ color: "#71717a", fontSize: "0.7rem" }}>
				Credenciales locales:{" "}
				{String(config.authPath ?? "~/.octopus/channels/whatsapp")}
			</div>
			{enabled && (
				<button
					type="button"
					disabled={busy}
					onClick={() => void logout()}
					style={{
						alignSelf: "flex-start",
						padding: "8px 14px",
						borderRadius: "8px",
						border: "1px solid #7f1d1d",
						background: "#1c0b0b",
						color: "#fca5a5",
						cursor: busy ? "wait" : "pointer",
					}}
				>
					{busy ? "Cerrando..." : "Cerrar sesión y borrar credenciales"}
				</button>
			)}
		</div>
	);
};
