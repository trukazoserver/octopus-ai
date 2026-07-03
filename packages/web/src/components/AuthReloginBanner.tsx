import { useEffect, useRef, useState } from "react";
import { apiGet } from "../hooks/useApi.js";
import { showToast } from "./ui/Toast.js";

interface AuthStatusEntry {
	requiresRelogin?: boolean;
	reason?: string;
	at?: number;
}

interface StatusAuthShape {
	authStatus?: Record<string, AuthStatusEntry>;
}

/**
 * Global banner + toast that surfaces a Codex/ChatGPT auth failure
 * (refresh token revoked/expired) so the user re-logs in instead of seeing
 * silent agent failures. Polls /api/status (which now carries `authStatus`)
 * periodically; mounts once at the app root so the toast fires on any page.
 */
export function AuthReloginBanner() {
	const [entry, setEntry] = useState<AuthStatusEntry | null>(null);
	const announcedRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		const poll = async () => {
			try {
				const status = await apiGet<StatusAuthShape>("/api/status");
				if (cancelled) return;
				const openai = status?.authStatus?.openai;
				if (openai?.requiresRelogin) {
					setEntry(openai);
					if (!announcedRef.current) {
						announcedRef.current = true;
						showToast(
							"warning",
							"Tu sesión de ChatGPT/OpenAI caducó. Ve a Configuración → OpenAI para re-iniciar sesión.",
						);
					}
				} else {
					setEntry(null);
					announcedRef.current = false;
				}
			} catch {
				/* ignore — transient fetch errors must not spam */
			}
		};
		poll();
		const id = setInterval(poll, 60_000);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	if (!entry?.requiresRelogin) return null;

	return (
		<div
			role="alert"
			style={{
				position: "fixed",
				top: 12,
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: 1080,
				maxWidth: "min(640px, 92vw)",
				padding: "10px 16px",
				borderRadius: 8,
				background: "#3a2a0a",
				color: "#ffd87a",
				border: "1px solid #5a4410",
				boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
				fontSize: 13,
				display: "flex",
				gap: 10,
				alignItems: "center",
			}}
		>
			<span aria-hidden="true">⚠️</span>
			<span>
				{entry.reason ?? "Tu sesión de ChatGPT/OpenAI caducó."}{" "}
				<strong>Re-inicia sesión</strong> en Configuración → OpenAI para
				restaurar el agente.
			</span>
		</div>
	);
}
