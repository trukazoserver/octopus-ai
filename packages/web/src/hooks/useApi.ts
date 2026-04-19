import { useCallback, useEffect, useState } from "react";

const API_BASE = `http://${window.location.hostname}:18789`;

export async function apiGet<T>(path: string): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`);
	if (!res.ok) throw new Error(`API error: ${res.status}`);
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
	if (!res.ok) {
		const err = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(err.error || res.statusText);
	}
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
	if (!res.ok) throw new Error(`API error: ${res.status}`);
	return res.json();
}

export async function apiDelete(
	path: string,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`API error: ${res.status}`);
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
	if (!res.ok) throw new Error(`API error: ${res.status}`);
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
