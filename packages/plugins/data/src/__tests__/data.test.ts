import { describe, expect, it } from "vitest";
import plugin from "../index.js";

function getCommand(name: string) {
	const cmd = plugin.commands?.find((c) => c.name === name);
	if (!cmd) throw new Error(`Command ${name} not found`);
	return cmd;
}

const CSV_DATA = `name,age,salary,department
Alice,30,70000,engineering
Bob,25,55000,marketing
Charlie,35,90000,engineering
Diana,28,62000,design
Eve,32,78000,engineering
Frank,45,120000,management
Grace,22,48000,marketing
Hank,38,95000,engineering`;

const SMALL_CSV = `x,y
1,2
2,4
3,6
4,8
5,10`;

describe("dataPlugin", () => {
	describe("/data-import", () => {
		it("should import inline CSV data", async () => {
			const cmd = getCommand("/data-import");
			const result = await cmd.execute(["employees", CSV_DATA]);
			expect(String(result)).toContain(
				'Dataset "employees" imported successfully',
			);
			expect(String(result)).toContain("Rows: 8");
			expect(String(result)).toContain("name, age, salary, department");
		});

		it("should infer column types correctly", async () => {
			const cmd = getCommand("/data-import");
			const result = await cmd.execute(["typed", CSV_DATA]);
			expect(String(result)).toContain("age(number)");
			expect(String(result)).toContain("salary(number)");
			expect(String(result)).toContain("name(string)");
			expect(String(result)).toContain("department(string)");
		});

		it("should return usage message when no args provided", async () => {
			const cmd = getCommand("/data-import");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /data-import");
		});

		it("should return usage message when only name provided", async () => {
			const cmd = getCommand("/data-import");
			const result = await cmd.execute(["testds"]);
			expect(String(result)).toContain("Usage: /data-import");
		});

		it("should return error for invalid CSV", async () => {
			const cmd = getCommand("/data-import");
			const result = await cmd.execute(["bad", "singlecolumn"]);
			expect(String(result)).toContain("No valid records found");
		});
	});

	describe("/data-list", () => {
		it("should list loaded datasets", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["listTest", CSV_DATA]);

			const cmd = getCommand("/data-list");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("listTest");
			expect(String(result)).toContain("8 rows");
		});
	});

	describe("/data-stats", () => {
		it("should compute statistics for a numeric column", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["statsTest", CSV_DATA]);

			const cmd = getCommand("/data-stats");
			const result = await cmd.execute(["statsTest", "age"]);
			expect(String(result)).toContain('Statistics for "age"');
			expect(String(result)).toContain("Count:");
			expect(String(result)).toContain("Mean:");
			expect(String(result)).toContain("Median:");
			expect(String(result)).toContain("Min:");
			expect(String(result)).toContain("Max:");
			expect(String(result)).toContain("Std Dev:");
		});

		it("should return usage when args missing", async () => {
			const cmd = getCommand("/data-stats");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /data-stats");
		});

		it("should return error for unknown dataset", async () => {
			const cmd = getCommand("/data-stats");
			const result = await cmd.execute(["nonexistent", "age"]);
			expect(String(result)).toContain("not found");
		});

		it("should return error for unknown column", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["statsCol", CSV_DATA]);

			const cmd = getCommand("/data-stats");
			const result = await cmd.execute(["statsCol", "nonexistent"]);
			expect(String(result)).toContain("not found");
		});

		it("should report no numeric values for string column", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["strCol", CSV_DATA]);

			const cmd = getCommand("/data-stats");
			const result = await cmd.execute(["strCol", "name"]);
			expect(String(result)).toContain("no numeric values");
		});
	});

	describe("/data-query", () => {
		it("should filter records with greater-than operator", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["queryTest", CSV_DATA]);

			const cmd = getCommand("/data-query");
			const result = await cmd.execute(["queryTest", "age>30"]);
			expect(String(result)).toContain("Query results");
			expect(String(result)).toContain("4 of 8 records");
		});

		it("should filter with equality operator", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["eqTest", CSV_DATA]);

			const cmd = getCommand("/data-query");
			const result = await cmd.execute(["eqTest", "department==engineering"]);
			expect(String(result)).toContain("4 of 8 records");
		});

		it("should filter with less-than-or-equal operator", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["lteTest", CSV_DATA]);

			const cmd = getCommand("/data-query");
			const result = await cmd.execute(["lteTest", "age<=28"]);
			expect(String(result)).toContain("3 of 8 records");
		});

		it("should return all records when no filters", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["noFilter", CSV_DATA]);

			const cmd = getCommand("/data-query");
			const result = await cmd.execute(["noFilter"]);
			expect(String(result)).toContain("8 of 8 records");
		});

		it("should return no records for impossible filter", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["emptyFilter", CSV_DATA]);

			const cmd = getCommand("/data-query");
			const result = await cmd.execute(["emptyFilter", "age>999"]);
			expect(String(result)).toContain("No records match");
		});

		it("should return usage when no dataset name", async () => {
			const cmd = getCommand("/data-query");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /data-query");
		});

		it("should return error for unknown dataset", async () => {
			const cmd = getCommand("/data-query");
			const result = await cmd.execute(["unknown"]);
			expect(String(result)).toContain("not found");
		});
	});

	describe("/data-export", () => {
		it("should export dataset as CSV text", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["exportTest", CSV_DATA]);

			const cmd = getCommand("/data-export");
			const result = await cmd.execute(["exportTest"]);
			expect(String(result)).toContain("CSV Export (8 rows)");
			expect(String(result)).toContain("name,age,salary,department");
			expect(String(result)).toContain("Alice");
		});

		it("should return usage when no dataset name", async () => {
			const cmd = getCommand("/data-export");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /data-export");
		});

		it("should return error for unknown dataset", async () => {
			const cmd = getCommand("/data-export");
			const result = await cmd.execute(["noexist"]);
			expect(String(result)).toContain("not found");
		});
	});

	describe("/data-summary", () => {
		it("should produce full dataset summary", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["summaryTest", CSV_DATA]);

			const cmd = getCommand("/data-summary");
			const result = await cmd.execute(["summaryTest"]);
			expect(String(result)).toContain("Dataset: summaryTest");
			expect(String(result)).toContain("Rows: 8");
			expect(String(result)).toContain("Columns: 4");
			expect(String(result)).toContain('Statistics for "age"');
			expect(String(result)).toContain('Statistics for "salary"');
			expect(String(result)).toContain('Column "name" (string)');
			expect(String(result)).toContain('Column "department" (string)');
		});

		it("should return usage when no dataset name", async () => {
			const cmd = getCommand("/data-summary");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /data-summary");
		});

		it("should return error for unknown dataset", async () => {
			const cmd = getCommand("/data-summary");
			const result = await cmd.execute(["nonexistent"]);
			expect(String(result)).toContain("not found");
		});
	});

	describe("/data-correlation", () => {
		it("should compute Pearson correlation for perfectly correlated data", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["corrTest", SMALL_CSV]);

			const cmd = getCommand("/data-correlation");
			const result = await cmd.execute(["corrTest", "x", "y"]);
			expect(String(result)).toContain("Pearson r: 1.0000");
			expect(String(result)).toContain("strong positive");
			expect(String(result)).toContain("Pairs:     5");
		});

		it("should compute correlation for real data", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["corrReal", CSV_DATA]);

			const cmd = getCommand("/data-correlation");
			const result = await cmd.execute(["corrReal", "age", "salary"]);
			expect(String(result)).toContain("Pearson r:");
			expect(String(result)).toContain("correlation");
		});

		it("should return usage when missing args", async () => {
			const cmd = getCommand("/data-correlation");
			const result = await cmd.execute([]);
			expect(String(result)).toContain("Usage: /data-correlation");
		});

		it("should return error for unknown dataset", async () => {
			const cmd = getCommand("/data-correlation");
			const result = await cmd.execute(["nope", "x", "y"]);
			expect(String(result)).toContain("not found");
		});

		it("should report not enough pairs for single record", async () => {
			const importCmd = getCommand("/data-import");
			await importCmd.execute(["tiny", "x,y\n1,2"]);

			const cmd = getCommand("/data-correlation");
			const result = await cmd.execute(["tiny", "x", "y"]);
			expect(String(result)).toContain("Not enough numeric pairs");
		});
	});
});
