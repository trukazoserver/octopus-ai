import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import type { EmbeddingFunction } from "../memory/types.js";
import type { Skill, SkillMatch, SkillUsage } from "./types.js";

export class SkillRegistry {
  private db: DatabaseAdapter;
  private _embedFn: EmbeddingFunction;

  constructor(db: DatabaseAdapter, embedFn: EmbeddingFunction) {
    this.db = db;
    this._embedFn = embedFn;
  }

  async save(skill: Skill): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL,
        tags TEXT NOT NULL,
        embedding TEXT NOT NULL,
        instructions TEXT NOT NULL,
        examples TEXT NOT NULL,
        templates TEXT NOT NULL,
        triggerConditions TEXT NOT NULL,
        contextEstimate TEXT NOT NULL,
        metrics TEXT NOT NULL,
        quality TEXT NOT NULL,
        dependencies TEXT NOT NULL,
        related TEXT NOT NULL
      )`,
    );

    const serialized = this.serializeSkill(skill);
    await this.db.run(
      `INSERT INTO skills (id, name, version, description, tags, embedding, instructions, examples, templates, triggerConditions, contextEstimate, metrics, quality, dependencies, related)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         version = excluded.version,
         description = excluded.description,
         tags = excluded.tags,
         embedding = excluded.embedding,
         instructions = excluded.instructions,
         examples = excluded.examples,
         templates = excluded.templates,
         triggerConditions = excluded.triggerConditions,
         contextEstimate = excluded.contextEstimate,
         metrics = excluded.metrics,
         quality = excluded.quality,
         dependencies = excluded.dependencies,
         related = excluded.related`,
      [
        serialized.id,
        serialized.name,
        serialized.version,
        serialized.description,
        serialized.tags,
        serialized.embedding,
        serialized.instructions,
        serialized.examples,
        serialized.templates,
        serialized.triggerConditions,
        serialized.contextEstimate,
        serialized.metrics,
        serialized.quality,
        serialized.dependencies,
        serialized.related,
      ],
    );
  }

  async search(
    queryEmbedding: number[],
    options: { threshold: number; limit: number },
  ): Promise<SkillMatch[]> {
    const skills = await this.list();
    const matches: SkillMatch[] = [];

    for (const skill of skills) {
      const similarity = this.cosineSimilarity(queryEmbedding, skill.embedding);
      if (similarity >= options.threshold) {
        const qualityAvg =
          (skill.quality.completeness +
            skill.quality.accuracy +
            skill.quality.clarity) /
          3;
        const successFactor = skill.metrics.successRate || 1;
        const rankScore = similarity * qualityAvg * successFactor;
        matches.push({ skill, similarity, rankScore });
      }
    }

    matches.sort((a, b) => b.rankScore - a.rankScore);
    return matches.slice(0, options.limit);
  }

  async getById(id: string): Promise<Skill | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      "SELECT * FROM skills WHERE id = ?",
      [id],
    );
    if (!row) return undefined;
    return this.deserializeSkill(row);
  }

  async getByName(name: string): Promise<Skill | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      "SELECT * FROM skills WHERE name = ?",
      [name],
    );
    if (!row) return undefined;
    return this.deserializeSkill(row);
  }

  async list(): Promise<Skill[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      "SELECT * FROM skills",
    );
    return rows.map((row) => this.deserializeSkill(row));
  }

  async archiveVersion(skill: Skill): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS skill_history (
        id TEXT PRIMARY KEY,
        skillId TEXT NOT NULL,
        version TEXT NOT NULL,
        skillData TEXT NOT NULL,
        archivedAt TEXT NOT NULL
      )`,
    );
    await this.db.run(
      "INSERT INTO skill_history (id, skillId, version, skillData, archivedAt) VALUES (?, ?, ?, ?, ?)",
      [
        nanoid(),
        skill.id,
        skill.version,
        JSON.stringify(this.serializeSkill(skill)),
        new Date().toISOString(),
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run("DELETE FROM skills WHERE id = ?", [id]);
  }

  async recordUsage(usage: SkillUsage): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS skill_usage (
        id TEXT PRIMARY KEY,
        skillId TEXT NOT NULL,
        task TEXT NOT NULL,
        success INTEGER NOT NULL,
        failureReason TEXT,
        userFeedback TEXT,
        successReason TEXT,
        timestamp TEXT NOT NULL
      )`,
    );
    await this.db.run(
      "INSERT INTO skill_usage (id, skillId, task, success, failureReason, userFeedback, successReason, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        usage.id,
        usage.skillId,
        usage.task,
        usage.success ? 1 : 0,
        usage.failureReason ?? null,
        usage.userFeedback ?? null,
        usage.successReason ?? null,
        usage.timestamp.toISOString(),
      ],
    );
  }

  async getUsageHistory(skillId: string, limit: number): Promise<SkillUsage[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      "SELECT * FROM skill_usage WHERE skillId = ? ORDER BY timestamp DESC LIMIT ?",
      [skillId, limit],
    );
    return rows.map((row) => ({
      id: row.id as string,
      skillId: row.skillId as string,
      task: row.task as string,
      success: (row.success as number) === 1,
      failureReason: (row.failureReason as string) || undefined,
      userFeedback: (row.userFeedback as string) || undefined,
      successReason: (row.successReason as string) || undefined,
      timestamp: new Date(row.timestamp as string),
    }));
  }

  async findSkillsNeedingImprovement(): Promise<Skill[]> {
    const skills = await this.list();
    return skills.filter(
      (skill) =>
        skill.metrics.successRate < 0.7 ||
        skill.metrics.timesUsed % 10 === 0 ||
        skill.metrics.avgUserRating < 3.5,
    );
  }

  async updateMetrics(skillId: string): Promise<void> {
    const history = await this.getUsageHistory(skillId, 1000);
    const skill = await this.getById(skillId);
    if (!skill) return;

    const successes = history.filter((u) => u.success).length;
    const total = history.length;
    const successRate = total > 0 ? successes / total : 0;

    const ratingsHistory = history.filter((u) => u.userFeedback);
    const avgUserRating =
      ratingsHistory.length > 0
        ? ratingsHistory.reduce((sum, u) => {
            const rating = parseInt(u.userFeedback!, 10);
            return isNaN(rating) ? sum : sum + rating;
          }, 0) / ratingsHistory.length
        : skill.metrics.avgUserRating;

    skill.metrics.successRate = successRate;
    skill.metrics.avgUserRating = avgUserRating;
    skill.metrics.timesUsed = total;
    skill.metrics.lastUsed =
      history.length > 0
        ? history[0]!.timestamp.toISOString()
        : skill.metrics.lastUsed;

    await this.save(skill);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }

  private serializeSkill(skill: Skill): Record<string, unknown> {
    return {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      tags: JSON.stringify(skill.tags),
      embedding: JSON.stringify(skill.embedding),
      instructions: skill.instructions,
      examples: JSON.stringify(skill.examples),
      templates: JSON.stringify(skill.templates),
      triggerConditions: JSON.stringify(skill.triggerConditions),
      contextEstimate: JSON.stringify(skill.contextEstimate),
      metrics: JSON.stringify(skill.metrics),
      quality: JSON.stringify(skill.quality),
      dependencies: JSON.stringify(skill.dependencies),
      related: JSON.stringify(skill.related),
    };
  }

  private deserializeSkill(row: Record<string, unknown>): Skill {
    return {
      id: row.id as string,
      name: row.name as string,
      version: row.version as string,
      description: row.description as string,
      tags: JSON.parse(row.tags as string),
      embedding: JSON.parse(row.embedding as string),
      instructions: row.instructions as string,
      examples: JSON.parse(row.examples as string),
      templates: JSON.parse(row.templates as string),
      triggerConditions: JSON.parse(row.triggerConditions as string),
      contextEstimate: JSON.parse(row.contextEstimate as string),
      metrics: JSON.parse(row.metrics as string),
      quality: JSON.parse(row.quality as string),
      dependencies: JSON.parse(row.dependencies as string),
      related: JSON.parse(row.related as string),
    };
  }
}
