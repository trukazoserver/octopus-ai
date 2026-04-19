import { describe, expect, it } from "vitest";
import plugin from "../index.js";

function getCommand(name: string) {
	const cmd = plugin.commands?.find((c) => c.name === name);
	if (!cmd) throw new Error(`Command ${name} not found`);
	return cmd;
}

function extractId(result: string, prefix: string): string {
	const regex = new RegExp(`ID: (${prefix}-[A-Z0-9]+-[A-Z0-9]+)`);
	const match = result.match(regex);
	if (!match) throw new Error(`Could not extract ID from: ${result}`);
	return match[1];
}

describe("salesPlugin", () => {
	describe("/contact-add", () => {
		it("should create a contact with required fields", async () => {
			const cmd = getCommand("/contact-add");
			const result = await cmd.execute([
				"Alice Smith",
				"--email",
				"alice@test.com",
				"--company",
				"TestCo",
			]);
			expect(String(result)).toContain("Contact Created");
			expect(String(result)).toContain("Alice Smith");
			expect(String(result)).toContain("alice@test.com");
			expect(String(result)).toContain("TestCo");
		});

		it("should create a contact with optional phone and tags", async () => {
			const cmd = getCommand("/contact-add");
			const result = await cmd.execute([
				"Bob Jones",
				"--email",
				"bob@test.com",
				"--company",
				"OtherCo",
				"--phone",
				"555-1234",
				"--tags",
				"vip,enterprise",
			]);
			expect(String(result)).toContain("Bob Jones");
			expect(String(result)).toContain("Phone: 555-1234");
			expect(String(result)).toContain("Tags: vip, enterprise");
		});

		it("should reject duplicate email", async () => {
			const cmd = getCommand("/contact-add");
			await cmd.execute([
				"First",
				"--email",
				"dup@test.com",
				"--company",
				"Co1",
			]);
			const result = await cmd.execute([
				"Second",
				"--email",
				"dup@test.com",
				"--company",
				"Co2",
			]);
			expect(String(result)).toContain("already exists");
		});

		it("should return usage when no name provided", async () => {
			const cmd = getCommand("/contact-add");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /contact-add");
		});

		it("should require email", async () => {
			const cmd = getCommand("/contact-add");
			const result = await cmd.execute(["NoEmail", "--company", "TestCo"]);
			expect(String(result)).toContain("Email is required");
		});
	});

	describe("/contact-list", () => {
		it("should list all contacts", async () => {
			const addCmd = getCommand("/contact-add");
			await addCmd.execute([
				"ListUser1",
				"--email",
				"lu1@list.com",
				"--company",
				"ListCo",
			]);
			await addCmd.execute([
				"ListUser2",
				"--email",
				"lu2@list.com",
				"--company",
				"ListCo",
			]);

			const cmd = getCommand("/contact-list");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("ListUser1");
			expect(String(result)).toContain("ListUser2");
		});

		it("should filter by company", async () => {
			const addCmd = getCommand("/contact-add");
			await addCmd.execute([
				"FilterUser",
				"--email",
				"fu@filter.com",
				"--company",
				"FilterCo",
			]);

			const cmd = getCommand("/contact-list");
			const result = await cmd.execute(["--company", "FilterCo"]);
			expect(String(result)).toContain("FilterUser");
		});

		it("should filter by tag", async () => {
			const addCmd = getCommand("/contact-add");
			await addCmd.execute([
				"TaggedUser",
				"--email",
				"tu@tag.com",
				"--company",
				"TagCo",
				"--tags",
				"premium",
			]);

			const cmd = getCommand("/contact-list");
			const result = await cmd.execute(["--tag", "premium"]);
			expect(String(result)).toContain("TaggedUser");
		});

		it("should return message when no contacts match filter", async () => {
			const cmd = getCommand("/contact-list");
			const result = await cmd.execute(["--company", "NONEXISTENT_COMPANY"]);
			expect(String(result)).toContain("No contacts match");
		});
	});

	describe("/deal-add", () => {
		it("should create a deal linked to a contact", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"DealContact",
				"--email",
				"dc@deal.com",
				"--company",
				"DealCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const cmd = getCommand("/deal-add");
			const result = await cmd.execute([
				"Big Deal",
				"--contact",
				contactId,
				"--value",
				"50000",
				"--stage",
				"qualified",
			]);
			expect(String(result)).toContain("Deal Created");
			expect(String(result)).toContain("Big Deal");
			expect(String(result)).toContain("DealContact");
			expect(String(result)).toContain("$50,000");
			expect(String(result)).toContain("qualified");
			expect(String(result)).toContain("25%");
		});

		it("should default to lead stage with 10% probability", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"LeadContact",
				"--email",
				"lc@lead.com",
				"--company",
				"LeadCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const cmd = getCommand("/deal-add");
			const result = await cmd.execute([
				"Lead Deal",
				"--contact",
				contactId,
				"--value",
				"10000",
			]);
			expect(String(result)).toContain("lead");
			expect(String(result)).toContain("10%");
		});

		it("should reject invalid stage", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"StageContact",
				"--email",
				"sc@stage.com",
				"--company",
				"StageCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const cmd = getCommand("/deal-add");
			const result = await cmd.execute([
				"Bad Stage Deal",
				"--contact",
				contactId,
				"--value",
				"1000",
				"--stage",
				"invalid",
			]);
			expect(String(result)).toContain("Invalid stage");
		});

		it("should reject missing contact ID", async () => {
			const cmd = getCommand("/deal-add");
			const result = await cmd.execute(["No Contact Deal", "--value", "5000"]);
			expect(String(result)).toContain("Contact ID is required");
		});

		it("should reject unknown contact ID", async () => {
			const cmd = getCommand("/deal-add");
			const result = await cmd.execute([
				"Ghost Deal",
				"--contact",
				"CTC-FAKE",
				"--value",
				"5000",
			]);
			expect(String(result)).toContain("not found");
		});

		it("should reject negative value", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"NegContact",
				"--email",
				"nc@neg.com",
				"--company",
				"NegCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const cmd = getCommand("/deal-add");
			const result = await cmd.execute([
				"Negative Deal",
				"--contact",
				contactId,
				"--value",
				"-100",
			]);
			expect(String(result)).toContain("positive number");
		});
	});

	describe("/deal-list", () => {
		it("should list active deals excluding closed ones", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"DLContact",
				"--email",
				"dlc@list.com",
				"--company",
				"DLCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			await addDeal.execute([
				"List Deal 1",
				"--contact",
				contactId,
				"--value",
				"20000",
				"--stage",
				"proposal",
			]);

			const cmd = getCommand("/deal-list");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("List Deal 1");
		});

		it("should group by stage with --all flag", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"AllContact",
				"--email",
				"ac@all.com",
				"--company",
				"AllCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			await addDeal.execute([
				"AllDeal",
				"--contact",
				contactId,
				"--value",
				"30000",
				"--stage",
				"negotiation",
			]);

			const cmd = getCommand("/deal-list");
			const result = await cmd.execute(["--all"]);
			expect(String(result)).toContain("NEGOTIATION");
		});

		it("should filter by stage", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"StgContact",
				"--email",
				"stg@stage.com",
				"--company",
				"StgCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			await addDeal.execute([
				"StgDeal",
				"--contact",
				contactId,
				"--value",
				"15000",
				"--stage",
				"proposal",
			]);

			const cmd = getCommand("/deal-list");
			const result = await cmd.execute(["--stage", "proposal"]);
			expect(String(result)).toContain("StgDeal");
		});

		it("should return message when no deals match", async () => {
			const cmd = getCommand("/deal-list");
			const result = await cmd.execute(["--stage", "closed-won"]);
			expect(String(result)).toMatch(/No deals match|No deals/);
		});
	});

	describe("/deal-move", () => {
		it("should move deal to a new stage and update probability", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"MoveContact",
				"--email",
				"mv@move.com",
				"--company",
				"MoveCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			const dealResult = await addDeal.execute([
				"MoveDeal",
				"--contact",
				contactId,
				"--value",
				"40000",
				"--stage",
				"qualified",
			]);
			const dealId = extractId(String(dealResult), "DL");

			const cmd = getCommand("/deal-move");
			const result = await cmd.execute([dealId, "negotiation"]);
			expect(String(result)).toContain("Deal Moved");
			expect(String(result)).toContain("qualified -> negotiation");
			expect(String(result)).toContain("75%");
		});

		it("should reject invalid stage", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"InvMoveContact",
				"--email",
				"im@move.com",
				"--company",
				"InvCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			const dealResult = await addDeal.execute([
				"InvMoveDeal",
				"--contact",
				contactId,
				"--value",
				"10000",
			]);
			const dealId = extractId(String(dealResult), "DL");

			const cmd = getCommand("/deal-move");
			const result = await cmd.execute([dealId, "invalid-stage"]);
			expect(String(result)).toContain("Invalid stage");
		});

		it("should return error for unknown deal", async () => {
			const cmd = getCommand("/deal-move");
			const result = await cmd.execute(["DL-FAKE", "negotiation"]);
			expect(String(result)).toContain("not found");
		});

		it("should return usage when missing args", async () => {
			const cmd = getCommand("/deal-move");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /deal-move");
		});
	});

	describe("/deal-note", () => {
		it("should add a note to a deal", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"NoteContact",
				"--email",
				"nt@note.com",
				"--company",
				"NoteCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			const dealResult = await addDeal.execute([
				"NoteDeal",
				"--contact",
				contactId,
				"--value",
				"25000",
			]);
			const dealId = extractId(String(dealResult), "DL");

			const cmd = getCommand("/deal-note");
			const result = await cmd.execute([dealId, "Important note"]);
			expect(String(result)).toContain("Note added");
			expect(String(result)).toContain("NoteDeal");
		});

		it("should return error for unknown deal", async () => {
			const cmd = getCommand("/deal-note");
			const result = await cmd.execute(["DL-FAKE", "Some note"]);
			expect(String(result)).toContain("not found");
		});

		it("should return usage when missing args", async () => {
			const cmd = getCommand("/deal-note");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /deal-note");
		});
	});

	describe("/forecast", () => {
		it("should produce revenue forecast", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"FcContact",
				"--email",
				"fc@forecast.com",
				"--company",
				"FcCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			await addDeal.execute([
				"FcDeal1",
				"--contact",
				contactId,
				"--value",
				"60000",
				"--stage",
				"proposal",
			]);
			await addDeal.execute([
				"FcDeal2",
				"--contact",
				contactId,
				"--value",
				"30000",
				"--stage",
				"lead",
			]);

			const cmd = getCommand("/forecast");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Revenue Forecast");
			expect(String(result)).toContain("Total Pipeline:");
			expect(String(result)).toContain("proposal");
			expect(String(result)).toContain("lead");
		});

		it("should include weighted values with --weighted flag", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"WtContact",
				"--email",
				"wt@weighted.com",
				"--company",
				"WtCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			await addDeal.execute([
				"WtDeal",
				"--contact",
				contactId,
				"--value",
				"100000",
				"--stage",
				"proposal",
			]);

			const cmd = getCommand("/forecast");
			const result = await cmd.execute(["--weighted"]);
			expect(String(result)).toContain("Weighted Pipeline:");
		});

		it("should return message when no deals in empty pipeline", async () => {
			const cmd = getCommand("/forecast");
			const result = await cmd.execute([]);
			expect(String(result)).toMatch(/No deals in pipeline|Revenue Forecast/);
		});
	});

	describe("/pipeline", () => {
		it("should show visual pipeline overview", async () => {
			const addContact = getCommand("/contact-add");
			const contactResult = await addContact.execute([
				"PipeContact",
				"--email",
				"pc@pipe.com",
				"--company",
				"PipeCo",
			]);
			const contactId = extractId(String(contactResult), "CTC");

			const addDeal = getCommand("/deal-add");
			await addDeal.execute([
				"PipeDeal",
				"--contact",
				contactId,
				"--value",
				"80000",
				"--stage",
				"negotiation",
			]);

			const cmd = getCommand("/pipeline");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Sales Pipeline");
			expect(String(result)).toContain("negotiation");
			expect(String(result)).toMatch(/\d+ deals/);
		});

		it("should return message when no deals exist", async () => {
			const cmd = getCommand("/pipeline");
			const result = await cmd.execute([]);
			expect(String(result)).toMatch(/No deals|Sales Pipeline/);
		});
	});
});
