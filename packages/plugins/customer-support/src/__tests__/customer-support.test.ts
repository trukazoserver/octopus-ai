import { describe, expect, it } from "vitest";
import plugin from "../index.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCommand(name: string) {
	const cmd = plugin.commands?.find((c) => c.name === name);
	if (!cmd) throw new Error(`Command ${name} not found`);
	return cmd;
}

function extractTicketId(result: string): string {
	const match = String(result).match(/ID: (TK-[A-Z0-9]+)/);
	if (!match) throw new Error(`Could not extract ticket ID from: ${result}`);
	return match[1];
}

describe("customerSupportPlugin", () => {
	describe("/ticket-create", () => {
		it("should create a ticket and detect billing category", async () => {
			const cmd = getCommand("/ticket-create");
			const result = await cmd.execute(["urgent billing error"]);
			expect(String(result)).toContain("Ticket Created");
			expect(String(result)).toContain("billing");
			expect(String(result)).toContain("ID: TK-");
		});

		it("should detect technical category", async () => {
			const cmd = getCommand("/ticket-create");
			const result = await cmd.execute(["app crash on startup"]);
			expect(String(result)).toContain("technical");
		});

		it("should detect account category", async () => {
			const cmd = getCommand("/ticket-create");
			const result = await cmd.execute(["cannot login to my account"]);
			expect(String(result)).toContain("account");
		});

		it("should detect feature-request category", async () => {
			const cmd = getCommand("/ticket-create");
			const result = await cmd.execute(["feature request for dark mode"]);
			expect(String(result)).toContain("feature-request");
		});

		it("should default to general category", async () => {
			const cmd = getCommand("/ticket-create");
			const result = await cmd.execute(["general question about pricing"]);
			expect(String(result)).toContain("general");
		});

		it("should flag urgent tickets based on sentiment", async () => {
			const cmd = getCommand("/ticket-create");
			const result = await cmd.execute([
				"URGENT critical system is down and broken immediately",
			]);
			expect(String(result)).toContain("FLAGGED AS URGENT");
			expect(String(result)).toContain("critical");
		});

		it("should assign low priority for neutral text", async () => {
			const cmd = getCommand("/ticket-create");
			const result = await cmd.execute(["how do I change my settings"]);
			expect(String(result)).toContain("Priority: low");
		});

		it("should return usage when no subject provided", async () => {
			const cmd = getCommand("/ticket-create");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /ticket-create");
		});
	});

	describe("/ticket-list", () => {
		it("should list open tickets by default", async () => {
			const createCmd = getCommand("/ticket-create");
			await createCmd.execute(["list test ticket for billing"]);

			const cmd = getCommand("/ticket-list");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("TK-");
			expect(String(result)).toContain("list test ticket");
		});

		it("should filter by status using --status= open", async () => {
			const createCmd = getCommand("/ticket-create");
			const createResult = await createCmd.execute(["status filter ticket"]);
			const ticketId = extractTicketId(String(createResult));

			const closeCmd = getCommand("/ticket-close");
			await closeCmd.execute([ticketId]);

			const cmd = getCommand("/ticket-list");
			const result = await cmd.execute(["--status=open"]);
			expect(String(result)).not.toContain(ticketId);
		});

		it("should show closed tickets with --status=closed", async () => {
			const createCmd = getCommand("/ticket-create");
			const createResult = await createCmd.execute(["closed list ticket"]);
			const ticketId = extractTicketId(String(createResult));

			const closeCmd = getCommand("/ticket-close");
			await closeCmd.execute([ticketId]);

			const cmd = getCommand("/ticket-list");
			const result = await cmd.execute(["--status=closed"]);
			expect(String(result)).toContain(ticketId);
		});

		it("should show all tickets with --status=all", async () => {
			const createCmd = getCommand("/ticket-create");
			const result1 = await createCmd.execute(["allstatusticket1 unique xyz"]);
			await delay(2);
			const result2 = await createCmd.execute(["allstatusticket2 unique abc"]);
			const ticketId2 = extractTicketId(String(result2));

			const closeCmd = getCommand("/ticket-close");
			await closeCmd.execute([ticketId2]);

			const cmd = getCommand("/ticket-list");
			const result = await cmd.execute(["--status=all"]);
			expect(String(result)).toContain("allstatusticket1");
			expect(String(result)).toContain("allstatusticket2");
		});

		it("should handle filter when all tickets are shown", async () => {
			const cmd = getCommand("/ticket-list");
			const result = await cmd.execute(["--status=all"]);
			expect(String(result)).toMatch(/No all tickets found|TK-/);
		});

		it("should show priority icons", async () => {
			const createCmd = getCommand("/ticket-create");
			const createResult = await createCmd.execute([
				"urgent critical error emergency",
			]);
			const ticketId = extractTicketId(String(createResult));

			const cmd = getCommand("/ticket-list");
			const result = await cmd.execute(["--status=all"]);
			expect(String(result)).toContain("[!!!]");
		});
	});

	describe("/ticket-close", () => {
		it("should close an open ticket", async () => {
			const createCmd = getCommand("/ticket-create");
			const createResult = await createCmd.execute(["close test ticket"]);
			const ticketId = extractTicketId(String(createResult));

			const cmd = getCommand("/ticket-close");
			const result = await cmd.execute([ticketId]);
			expect(String(result)).toContain("closed");
			expect(String(result)).toContain("close test ticket");
		});

		it("should return error for unknown ticket ID", async () => {
			const cmd = getCommand("/ticket-close");
			const result = await cmd.execute(["TK-FAKEID"]);
			expect(String(result)).toContain("Ticket not found");
		});

		it("should return error when no ID provided", async () => {
			const cmd = getCommand("/ticket-close");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Ticket not found");
		});
	});

	describe("/sentiment", () => {
		it("should detect urgent sentiment", async () => {
			const cmd = getCommand("/sentiment");
			const result = await cmd.execute([
				"I have a critical problem and everything is broken",
			]);
			expect(String(result)).toContain("Sentiment Analysis");
			expect(String(result)).toContain("URGENT");
		});

		it("should detect concerned sentiment", async () => {
			const cmd = getCommand("/sentiment");
			const result = await cmd.execute([
				"there is a bug in the system and it keeps failing wrong output",
			]);
			expect(String(result)).toContain("Concerned");
		});

		it("should detect neutral sentiment", async () => {
			const cmd = getCommand("/sentiment");
			const result = await cmd.execute(["the system seems to have an issue"]);
			expect(String(result)).toContain("Neutral");
		});

		it("should detect positive sentiment", async () => {
			const cmd = getCommand("/sentiment");
			const result = await cmd.execute(["everything is great and wonderful"]);
			expect(String(result)).toContain("Positive");
		});

		it("should return usage when no text provided", async () => {
			const cmd = getCommand("/sentiment");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /sentiment");
		});

		it("should include sentiment score", async () => {
			const cmd = getCommand("/sentiment");
			const result = await cmd.execute(["urgent critical bug issue problem"]);
			expect(String(result)).toContain("Score:");
			expect(String(result)).toContain("/10");
		});
	});
});
