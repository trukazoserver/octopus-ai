import { useCallback, useEffect, useState } from "react";

const DEFAULT_API_PORT = "18789";
const viteEnv = (import.meta as unknown as { env?: Record<string, string> })
	.env;

function resolveApiBase(): string {
	const configured = viteEnv?.VITE_API_BASE_URL?.trim();
	if (configured) return configured.replace(/\/$/, "");

	const { protocol, hostname, port, origin } = window.location;
	if (port === DEFAULT_API_PORT || protocol === "https:") return origin;
	return `http://${hostname}:${DEFAULT_API_PORT}`;
}

export const API_BASE = resolveApiBase();

async function readApiError(res: Response): Promise<Error> {
	const body = await res.json().catch(() => ({ error: res.statusText }));
	const message =
		typeof body?.error === "string"
			? body.error
			: typeof body?.message === "string"
				? body.message
				: `API error: ${res.status}`;
	return new Error(message);
}

export async function apiGet<T>(path: string): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`);
	if (!res.ok) throw await readApiError(res);
	return res.json();
}

export async function apiPut(
	path: string,
	value: unknown,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ value }),
	});
	if (!res.ok) throw await readApiError(res);
	return res.json();
}

export async function apiPutJson(
	path: string,
	body: unknown,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw await readApiError(res);
	return res.json();
}

export async function apiPost(
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "POST",
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) throw await readApiError(res);
	return res.json();
}

export async function apiDelete(
	path: string,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "DELETE",
	});
	if (!res.ok) throw await readApiError(res);
	return res.json();
}

export async function apiPatch(
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "PATCH",
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) throw await readApiError(res);
	return res.json();
}

export function useApi<T>(path: string, defaultValue: T) {
	const [data, setData] = useState<T>(defaultValue);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await apiGet<T>(path);
			setData(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [path]);

	useEffect(() => {
		load();
	}, [load]);

	return { data, setData, loading, error, reload: load };
}
