import { useCallback, useEffect, useState } from "react";
import { apiGet } from "./useApi.js";

export interface DashboardStats {
	agents: number;
	tools: number;
	mcp: number;
	conversations: number;
	memories: number;
	provider: string;
	thinking: string;
	channels: string[];
}

export interface ActivityItem {
	id: string;
	type: "message" | "task" | "skill" | "agent" | "system";
	title: string;
	description?: string;
	timestamp: number;
}

export function useDashboard() {
	const [stats, setStats] = useState<DashboardStats | null>(null);
	const [activity, setActivity] = useState<ActivityItem[]>([]);
	const [loading, setLoading] = useState(true);

	const loadStats = useCallback(async () => {
		try {
			const [agents, mcp, memoryRaw, convs, statusRaw] = await Promise.all([
				apiGet<unknown[]>("/api/agents").catch(() => []),
				apiGet<unknown[]>("/api/mcp/servers").catch(() => []),
				apiGet<Record<string, unknown>>("/api/memory/stats").catch(() => ({})),
				apiGet<unknown[]>("/api/conversations").catch(() => []),
				apiGet<Record<string, unknown>>("/api/status").catch(() => ({})),
			]);

			const memory = memoryRaw as {
				longTerm?: { maxItems?: number };
				shortTerm?: { count?: number };
			};
			const status = statusRaw as {
				provider?: string;
				thinking?: string;
				channels?: string[];
			};

			setStats({
				agents: agents.length,
				tools: 10 + mcp.length * 3,
				mcp: mcp.length,
				conversations: convs.length,
				memories: memory.shortTerm
					? (memory.shortTerm.count ?? 0)
					: (memory.longTerm?.maxItems ?? 0),
				provider: status.provider ?? "N/A",
				thinking: status.thinking ?? "none",
				channels: status.channels ?? [],
			});

			const items: ActivityItem[] = [];
			if (Array.isArray(convs)) {
				(
					convs as Array<{
						id: string;
						title?: string;
						updated_at?: string;
						createdAt?: number;
					}>
				)
					.slice(0, 8)
					.forEach((c, i) => {
						items.push({
							id: c.id,
							type: "message",
							title: c.title || "Sin título",
							timestamp:
								c.createdAt ??
								(c.updated_at
									? new Date(c.updated_at).getTime()
									: Date.now() - i * 60000),
						});
					});
			}
			if (Array.isArray(agents)) {
				(agents as Array<{ id: string; name: string; description?: string }>)
					.slice(0, 3)
					.forEach((a) => {
						items.push({
							id: a.id,
							type: "agent",
							title: a.name,
							description: a.description,
							timestamp: Date.now(),
						});
					});
			}
			items.sort((a, b) => b.timestamp - a.timestamp);
			setActivity(items);
		} catch {
			// silently fail
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadStats();
		const interval = setInterval(loadStats, 30000);
		return () => clearInterval(interval);
	}, [loadStats]);

	return { stats, activity, loading, reload: loadStats };
}
