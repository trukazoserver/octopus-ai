import type { Plugin } from "@octopus-ai/core";

const tasks: Map<
	string,
	{ title: string; status: string; priority: string; createdAt: string }
> = new Map();

const plugin: Plugin = {
	manifest: {
		name: "productivity",
		version: "1.0.0",
		description: "Task management, note-taking, and productivity workflows",
		author: "OctopusTeam",
	},
	commands: [
		{
			name: "/task-add",
			description:
				"Add a new task. Usage: /task-add <title> [--priority low|medium|high]",
			execute: async (args: string[]) => {
				const input = args.join(" ");
				if (!input.trim())
					return "Usage: /task-add <title> [--priority low|medium|high]";

				let priority = "medium";
				let title = input;
				const priorityMatch = input.match(/--priority\s+(low|medium|high)/i);
				if (priorityMatch) {
					priority = priorityMatch[1].toLowerCase();
					title = input.replace(/--priority\s+(low|medium|high)/i, "").trim();
				}

				if (!title) return "Please provide a task title.";

				const id = `task_${Date.now()}`;
				tasks.set(id, {
					title,
					status: "pending",
					priority,
					createdAt: new Date().toISOString(),
				});

				return `Task added!\nID: ${id}\nTitle: ${title}\nPriority: ${priority}`;
			},
		},
		{
			name: "/task-list",
			description: "List all tasks. Usage: /task-list",
			execute: async () => {
				if (tasks.size === 0) return "No tasks. Use /task-add to create one.";
				const items = Array.from(tasks.entries());
				return items
					.map(([id, t]) => {
						const icon =
							t.priority === "high"
								? "[H]"
								: t.priority === "medium"
									? "[M]"
									: "[L]";
						const status = t.status === "done" ? "DONE" : "TODO";
						return `${icon} [${status}] ${t.title}\n    ID: ${id}`;
					})
					.join("\n\n");
			},
		},
		{
			name: "/task-done",
			description: "Mark task done. Usage: /task-done <task-id>",
			execute: async (args: string[]) => {
				const id = args[0];
				if (!id || !tasks.has(id)) return "Task not found. Use /task-list.";
				const task = tasks.get(id);
				if (task) task.status = "done";
				return `Done: ${task?.title}`;
			},
		},
		{
			name: "/note",
			description: "Save a quick note. Usage: /note <text>",
			execute: async (args: string[]) => {
				const text = args.join(" ").trim();
				if (!text) return "Usage: /note <text>";
				const id = `note_${Date.now()}`;
				tasks.set(id, {
					title: text.slice(0, 100),
					status: "note",
					priority: "none",
					createdAt: new Date().toISOString(),
				});
				return `Note saved: "${text.slice(0, 100)}"`;
			},
		},
	],
	onLoad: async () => {},
};

export default plugin;
