import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "./useApi.js";

export interface Channel {
	name: string;
	type: string;
	enabled: boolean;
	status:
		| "connecting"
		| "qr"
		| "connected"
		| "disconnected"
		| "logged_out"
		| "error"
		| "idle"
		| "unconfigured";
	config: Record<string, unknown>;
}

export function useChannels() {
	const [channels, setChannels] = useState<Channel[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data =
				await apiGet<
					Array<{
						name: string;
						type: string;
						enabled: boolean;
						status?: Channel["status"];
						connected?: boolean;
						config: Record<string, unknown>;
					}>
				>("/api/channels");
			const mapped: Channel[] = (Array.isArray(data) ? data : []).map((ch) => ({
				name: ch.name,
				type: ch.type,
				enabled: ch.enabled,
				status: ch.status ?? (ch.connected ? "connected" : "disconnected"),
				config: ch.config ?? {},
			}));
			setChannels(mapped);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error cargando canales");
			setChannels([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const toggleChannel = useCallback(
		async (name: string) => {
			try {
				await apiPost(`/api/channels/${name}/toggle`);
				await load();
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Error toggling canal";
				setError(message);
				throw new Error(message);
			}
		},
		[load],
	);

	const testChannel = useCallback(
		async (name: string): Promise<{ success: boolean; message: string }> => {
			if (name !== "telegram") {
				return {
					success: false,
					message:
						"La prueba automática solo está disponible para Telegram por ahora.",
				};
			}
			try {
				const result = await apiPost(`/api/channels/${name}/test`);
				if (result.success) {
					const bot = result.bot as
						| { first_name?: string; username?: string }
						| undefined;
					const botInfo = bot ? ` — @${bot.username ?? bot.first_name}` : "";
					return { success: true, message: `Conexión exitosa${botInfo}` };
				}
				return {
					success: false,
					message: (result.error as string) || "Error desconocido",
				};
			} catch (err) {
				return {
					success: false,
					message: err instanceof Error ? err.message : "Error en la prueba",
				};
			}
		},
		[],
	);

	const saveChannelConfig = useCallback(
		async (name: string, config: Record<string, unknown>) => {
			const result = await apiPut(`/api/channels/${name}/config`, config);
			await load();
			return result;
		},
		[load],
	);

	return {
		channels,
		loading,
		error,
		reload: load,
		toggleChannel,
		testChannel,
		saveChannelConfig,
	};
}
