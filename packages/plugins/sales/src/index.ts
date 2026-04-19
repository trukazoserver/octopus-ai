import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@octopus-ai/core";

interface Contact {
	id: string;
	name: string;
	email: string;
	company: string;
	phone: string;
	tags: string[];
	createdAt: string;
}

interface Deal {
	id: string;
	title: string;
	contactId: string;
	value: number;
	currency: string;
	stage: string;
	probability: number;
	notes: string;
	createdAt: string;
	updatedAt: string;
}

interface Activity {
	id: string;
	type: string;
	dealId: string;
	description: string;
	createdAt: string;
}

const STAGES = [
	"lead",
	"qualified",
	"proposal",
	"negotiation",
	"closed-won",
	"closed-lost",
];
const DATA_DIR = join(process.cwd(), ".sales-data");

const contacts: Map<string, Contact> = new Map();
const deals: Map<string, Deal> = new Map();
const activities: Map<string, Activity> = new Map();

async function ensureDir(): Promise<void> {
	try {
		await mkdir(DATA_DIR, { recursive: true });
	} catch {}
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function formatCurrency(value: number, currency = "USD"): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
		value,
	);
}

function getContactName(contactId: string): string {
	const c = contacts.get(contactId);
	return c ? c.name : "Unknown";
}

const plugin: Plugin = {
	manifest: {
		name: "sales",
		version: "1.0.0",
		description:
			"CRM tools: contact management, deal pipeline, activity tracking, and revenue forecasting",
		author: "OctopusTeam",
	},
	commands: [
		{
			name: "/contact-add",
			description:
				"Add a contact. Usage: /contact-add <name> --email <email> --company <company> [--phone <phone>] [--tags tag1,tag2]",
			execute: async (args: string[]) => {
				const name = args[0];
				if (!name)
					return "Usage: /contact-add <name> --email <email> --company <company>";

				const emailIdx = args.indexOf("--email");
				const companyIdx = args.indexOf("--company");
				const phoneIdx = args.indexOf("--phone");
				const tagsIdx = args.indexOf("--tags");

				const email = emailIdx !== -1 ? args[emailIdx + 1] : "";
				const company = companyIdx !== -1 ? args[companyIdx + 1] : "";
				const phone = phoneIdx !== -1 ? args[phoneIdx + 1] : "";
				const tags =
					tagsIdx !== -1 && args[tagsIdx + 1]
						? args[tagsIdx + 1].split(",").map((t) => t.trim())
						: [];

				if (!email) return "Email is required. Use --email <email>";

				for (const [, c] of contacts) {
					if (c.email === email)
						return `Contact with email "${email}" already exists: ${c.name} (${c.id})`;
				}

				const id = generateId("CTC");
				const contact: Contact = {
					id,
					name,
					email,
					company,
					phone,
					tags,
					createdAt: new Date().toISOString(),
				};
				contacts.set(id, contact);

				return `Contact Created\n\nID: ${id}\nName: ${name}\nEmail: ${email}\nCompany: ${company}${phone ? `\nPhone: ${phone}` : ""}${tags.length > 0 ? `\nTags: ${tags.join(", ")}` : ""}`;
			},
		},
		{
			name: "/contact-list",
			description:
				"List contacts. Usage: /contact-list [--company <company>] [--tag <tag>]",
			execute: async (args: string[]) => {
				if (contacts.size === 0)
					return "No contacts. Use /contact-add to create one.";

				let filtered = Array.from(contacts.values());
				const companyIdx = args.indexOf("--company");
				const tagIdx = args.indexOf("--tag");

				if (companyIdx !== -1 && args[companyIdx + 1]) {
					const company = args[companyIdx + 1].toLowerCase();
					filtered = filtered.filter((c) =>
						c.company.toLowerCase().includes(company),
					);
				}
				if (tagIdx !== -1 && args[tagIdx + 1]) {
					const tag = args[tagIdx + 1].toLowerCase();
					filtered = filtered.filter((c) =>
						c.tags.some((t) => t.toLowerCase().includes(tag)),
					);
				}

				if (filtered.length === 0) return "No contacts match the filters.";
				return filtered
					.map(
						(c) =>
							`${c.id} | ${c.name}\n  ${c.email} | ${c.company}${c.tags.length > 0 ? ` | [${c.tags.join(", ")}]` : ""}`,
					)
					.join("\n\n");
			},
		},
		{
			name: "/deal-add",
			description:
				"Add a deal. Usage: /deal-add <title> --contact <contact-id> --value <amount> [--stage lead|qualified|proposal|negotiation]",
			execute: async (args: string[]) => {
				const title = args[0];
				if (!title)
					return "Usage: /deal-add <title> --contact <contact-id> --value <amount> [--stage <stage>]";

				const contactIdx = args.indexOf("--contact");
				const valueIdx = args.indexOf("--value");
				const stageIdx = args.indexOf("--stage");

				const contactId = contactIdx !== -1 ? args[contactIdx + 1] : "";
				const rawValue = valueIdx !== -1 ? args[valueIdx + 1] : "0";
				const stage =
					stageIdx !== -1 && args[stageIdx + 1] ? args[stageIdx + 1] : "lead";

				if (!contactId)
					return "Contact ID is required. Use --contact <contact-id>. Use /contact-list to find IDs.";
				if (!contacts.has(contactId))
					return `Contact "${contactId}" not found. Use /contact-list to find IDs.`;
				if (!STAGES.includes(stage))
					return `Invalid stage "${stage}". Valid: ${STAGES.slice(0, 4).join(", ")}`;

				const value = Number(rawValue);
				if (Number.isNaN(value) || value < 0)
					return "Value must be a positive number.";

				const id = generateId("DL");
				const now = new Date().toISOString();
				const probability =
					stage === "lead"
						? 10
						: stage === "qualified"
							? 25
							: stage === "proposal"
								? 50
								: stage === "negotiation"
									? 75
									: 100;
				const deal: Deal = {
					id,
					title,
					contactId,
					value,
					currency: "USD",
					stage,
					probability,
					notes: "",
					createdAt: now,
					updatedAt: now,
				};
				deals.set(id, deal);

				return `Deal Created\n\nID: ${id}\nTitle: ${title}\nContact: ${getContactName(contactId)}\nValue: ${formatCurrency(value)}\nStage: ${stage}\nProbability: ${probability}%`;
			},
		},
		{
			name: "/deal-list",
			description:
				"List deals by pipeline stage. Usage: /deal-list [--stage <stage>] [--all]",
			execute: async (args: string[]) => {
				if (deals.size === 0) return "No deals. Use /deal-add to create one.";

				const showAll = args.includes("--all");
				const stageIdx = args.indexOf("--stage");
				let filtered = Array.from(deals.values());

				if (stageIdx !== -1 && args[stageIdx + 1]) {
					filtered = filtered.filter((d) => d.stage === args[stageIdx + 1]);
				} else if (!showAll) {
					filtered = filtered.filter((d) => !d.stage.startsWith("closed-"));
				}

				if (filtered.length === 0) return "No deals match the criteria.";

				if (showAll && stageIdx === -1) {
					const grouped = STAGES.reduce<Record<string, Deal[]>>((acc, s) => {
						acc[s] = filtered.filter((d) => d.stage === s);
						return acc;
					}, {});
					return STAGES.filter((s) => grouped[s].length > 0)
						.map((s) => {
							const stageDeals = grouped[s];
							const total = stageDeals.reduce((sum, d) => sum + d.value, 0);
							return `--- ${s.toUpperCase()} (${stageDeals.length} deals, ${formatCurrency(total)}) ---\n${stageDeals.map((d) => `  ${d.id} | ${d.title}\n    ${getContactName(d.contactId)} | ${formatCurrency(d.value)} | ${d.probability}%`).join("\n")}`;
						})
						.join("\n\n");
				}

				return filtered
					.map(
						(d) =>
							`${d.id} | ${d.title}\n  Contact: ${getContactName(d.contactId)}\n  Value: ${formatCurrency(d.value)} | Stage: ${d.stage} | Probability: ${d.probability}%`,
					)
					.join("\n\n");
			},
		},
		{
			name: "/deal-move",
			description:
				"Move a deal to a new stage. Usage: /deal-move <deal-id> <stage>",
			execute: async (args: string[]) => {
				const dealId = args[0];
				const newStage = args[1];
				if (!dealId || !newStage) return "Usage: /deal-move <deal-id> <stage>";
				const deal = deals.get(dealId);
				if (!deal)
					return `Deal "${dealId}" not found. Use /deal-list to find IDs.`;
				if (!STAGES.includes(newStage))
					return `Invalid stage "${newStage}". Valid: ${STAGES.join(", ")}`;

				const oldStage = deal.stage;
				deal.stage = newStage;
				deal.updatedAt = new Date().toISOString();
				deal.probability =
					newStage === "lead"
						? 10
						: newStage === "qualified"
							? 25
							: newStage === "proposal"
								? 50
								: newStage === "negotiation"
									? 75
									: newStage === "closed-won"
										? 100
										: 0;

				const activityId = generateId("ACT");
				activities.set(activityId, {
					id: activityId,
					type: "stage-change",
					dealId,
					description: `Moved from "${oldStage}" to "${newStage}"`,
					createdAt: new Date().toISOString(),
				});

				return `Deal Moved\n\n${deal.title} (${deal.id})\n${oldStage} -> ${newStage}\nNew probability: ${deal.probability}%`;
			},
		},
		{
			name: "/deal-note",
			description:
				"Add a note to a deal. Usage: /deal-note <deal-id> <note text>",
			execute: async (args: string[]) => {
				const dealId = args[0];
				const noteText = args.slice(1).join(" ").trim();
				if (!dealId || !noteText)
					return "Usage: /deal-note <deal-id> <note text>";
				const deal = deals.get(dealId);
				if (!deal) return `Deal "${dealId}" not found.`;

				const timestamp = new Date().toISOString();
				deal.notes += deal.notes
					? `\n[${timestamp}] ${noteText}`
					: `[${timestamp}] ${noteText}`;
				deal.updatedAt = timestamp;

				return `Note added to deal "${deal.title}" (${deal.id})`;
			},
		},
		{
			name: "/forecast",
			description:
				"Revenue forecast based on pipeline. Usage: /forecast [--weighted]",
			execute: async (args: string[]) => {
				if (deals.size === 0)
					return "No deals in pipeline. Use /deal-add to create one.";

				const weighted = args.includes("--weighted");
				const activeDeals = Array.from(deals.values()).filter(
					(d) => !d.stage.startsWith("closed-"),
				);

				if (activeDeals.length === 0) return "No active deals in pipeline.";

				const totalPipeline = activeDeals.reduce((sum, d) => sum + d.value, 0);
				const weightedPipeline = activeDeals.reduce(
					(sum, d) => sum + (d.value * d.probability) / 100,
					0,
				);

				const byStage = STAGES.filter((s) => !s.startsWith("closed-")).map(
					(stage) => {
						const stageDeals = activeDeals.filter((d) => d.stage === stage);
						const total = stageDeals.reduce((sum, d) => sum + d.value, 0);
						const weightedTotal = stageDeals.reduce(
							(sum, d) => sum + (d.value * d.probability) / 100,
							0,
						);
						return `${stage.padEnd(12)} | ${String(stageDeals.length).padStart(2)} deals | ${formatCurrency(total).padStart(12)}${weighted ? ` | Weighted: ${formatCurrency(weightedTotal)}` : ""}`;
					},
				);

				const wonDeals = Array.from(deals.values()).filter(
					(d) => d.stage === "closed-won",
				);
				const wonTotal = wonDeals.reduce((sum, d) => sum + d.value, 0);
				const lostDeals = Array.from(deals.values()).filter(
					(d) => d.stage === "closed-lost",
				);
				const lostTotal = lostDeals.reduce((sum, d) => sum + d.value, 0);

				return `Revenue Forecast\n\n${byStage.join("\n")}\n${"=".repeat(50)}\nTotal Pipeline: ${formatCurrency(totalPipeline)}${weighted ? `\nWeighted Pipeline: ${formatCurrency(weightedPipeline)}` : ""}\nClosed Won: ${formatCurrency(wonTotal)} (${wonDeals.length} deals)\nClosed Lost: ${formatCurrency(lostTotal)} (${lostDeals.length} deals)\nWin Rate: ${wonDeals.length + lostDeals.length > 0 ? ((wonDeals.length / (wonDeals.length + lostDeals.length)) * 100).toFixed(1) : "0"}%`;
			},
		},
		{
			name: "/pipeline",
			description: "Visual pipeline overview. Usage: /pipeline",
			execute: async () => {
				if (deals.size === 0) return "No deals. Use /deal-add to create one.";

				const lines: string[] = ["Sales Pipeline", ""];

				for (const stage of STAGES) {
					const stageDeals = Array.from(deals.values()).filter(
						(d) => d.stage === stage,
					);
					const total = stageDeals.reduce((sum, d) => sum + d.value, 0);
					const bar = "#".repeat(Math.min(Math.ceil(total / 1000), 30));
					lines.push(
						`${stage.padEnd(14)} [${bar.padEnd(30)}] ${stageDeals.length} deals | ${formatCurrency(total)}`,
					);
				}

				return lines.join("\n");
			},
		},
		{
			name: "/sales-export",
			description:
				"Export sales data as JSON. Usage: /sales-export [--file <filepath>]",
			execute: async (args: string[]) => {
				await ensureDir();
				const data = {
					contacts: Array.from(contacts.values()),
					deals: Array.from(deals.values()),
					activities: Array.from(activities.values()),
					exportedAt: new Date().toISOString(),
				};
				const json = JSON.stringify(data, null, 2);

				const fileIdx = args.indexOf("--file");
				if (fileIdx !== -1 && args[fileIdx + 1]) {
					const filePath = args[fileIdx + 1];
					const fullPath =
						filePath.includes(":") || filePath.startsWith("/")
							? filePath
							: join(DATA_DIR, filePath);
					await writeFile(fullPath, json, "utf-8");
					return `Sales data exported to ${fullPath} (${contacts.size} contacts, ${deals.size} deals)`;
				}

				return json.length > 3000
					? `${json.slice(0, 3000)}\n... truncated. Use --file <path> to save full export.`
					: json;
			},
		},
	],
	onLoad: async () => {
		await ensureDir();
	},
};

export default plugin;
