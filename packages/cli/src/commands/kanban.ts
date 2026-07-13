import chalk from "chalk";
import { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

type OctopusSystem = Awaited<ReturnType<typeof bootstrap>>;

const accent = chalk.hex("#f59e0b");
const success = chalk.hex("#22c55e");
const info = chalk.hex("#3b82f6");
const warn = chalk.hex("#f59e0b");
const error_ = chalk.hex("#ef4444");
const muted = chalk.hex("#71717a");

function parseWorkerArmKeys(value: unknown): string[] | undefined {
	if (typeof value !== "string") return undefined;
	const workers = value
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	return workers.length > 0 ? workers : undefined;
}

function formatStatus(status: string): string {
	const colors: Record<string, typeof chalk> = {
		ready: info,
		running: accent,
		done: success,
		waiting_dependency: warn,
		blocked: error_,
		failed: error_,
		review: chalk.hex("#a855f7"),
		cancelled: muted,
	};
	const c = colors[status] ?? chalk.white;
	return c(status);
}

function formatBoard(
	tasks: Array<{
		id: string;
		title: string;
		status: string;
		arm_key?: string | null;
		priority: number;
		assigned_agent_id?: string | null;
	}>,
): string {
	const columns = new Map<string, typeof tasks>();
	for (const task of tasks) {
		const col = columns.get(task.status) ?? [];
		col.push(task);
		columns.set(task.status, col);
	}

	const statusOrder = [
		"ready",
		"running",
		"waiting_dependency",
		"review",
		"blocked",
		"done",
		"failed",
		"cancelled",
	];

	const lines: string[] = [];
	for (const status of statusOrder) {
		const col = columns.get(status);
		if (!col) continue;
		lines.push(`  ${formatStatus(status)} (${col.length})`);
		for (const task of col) {
			const arm = task.arm_key ? `[${task.arm_key}]` : "[unassigned]";
			const prio = `P${task.priority}`;
			lines.push(
				`    ${muted(prio.padEnd(3))} ${muted(arm.padEnd(18))} ${task.title.slice(0, 60)}`,
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}

export function createKanbanCommand(): Command {
	const cmd = new Command("kanban");
	cmd.description("Manage Kanban Swarm workflows");

	cmd
		.command("swarm")
		.description("Create and run a Kanban Swarm from a goal")
		.argument("<goal>", "Natural-language goal for the swarm")
		.option("--workers <workers>", "Comma-separated worker list")
		.option("--model <model>", "Model override for planning")
		.option("--dry-run", "Show the plan without executing")
		.option("--json", "Output raw JSON")
		.action(async (goal: string, options) => {
			console.log(info("\n🐙 Starting Kanban Swarm...\n"));
			const system = await bootstrap();
			try {
				const { kanbanPlanner, requirementResolver, kanbanDispatcher } = system;

				if (!kanbanPlanner) {
					console.error(error_("Kanban planner is not available."));
					process.exit(1);
				}

				const plan = await kanbanPlanner.planFromGoal({
					goal,
					model: typeof options.model === "string" ? options.model : undefined,
					workerArmKeys: parseWorkerArmKeys(options.workers),
				});

				if (options.dryRun) {
					console.log(
						info("\n📋 Dry Run — Plan generated (not executing):\n"),
					);
					console.log(`  Goal: ${accent(plan.plan.goal)}`);
					console.log(
						`  Reasoning: ${muted(plan.plan.reasoning ?? "—")}`,
					);
					console.log(`  Cards: ${plan.tasks.length}\n`);
					for (const task of plan.tasks) {
						const arm = task.arm_key ?? "unassigned";
						console.log(
							`  ${success("●")} ${task.title} ${muted(`[${arm}] P${task.priority}`)}`,
						);
						if (task.description) {
							console.log(muted(`    ${task.description.slice(0, 100)}`));
						}
					}
					console.log();
					return;
				}

				await requirementResolver?.evaluatePendingRequirements({
					runId: plan.run.id,
				});

				console.log(
					`  Run ID: ${muted(plan.run.id)} (${plan.tasks.length} cards)`,
				);
				console.log(`  Goal: ${accent(plan.plan.goal)}\n`);

				// Run dispatcher ticks until all tasks are terminal
				const maxTicks = 60;
				let tickCount = 0;
				let allDone = false;

				while (!allDone && tickCount < maxTicks) {
					const result = await kanbanDispatcher.tick();
					tickCount++;

					const snapshot = await system.workflowManager.getRunSnapshot(
						plan.run.id,
					);
					if (!snapshot.run) break;

					if (options.json) {
						console.log(
							JSON.stringify({
								tick: tickCount,
								result,
								metrics: snapshot.metrics,
							}),
						);
					} else {
						const metrics = snapshot.metrics;
						console.log(
							`  Tick ${tickCount}: claimed=${result.claimed} satisfied=${result.requirementsSatisfied} unlocked=${result.unlockedTasks} | ` +
								`done=${metrics.completedTasks}/${metrics.totalTasks}`,
						);
					}

					const activeTasks = snapshot.tasks.filter(
						(t) =>
							t.status === "ready" ||
							t.status === "running" ||
							t.status === "waiting_dependency",
					);

					if (
						activeTasks.length === 0 &&
						result.claimed === 0 &&
						result.unlockedTasks === 0
					) {
						allDone = true;
					} else {
						// Wait before next tick
						await new Promise((resolve) => setTimeout(resolve, 2000));
					}
				}

				const finalSnapshot = await system.workflowManager.getRunSnapshot(
					plan.run.id,
				);

				if (options.json) {
					console.log(JSON.stringify(finalSnapshot, null, 2));
				} else {
					console.log(
						info("\n📊 Final Board State:\n"),
					);
					console.log(formatBoard(finalSnapshot.tasks));
					console.log(
						`  Status: ${formatStatus(finalSnapshot.run?.status ?? "unknown")}`,
					);
					console.log(
						`  Completion: ${finalSnapshot.metrics.completedTasks}/${finalSnapshot.metrics.totalTasks} cards`,
					);
					console.log();
				}
			} finally {
				await system.shutdown();
			}
		});

	cmd
		.command("status")
		.description("Show Kanban dispatcher status")
		.option("--json", "Output raw JSON")
		.action(async (options) => {
			const system = await bootstrap();
			try {
				const status = system.kanbanDispatcher.getStatus();
				if (options.json) {
					console.log(JSON.stringify(status, null, 2));
				} else {
					console.log(info("\n🐙 Kanban Dispatcher Status:\n"));
					console.log(`  Enabled: ${status.enabled ? success("yes") : error_("no")}`);
					console.log(`  Ticking: ${status.ticking ? accent("yes") : "no"}`);
					console.log(`  Active tasks: ${status.activeCount}`);
					console.log(`  Available slots: ${status.availableSlots}`);
					console.log(
						`  Max concurrent: ${status.config.maxConcurrentTasks}`,
					);
					if (status.lastTickAt) {
						console.log(`  Last tick: ${muted(status.lastTickAt)}`);
					}
					console.log();
				}
			} finally {
				await system.shutdown();
			}
		});

	cmd
		.command("list")
		.description("List Kanban workflow runs")
		.option("--status <status>", "Filter by status")
		.option("--limit <n>", "Max runs to show", "10")
		.option("--json", "Output raw JSON")
		.action(async (options) => {
			const system = await bootstrap();
			try {
				const limit = Number.parseInt(options.limit, 10) || 10;
				const runs = await system.workflowManager.listRuns({
					status: options.status,
					limit,
				});
				if (options.json) {
					console.log(JSON.stringify(runs, null, 2));
				} else {
					console.log(info(`\n📋 Kanban Runs (${runs.length}):\n`));
					for (const run of runs) {
						console.log(
							`  ${formatStatus(run.status).padEnd(14)} ${muted(run.id)} ${run.goal.slice(0, 50)}`,
						);
					}
					console.log();
				}
			} finally {
				await system.shutdown();
			}
		});

	cmd
		.command("inspect")
		.description("Inspect a specific Kanban run")
		.argument("<runId>", "Run ID to inspect")
		.option("--json", "Output raw JSON")
		.action(async (runId: string, options) => {
			const system = await bootstrap();
			try {
				const snapshot = await system.workflowManager.getRunSnapshot(runId);
				if (!snapshot.run) {
					console.error(error_(`Run not found: ${runId}`));
					process.exit(1);
				}
				if (options.json) {
					console.log(JSON.stringify(snapshot, null, 2));
				} else {
					console.log(info(`\n🔍 Kanban Run: ${runId}\n`));
					console.log(`  Goal: ${accent(snapshot.run.goal)}`);
					console.log(`  Status: ${formatStatus(snapshot.run.status)}`);
					console.log(
						`  Created: ${muted(snapshot.run.created_at)}`,
					);
					console.log(
						`  Completion: ${snapshot.metrics.completedTasks}/${snapshot.metrics.totalTasks}`,
					);
					console.log(
						`  Pending reqs: ${snapshot.metrics.requirementsPending}`,
					);
					console.log(
						`  Active leases: ${snapshot.metrics.activeLeases}`,
					);
					console.log(
						`  Open blockers: ${snapshot.metrics.blockedOpen}`,
					);
					console.log(
						`  Artifacts: ${snapshot.metrics.verifiedArtifacts}/${snapshot.metrics.totalArtifacts} verified`,
					);
					console.log(info("\n  Board:\n"));
					console.log(formatBoard(snapshot.tasks));
				}
			} finally {
				await system.shutdown();
			}
		});

	return cmd;
}
