import { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline";
import * as crypto from "node:crypto";
import { bootstrap } from "../bootstrap.js";
import { SkillImprover } from "@octopus-ai/core/dist/skills/improver.js";

export function createSkillsCommand(): Command {
  const cmd = new Command("skills").description("Manage Octopus AI skills");

  cmd
    .command("list")
    .description("List all skills with metrics")
    .action(async () => {
      try {
        const system = await bootstrap();
        const skills = await system.skillRegistry.list();

        if (skills.length === 0) {
          console.log(chalk.yellow("No skills found"));
          await system.shutdown();
          return;
        }

        console.log(chalk.cyan.bold(`\n📋 Skills (${skills.length})\n`));
        console.log(
          chalk.white(
            "  Name".padEnd(25) +
              "Version".padEnd(10) +
              "Uses".padEnd(8) +
              "Success".padEnd(10) +
              "Quality",
          ),
        );
        console.log(chalk.gray("  " + "─".repeat(65)));

        for (const skill of skills) {
          const quality =
            ((skill.quality.completeness + skill.quality.accuracy + skill.quality.clarity) / 3 * 100).toFixed(0);
          const successRate = (skill.metrics.successRate * 100).toFixed(0) + "%";

          console.log(
            `  ${skill.name.slice(0, 23).padEnd(25)}` +
              `${skill.version.padEnd(10)}` +
              `${String(skill.metrics.timesUsed).padEnd(8)}` +
              `${successRate.padEnd(10)}` +
              `${quality}%`,
          );
        }

        console.log();
        await system.shutdown();
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("search <query>")
    .description("Search skills by relevance")
    .action(async (query: string) => {
      try {
        const system = await bootstrap();
        const embedding = await system.embedFn(query);
        const matches = await system.skillRegistry.search(embedding, {
          threshold: 0.3,
          limit: 10,
        });

        if (matches.length === 0) {
          console.log(chalk.yellow("No matching skills found"));
        } else {
          console.log(chalk.cyan.bold(`\n🔍 Search Results (${matches.length})\n`));
          for (const match of matches) {
            const score = (match.rankScore * 100).toFixed(1);
            console.log(
              chalk.white(`  ${match.skill.name} (v${match.skill.version})`),
            );
            console.log(
              chalk.gray(
                `    Score: ${score}% | Similarity: ${(match.similarity * 100).toFixed(1)}%`,
              ),
            );
            console.log(
              chalk.gray(`    ${match.skill.description.slice(0, 80)}`),
            );
          }
          console.log();
        }

        await system.shutdown();
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("create <name>")
    .description("Create a new skill interactively")
    .action(async (name: string) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const ask = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
          rl.question(chalk.yellow(prompt), (answer) => resolve(answer.trim()));
        });

      try {
        console.log(chalk.cyan.bold(`\n🔧 Creating skill: ${name}\n`));

        const description = await ask("Description: ");
        const instructions = await ask("Instructions: ");
        const tagsInput = await ask("Tags (comma-separated): ");
        const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);

        const system = await bootstrap();
        const embedding = await system.embedFn(`${name} ${description} ${instructions}`);

        const skill = {
          id: crypto.randomUUID(),
          name,
          version: "1.0.0",
          description,
          tags,
          embedding,
          instructions,
          examples: [],
          templates: [],
          triggerConditions: {
            keywords: tags,
            taskPatterns: [],
            domains: [],
          },
          contextEstimate: {
            instructions: Math.ceil(instructions.length / 4),
            perExample: 0,
            templates: 0,
          },
          metrics: {
            timesUsed: 0,
            successRate: 0,
            avgUserRating: 0,
            lastUsed: new Date().toISOString(),
            improvementsCount: 0,
            createdAt: new Date().toISOString(),
          },
          quality: {
            completeness: 0.5,
            accuracy: 0.5,
            clarity: 0.5,
          },
          dependencies: [],
          related: [],
        };

        await system.skillRegistry.save(skill);
        console.log(chalk.green(`\n✓ Skill '${name}' created successfully`));
        await system.shutdown();
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      } finally {
        rl.close();
      }
    });

  cmd
    .command("improve <name>")
    .description("Trigger skill improvement")
    .action(async (name: string) => {
      try {
        const system = await bootstrap();
        const skill = await system.skillRegistry.getByName(name);

        if (!skill) {
          console.log(chalk.yellow(`Skill '${name}' not found`));
          await system.shutdown();
          return;
        }

        const usageHistory = await system.skillRegistry.getUsageHistory(skill.id, 100);

        const improver = new SkillImprover(system.skillRegistry, system.embedFn, {
          triggerOnSuccessRate: system.config.skills.improvement.triggerOnSuccessRate,
          triggerOnRating: system.config.skills.improvement.triggerOnRating,
          reviewEveryNUses: system.config.skills.improvement.reviewEveryNUses,
          abTestMajorChanges: system.config.skills.improvement.abTestMajorChanges,
          abTestSampleSize: system.config.skills.improvement.abTestSampleSize,
        });

        console.log(chalk.cyan(`Improving skill '${name}'...`));
        const improved = await improver.improveSkill(skill, usageHistory);

        console.log(chalk.green(`\n✓ Skill improved to v${improved.version}`));
        console.log(chalk.gray(`  Previous: v${skill.version}`));
        await system.shutdown();
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("inspect <name>")
    .description("Show detailed skill information")
    .action(async (name: string) => {
      try {
        const system = await bootstrap();
        const skill = await system.skillRegistry.getByName(name);

        if (!skill) {
          console.log(chalk.yellow(`Skill '${name}' not found`));
          await system.shutdown();
          return;
        }

        console.log(chalk.cyan.bold(`\n🔍 Skill: ${skill.name}\n`));
        console.log(chalk.white("  ID:          "), chalk.gray(skill.id));
        console.log(chalk.white("  Version:     "), chalk.gray(skill.version));
        console.log(chalk.white("  Description: "), chalk.gray(skill.description));
        console.log(chalk.white("  Tags:        "), chalk.gray(skill.tags.join(", ")));

        console.log(chalk.white("\n  Metrics:"));
        console.log(chalk.gray(`    Times Used:    ${skill.metrics.timesUsed}`));
        console.log(chalk.gray(`    Success Rate:  ${(skill.metrics.successRate * 100).toFixed(1)}%`));
        console.log(chalk.gray(`    Avg Rating:    ${skill.metrics.avgUserRating.toFixed(1)}`));
        console.log(chalk.gray(`    Last Used:     ${skill.metrics.lastUsed}`));
        console.log(chalk.gray(`    Improvements:  ${skill.metrics.improvementsCount}`));

        console.log(chalk.white("\n  Quality:"));
        console.log(chalk.gray(`    Completeness: ${(skill.quality.completeness * 100).toFixed(1)}%`));
        console.log(chalk.gray(`    Accuracy:     ${(skill.quality.accuracy * 100).toFixed(1)}%`));
        console.log(chalk.gray(`    Clarity:      ${(skill.quality.clarity * 100).toFixed(1)}%`));

        console.log(chalk.white("\n  Instructions:"));
        console.log(chalk.gray("  " + skill.instructions.slice(0, 300) + (skill.instructions.length > 300 ? "..." : "")));

        if (skill.examples.length > 0) {
          console.log(chalk.white(`\n  Examples: ${skill.examples.length}`));
        }

        console.log();
        await system.shutdown();
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("history <name>")
    .description("Show skill version history")
    .action(async (name: string) => {
      try {
        const system = await bootstrap();
        const skill = await system.skillRegistry.getByName(name);

        if (!skill) {
          console.log(chalk.yellow(`Skill '${name}' not found`));
          await system.shutdown();
          return;
        }

        console.log(chalk.cyan.bold(`\n📜 History: ${skill.name}\n`));
        console.log(chalk.white(`  Current: v${skill.version}`));
        console.log(chalk.gray(`  Created: ${skill.metrics.createdAt}`));
        console.log(chalk.gray(`  Improvements: ${skill.metrics.improvementsCount}`));
        console.log();
        await system.shutdown();
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("stats")
    .description("Show global skill statistics")
    .action(async () => {
      try {
        const system = await bootstrap();
        const skills = await system.skillRegistry.list();

        const totalSkills = skills.length;
        const totalUses = skills.reduce((sum, s) => sum + s.metrics.timesUsed, 0);
        const avgSuccess =
          totalSkills > 0
            ? skills.reduce((sum, s) => sum + s.metrics.successRate, 0) / totalSkills
            : 0;
        const avgQuality =
          totalSkills > 0
            ? skills.reduce(
                (sum, s) =>
                  sum +
                  (s.quality.completeness + s.quality.accuracy + s.quality.clarity) / 3,
                0,
              ) / totalSkills
            : 0;

        console.log(chalk.cyan.bold("\n📊 Skill Statistics\n"));
        console.log(chalk.gray(`  Total Skills:    ${totalSkills}`));
        console.log(chalk.gray(`  Total Uses:      ${totalUses}`));
        console.log(chalk.gray(`  Avg Success:     ${(avgSuccess * 100).toFixed(1)}%`));
        console.log(chalk.gray(`  Avg Quality:     ${(avgQuality * 100).toFixed(1)}%`));

        const needingImprovement = await system.skillRegistry.findSkillsNeedingImprovement();
        if (needingImprovement.length > 0) {
          console.log(
            chalk.yellow(`\n  Skills needing improvement: ${needingImprovement.length}`),
          );
          for (const s of needingImprovement) {
            console.log(chalk.gray(`    • ${s.name} (success: ${(s.metrics.successRate * 100).toFixed(0)}%)`));
          }
        }

        console.log();
        await system.shutdown();
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("export <name>")
    .description("Export a skill to a JSON file")
    .action(async (name: string) => {
      try {
        const system = await bootstrap();
        const result = await system.skillMarketplace.exportSkill(name);

        if (result.success) {
          console.log(chalk.green(`\n✓ ${result.message}`));
          if (result.filePath) {
            console.log(chalk.gray(`  File: ${result.filePath}`));
          }
        } else {
          console.log(chalk.red(`\n✗ ${result.message}`));
        }

        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("import <file>")
    .description("Import a skill from a JSON file")
    .option("-f, --force", "Overwrite existing skill")
    .action(async (file: string, opts: { force?: boolean }) => {
      try {
        const system = await bootstrap();

        if (!opts.force) {
          const content = await import("fs/promises");
          const rawData = await content.readFile(
            file.startsWith("~") ? file.replace("~", process.env.HOME || "") : file,
            "utf-8",
          );
          const data = JSON.parse(rawData);
          if (data.skill?.name) {
            const existing = await system.skillRegistry.getByName(data.skill.name);
            if (existing) {
              console.log(chalk.yellow(`Skill '${data.skill.name}' already exists. Use --force to overwrite.`));
              await system.shutdown();
              return;
            }
          }
        }

        const result = await system.skillMarketplace.importSkill(file);

        if (result.success) {
          console.log(chalk.green(`\n✓ ${result.message}`));
        } else {
          console.log(chalk.red(`\n✗ ${result.message}`));
        }

        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("publish <name>")
    .description("Publish a skill to the marketplace")
    .action(async (name: string) => {
      try {
        const system = await bootstrap();
        console.log(chalk.cyan(`Publishing skill '${name}'...`));

        const result = await system.skillMarketplace.publish(name);

        if (result.success) {
          console.log(chalk.green(`\n✓ ${result.message}`));
        } else {
          console.log(chalk.red(`\n✗ ${result.message}`));
        }

        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("browse")
    .description("Browse skills in the marketplace")
    .option("-c, --category <category>", "Filter by category")
    .option("-l, --limit <number>", "Max results", "20")
    .action(async (opts: { category?: string; limit: string }) => {
      try {
        const system = await bootstrap();
        const skills = await system.skillMarketplace.list({
          category: opts.category,
          limit: parseInt(opts.limit, 10),
        });

        console.log(chalk.cyan.bold("\n🏪 Skill Marketplace\n"));

        if (skills.length === 0) {
          console.log(chalk.yellow("  No skills available"));
        } else {
          for (const skill of skills) {
            const quality = ((skill.quality.completeness + skill.quality.accuracy + skill.quality.clarity) / 3 * 100).toFixed(0);
            console.log(chalk.white(`  ${skill.name}`) + chalk.gray(` v${skill.version}`));
            console.log(chalk.gray(`    ${skill.description}`));
            console.log(chalk.gray(`    Author: ${skill.author} | Downloads: ${skill.downloads} | Quality: ${quality}%`));
          }
        }

        console.log();
        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  return cmd;
}
