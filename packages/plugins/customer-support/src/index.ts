import type { Plugin } from "@octopus-ai/core";

interface Ticket {
	id: string;
	subject: string;
	priority: string;
	status: string;
	category: string;
	createdAt: string;
}

const tickets: Map<string, Ticket> = new Map();

function analyzeSentiment(text: string): { score: number; urgent: boolean } {
	const urgentWords = [
		"urgent",
		"critical",
		"broken",
		"down",
		"error",
		"cannot",
		"impossible",
		"emergency",
		"asap",
		"immediately",
	];
	const negativeWords = [
		"bug",
		"issue",
		"problem",
		"fail",
		"wrong",
		"bad",
		"slow",
		"crash",
		"missing",
	];
	const lower = text.toLowerCase();
	let score = 0;
	for (const word of urgentWords) {
		if (lower.includes(word)) score += 3;
	}
	for (const word of negativeWords) {
		if (lower.includes(word)) score += 1;
	}
	return { score, urgent: score >= 5 };
}

function categorize(subject: string): string {
	const lower = subject.toLowerCase();
	if (/billing|payment|charge|invoice|refund/.test(lower)) return "billing";
	if (/account|login|password|access|signup/.test(lower)) return "account";
	if (/bug|error|crash|broken|not working/.test(lower)) return "technical";
	if (/feature|request|suggestion|improvement/.test(lower))
		return "feature-request";
	if (/cancel|unsubscribe|delete/.test(lower)) return "cancellation";
	return "general";
}

function determinePriority(sentiment: {
	score: number;
	urgent: boolean;
}): string {
	if (sentiment.urgent) return "critical";
	if (sentiment.score >= 3) return "high";
	if (sentiment.score >= 1) return "medium";
	return "low";
}

const plugin: Plugin = {
	manifest: {
		name: "customer-support",
		version: "1.0.0",
		description: "Ticket triage, sentiment analysis, and auto-response tools",
		author: "OctopusTeam",
	},
	commands: [
		{
			name: "/ticket-create",
			description: "Create a support ticket. Usage: /ticket-create <subject>",
			execute: async (args: string[]) => {
				const subject = args.join(" ").trim();
				if (!subject) return "Usage: /ticket-create <subject>";

				const sentiment = analyzeSentiment(subject);
				const category = categorize(subject);
				const priority = determinePriority(sentiment);
				const id = `TK-${Date.now().toString(36).toUpperCase()}`;

				tickets.set(id, {
					id,
					subject,
					priority,
					status: "open",
					category,
					createdAt: new Date().toISOString(),
				});

				return `Ticket Created\n\nID: ${id}\nSubject: ${subject}\nCategory: ${category}\nPriority: ${priority}\nStatus: open\nSentiment Score: ${sentiment.score}/10${sentiment.urgent ? "\n\nFLAGGED AS URGENT" : ""}`;
			},
		},
		{
			name: "/ticket-list",
			description:
				"List support tickets. Usage: /ticket-list [--status open|closed|all]",
			execute: async (args: string[]) => {
				if (tickets.size === 0)
					return "No tickets. Use /ticket-create to add one.";

				const statusFilter =
					args.find((a) => a.startsWith("--status="))?.split("=")[1] ?? "open";
				let filtered = Array.from(tickets.values());
				if (statusFilter !== "all") {
					filtered = filtered.filter((t) => t.status === statusFilter);
				}

				if (filtered.length === 0) return `No ${statusFilter} tickets found.`;

				const priorityIcon = (p: string) =>
					p === "critical"
						? "[!!!]"
						: p === "high"
							? "[!!]"
							: p === "medium"
								? "[!]"
								: "[ ]";
				return filtered
					.map(
						(t) =>
							`${priorityIcon(t.priority)} ${t.id} [${t.status}][${t.category}]\n    ${t.subject}`,
					)
					.join("\n\n");
			},
		},
		{
			name: "/ticket-close",
			description: "Close a ticket. Usage: /ticket-close <ticket-id>",
			execute: async (args: string[]) => {
				const id = args[0];
				if (!id || !tickets.has(id)) return `Ticket not found: ${id}`;
				const ticket = tickets.get(id);
				if (ticket) ticket.status = "closed";
				return `Ticket ${id} closed: "${ticket?.subject}"`;
			},
		},
		{
			name: "/sentiment",
			description: "Analyze sentiment of text. Usage: /sentiment <text>",
			execute: async (args: string[]) => {
				const text = args.join(" ").trim();
				if (!text) return "Usage: /sentiment <text>";
				const result = analyzeSentiment(text);
				return `Sentiment Analysis\n\nScore: ${result.score}/10\nLevel: ${result.urgent ? "URGENT" : result.score >= 3 ? "Concerned" : result.score >= 1 ? "Neutral" : "Positive"}\nText: "${text.slice(0, 80)}"`;
			},
		},
	],
	onLoad: async () => {},
};

export default plugin;
