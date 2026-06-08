import { useCallback, useEffect, useState } from "react";
import { apiGet } from "./useApi.js";

export interface DashboardStats {
	agents: number;
	arms: number;
	tools: number;
	mcp: number;
	tasks: number;
	runningTasks: number;
	workflows: number;
	runningWorkflows: number;
	conversations: number;
	memories: number;
	provider: string;
	thinking: string;
	channels: string[];
	status: "online" | "degraded";
}

interface AgentSummary {
	id: string;
	name?: string;
	role?: string;
	color?: string | null;
	is_builtin_arm?: number;
	arm_key?: string | null;
}

export interface WorkflowRunSummary {
	id: string;
	status: string;
	goal?: string;
	current_phase?: string | null;
	updated_at?: string;
}

export interface DashboardArmSummary {
	id: string;
	name: string;
	role: string;
	armKey: string | null;
	color: string | null;
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
	const [recentWorkflows, setRecentWorkflows] = useState<WorkflowRunSummary[]>([]);
	const [arms, setArms] = useState<DashboardArmSummary[]>([]);
	const [loading, setLoading] = useState(true);

	const loadStats = useCallback(async () => {
		try {
			const [agents, mcp, memoryRaw, convs, statusRaw, toolsRaw, taskStatsRaw, workflows] =
				await Promise.all([
					apiGet<AgentSummary[]>("/api/agents").catch(() => []),
					apiGet<unknown[]>("/api/mcp/servers").catch(() => []),
					apiGet<Record<string, unknown>>("/api/memory/stats").catch(
						() => ({}),
					),
					apiGet<unknown[]>("/api/conversations").catch(() => []),
					apiGet<Record<string, unknown>>("/api/status").catch(() => ({})),
					apiGet<unknown[]>("/api/tools").catch(() => []),
					apiGet<Record<string, number>>("/api/tasks/stats").catch(() => ({})),
					apiGet<WorkflowRunSummary[]>("/api/workflows?limit=8").catch(() => []),
				]);

			const memory = memoryRaw as {
				longTerm?: { maxItems?: number };
				shortTerm?: { count?: number };
			};
			const status = statusRaw as {
				provider?: string;
				thinking?: string;
				channels?: string[];
				ok?: boolean;
			};
			const taskStats = taskStatsRaw as {
				total?: number;
				running?: number;
			};

			setStats({
				agents: agents.length,
				arms: agents.filter((agent) => agent.is_builtin_arm === 1).length,
				tools: Array.isArray(toolsRaw)
					? toolsRaw.length
					: Array.isArray((toolsRaw as { items?: unknown[] }).items)
						? (toolsRaw as { items: unknown[] }).items.length
						: 0,
				mcp: mcp.length,
				tasks: taskStats.total ?? 0,
				runningTasks: taskStats.running ?? 0,
				workflows: workflows.length,
				runningWorkflows: workflows.filter((workflow) =>
					["ready", "running", "interrupted"].includes(workflow.status),
				).length,
				conversations: convs.length,
				memories: memory.shortTerm ? (memory.shortTerm.count ?? 0) : 0,
				provider: status.provider ?? "N/A",
				thinking: status.thinking ?? "none",
				channels: status.channels ?? [],
				status: status.ok === false ? "degraded" : "online",
			});
			setRecentWorkflows(workflows.slice(0, 6));
			setArms(
				agents
					.filter((agent) => agent.is_builtin_arm === 1)
					.map((agent) => ({
						id: agent.id,
						name: agent.name ?? agent.id,
						role: agent.role ?? "arm",
						armKey: agent.arm_key ?? null,
						color: agent.color ?? null,
					})),
			);

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
			if (items.length === 0) {
				items.push({
					id: "system-ready",
					type: "system",
					title: "Workspace listo",
					description:
						"Crea una conversación, agente o automatización para ver actividad real aquí.",
					timestamp: Date.now(),
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

	return { stats, activity, recentWorkflows, arms, loading, reload: loadStats };
}
