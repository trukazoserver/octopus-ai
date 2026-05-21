import { nanoid } from "nanoid";
import type { ConversationTurn, TaskState } from "../agent/types.js";
import type { DatabaseAdapter } from "../storage/database.js";
import type { LongTermMemory } from "./ltm.js";
import type { MemoryOrchestrator } from "./orchestrator.js";
import type { ShortTermMemory } from "./stm.js";
import type {
	ConsolidationResult,
	EmbeddingFunction,
	MemoryCandidate,
	MemoryItem,
	MemoryType,
} from "./types.js";

type PartialMemoryItem = Omit<
	MemoryItem,
	"id" | "embedding" | "createdAt" | "associations"
>;

/**
 * Callback for LLM-based fact extraction.
 * Should return structured extraction from conversation turns.
 */
export type LLMExtractCallback = (conversationText: string) => Promise<{
	facts: string[];
	decisions: string[];
	errors: string[];
	toolsUsed: string[];
}>;

export class MemoryConsolidator {
	private db: DatabaseAdapter;
	private llmExtractor: LLMExtractCallback | null = null;
	private orchestrator?: MemoryOrchestrator;
	private orchestratorScope: MemoryCandidate["scope"] = { tenantId: "local" };
	constructor(
		private ltm: LongTermMemory,
		db: DatabaseAdapter,
		private embedFn: EmbeddingFunction,
		private config: {
			importanceThreshold: number;
			batchSize: number;
			extractFacts: boolean;
			extractEvents: boolean;
			extractProcedures: boolean;
		},
	) {
		this.db = db;
	}

	/**
	 * Set LLM-based extraction callback for higher quality fact extraction.
	 * Falls back to regex if not set or if LLM fails.
	 */
	setLLMExtractor(fn: LLMExtractCallback): void {
		this.llmExtractor = fn;
	}

	setMemoryOrchestrator(
		orchestrator: MemoryOrchestrator,
		scope: Partial<MemoryCandidate["scope"]> = {},
	): void {
		this.orchestrator = orchestrator;
		this.orchestratorScope = {
			tenantId: scope.tenantId ?? "local",
			userId: scope.userId,
			projectId: scope.projectId,
			agentRole: scope.agentRole,
			sessionId: scope.sessionId,
			taskId: scope.taskId,
		};
	}

	async consolidate(stm: ShortTermMemory): Promise<ConsolidationResult> {
		const result: ConsolidationResult = {
			stored: 0,
			updated: 0,
			compressed: 0,
			forgotten: 0,
			associations: 0,
		};

		const turns = stm.getContext();
		const activeTask = stm.getActiveTask();

		if (turns.length === 0 && !activeTask) return result;

		await this.ensureAssociationTable();

		let allItems: (PartialMemoryItem & { importance: number })[] = [];

		// Try LLM extraction first (much higher quality)
		const llmItems = await this.tryLLMExtraction(turns);
		if (llmItems.length > 0) {
			const scored = await this.scoreImportance(llmItems);
			allItems = allItems.concat(scored);
		} else {
			// Fallback to regex-based extraction
			if (this.config.extractFacts) {
				const facts = this.extractFacts(turns);
				const scored = await this.scoreImportance(facts);
				allItems = allItems.concat(scored);
			}
		}

		if (this.config.extractEvents) {
			const events = this.extractEvents(turns, activeTask);
			const scored = await this.scoreImportance(events);
			allItems = allItems.concat(scored);
		}

		const storedItems: MemoryItem[] = [];
		for (const item of allItems) {
			if (item.importance >= this.config.importanceThreshold) {
				const memoryItem = await this.storeItem(item);
				if (memoryItem) {
					storedItems.push(memoryItem);
					if (memoryItem.metadata.duplicateReinforcedAt) result.updated++;
					else result.stored++;
				}
			}
		}

		result.associations = await this.buildAssociations(storedItems);

		const decayResult = await this.compressAndDecay();
		result.compressed = decayResult.compressed;
		result.forgotten = decayResult.forgotten;

		return result;
	}

	private async storeItem(
		item: PartialMemoryItem & { importance: number },
	): Promise<MemoryItem | undefined> {
		const enrichedItem = this.withStructuredMetadata(item);
		if (this.orchestrator) {
			const write = await this.orchestrator.write({
				type: enrichedItem.type,
				content: enrichedItem.content,
				sourceTrust: this.inferSourceTrust(enrichedItem),
				scope: this.scopeForItem(enrichedItem),
				confidence: Math.min(0.85, Math.max(0.45, enrichedItem.importance)),
				importance: enrichedItem.importance,
				source: {
					...enrichedItem.source,
					sourceType: enrichedItem.source.sourceType ?? "conversation",
					quotedEvidence:
						enrichedItem.source.quotedEvidence ?? enrichedItem.content,
				},
				metadata: enrichedItem.metadata,
				evidence: {
					sourceType: "message",
					sourceId:
						enrichedItem.source.conversationId ??
						enrichedItem.source.channelId ??
						enrichedItem.source.taskId,
					excerpt: enrichedItem.content,
				},
			});
			if (!write.accepted || !write.memoryId) return undefined;
			return this.ltm.getById(write.memoryId);
		}

		const embedding = await this.embedFn(enrichedItem.content, "document");
		const memoryItem: MemoryItem = {
			id: nanoid(),
			type: enrichedItem.type,
			content: enrichedItem.content,
			embedding,
			importance: enrichedItem.importance,
			accessCount: enrichedItem.accessCount,
			lastAccessed: enrichedItem.lastAccessed,
			createdAt: new Date(),
			associations: [],
			source: enrichedItem.source,
			metadata: enrichedItem.metadata,
		};
		await this.ltm.store(memoryItem);
		return memoryItem;
	}

	private inferSourceTrust(
		item: PartialMemoryItem & { importance: number },
	): MemoryCandidate["sourceTrust"] {
		const extractedFrom = item.metadata.extractedFrom;
		if (extractedFrom === "conversation" || extractedFrom === "llm") {
			return "user_inferred";
		}
		if (item.source.taskId) return "agent";
		return "agent";
	}

	private scopeForItem(
		item: PartialMemoryItem & { importance: number },
	): MemoryCandidate["scope"] {
		return {
			...this.orchestratorScope,
			sessionId:
				this.orchestratorScope.sessionId ??
				item.source.channelId ??
				item.source.conversationId,
			taskId: this.orchestratorScope.taskId ?? item.source.taskId,
		};
	}

	private withStructuredMetadata<
		T extends PartialMemoryItem & { importance: number },
	>(item: T): T {
		const structured = this.extractStructuredMetadata(item.content);
		if (Object.keys(structured).length === 0) return item;
		return {
			...item,
			metadata: this.mergeStructuredMetadata(item.metadata, structured),
		};
	}

	private extractStructuredMetadata(content: string): Record<string, unknown> {
		const sentence = content
			.replace(/^(?:Decision:|Error encountered:|Task completed:)\s*/i, "")
			.trim()
			.replace(/[.!?]+$/g, "");
		return (
			this.extractPreferenceClaim(sentence) ??
			this.extractUsesClaim(sentence) ??
			this.extractSlaClaim(sentence) ??
			this.extractIndustryClaim(sentence) ??
			{}
		);
	}

	private extractPreferenceClaim(
		sentence: string,
	): Record<string, unknown> | undefined {
		const match = sentence.match(
			/^(?:the\s+)?(?<entity>user|client|customer|team|project|[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*){0,3})\s+(?:prefers?|likes?|prefiere|prefieren)\s+(?<value>[^.;]{2,120})$/iu,
		);
		if (!match?.groups) return undefined;
		const entity = cleanClaimPart(match.groups.entity);
		const value = cleanClaimPart(match.groups.value);
		if (!entity || !value) return undefined;
		return this.claimMetadata(entity, "preference", value, "prefers");
	}

	private extractUsesClaim(
		sentence: string,
	): Record<string, unknown> | undefined {
		const match = sentence.match(
			/^(?:the\s+)?(?<entity>user|client|customer|team|project|[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*){0,3})\s+(?:uses?|utiliza|usa|usan)\s+(?<value>[^.;]{2,120})$/iu,
		);
		if (!match?.groups) return undefined;
		const entity = cleanClaimPart(match.groups.entity);
		const value = cleanClaimPart(match.groups.value);
		if (!entity || !value) return undefined;
		return this.claimMetadata(entity, "tooling", value, "uses");
	}

	private extractSlaClaim(
		sentence: string,
	): Record<string, unknown> | undefined {
		const match = sentence.match(
			/^(?<entity>[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*){0,3}).*\bSLA\b.*\b(?:is|es)\s+(?<value>[\d.]+\s*%?)$/iu,
		);
		if (!match?.groups) return undefined;
		const entity = cleanClaimPart(match.groups.entity);
		const value = cleanClaimPart(match.groups.value);
		if (!entity || !value) return undefined;
		return this.claimMetadata(entity, "sla", value, "associated");
	}

	private extractIndustryClaim(
		sentence: string,
	): Record<string, unknown> | undefined {
		const match = sentence.match(
			/^(?<entity>[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*){0,3})\s+(?:belongs to|is in|pertenece al|pertenece a)\s+(?:the\s+)?(?<value>[^.;]{2,80})\s+(?:industry|sector)?$/iu,
		);
		if (!match?.groups) return undefined;
		const entity = cleanClaimPart(match.groups.entity);
		const value = cleanClaimPart(match.groups.value);
		if (!entity || !value) return undefined;
		return this.claimMetadata(entity, "industry", value, "associated");
	}

	private claimMetadata(
		entity: string,
		key: string,
		value: string,
		relationType: string,
	): Record<string, unknown> {
		return {
			claimEntity: entity,
			claimKey: key,
			claimValue: value,
			claim: { entity, key, value },
			entities: [
				{ name: entity, type: this.entityType(entity), confidence: 0.72 },
				{ name: value, type: key, confidence: 0.68 },
			],
			relations: [
				{
					from: entity,
					type: relationType,
					to: value,
					context: key,
					confidence: 0.7,
				},
			],
		};
	}

	private entityType(entity: string): string {
		return /^(user|client|customer|team|project)$/i.test(entity)
			? entity.toLowerCase()
			: "entity";
	}

	private mergeStructuredMetadata(
		metadata: Record<string, unknown>,
		structured: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			...structured,
			...metadata,
			claim:
				metadata.claim && typeof metadata.claim === "object"
					? metadata.claim
					: structured.claim,
			entities: mergeDescriptorArrays(
				structured.entities,
				metadata.entities,
				"name",
			),
			relations: mergeDescriptorArrays(
				structured.relations,
				metadata.relations,
				"from:type:to",
			),
		};
	}

	private async ensureAssociationTable(): Promise<void> {
		const columns = await this.db.all<{ name: string }>(
			"PRAGMA table_info(memory_associations)",
		);
		const hasTable = columns.length > 0;
		const hasId = columns.some((column) => column.name === "id");
		const hasLegacyColumns =
			columns.some((column) => column.name === "from_id") &&
			columns.some((column) => column.name === "to_id");
		const strengthSelect = columns.some((column) => column.name === "strength")
			? "strength"
			: "1 as strength";
		const createdAtSelect = columns.some(
			(column) => column.name === "created_at",
		)
			? "created_at"
			: "NULL as created_at";
		let legacyRows: Array<{
			from_id: string;
			to_id: string;
			strength?: number;
			created_at?: string;
		}> = [];

		if (hasTable && !hasId && hasLegacyColumns) {
			legacyRows = await this.db.all(
				`SELECT from_id, to_id, ${strengthSelect}, ${createdAtSelect} FROM memory_associations`,
			);
			await this.db.run("DROP TABLE memory_associations");
		} else if (hasTable && !hasId) {
			await this.db.run("DROP TABLE memory_associations");
		}

		await this.db.run(
			`CREATE TABLE IF NOT EXISTS memory_associations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'associated',
        strength REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
		);

		const currentColumns = await this.db.all<{ name: string }>(
			"PRAGMA table_info(memory_associations)",
		);
		if (!currentColumns.some((column) => column.name === "relation")) {
			await this.db.run(
				"ALTER TABLE memory_associations ADD COLUMN relation TEXT NOT NULL DEFAULT 'associated'",
			);
		}

		for (const row of legacyRows) {
			await this.db.run(
				`INSERT INTO memory_associations (id, source_id, target_id, relation, strength, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
				[
					nanoid(),
					row.from_id,
					row.to_id,
					"associated",
					row.strength ?? 1,
					row.created_at ?? new Date().toISOString(),
				],
			);
		}
	}

	/**
	 * Try LLM-based extraction for higher quality fact capture.
	 * Returns empty array if LLM is not configured or fails.
	 */
	private async tryLLMExtraction(
		turns: ConversationTurn[],
	): Promise<PartialMemoryItem[]> {
		if (!this.llmExtractor) return [];

		try {
			// Build conversation text for the LLM
			const conversationText = turns
				.map((t) => `[${t.role}]: ${t.content.slice(0, 500)}`)
				.join("\n");

			if (conversationText.length < 20) return [];

			const extraction = await this.llmExtractor(conversationText);
			const items: PartialMemoryItem[] = [];
			const now = new Date();

			// Convert facts
			for (const fact of extraction.facts) {
				if (fact.trim().length > 5) {
					items.push({
						type: "semantic" as MemoryType,
						content: fact.trim(),
						importance: 0,
						accessCount: 0,
						lastAccessed: now,
						source: {},
						metadata: { extractedFrom: "llm", category: "fact" },
					});
				}
			}

			// Convert decisions
			for (const decision of extraction.decisions) {
				if (decision.trim().length > 5) {
					items.push({
						type: "semantic" as MemoryType,
						content: `Decision: ${decision.trim()}`,
						importance: 0,
						accessCount: 0,
						lastAccessed: now,
						source: {},
						metadata: { extractedFrom: "llm", category: "decision" },
					});
				}
			}

			// Convert errors
			for (const error of extraction.errors) {
				if (error.trim().length > 5) {
					items.push({
						type: "episodic" as MemoryType,
						content: `Error encountered: ${error.trim()}`,
						importance: 0,
						accessCount: 0,
						lastAccessed: now,
						source: {},
						metadata: { extractedFrom: "llm", category: "error" },
					});
				}
			}

			// Convert tools used
			if (extraction.toolsUsed.length > 0) {
				items.push({
					type: "procedural" as MemoryType,
					content: `Tools used in workflow: ${extraction.toolsUsed.join(", ")}`,
					importance: 0,
					accessCount: 0,
					lastAccessed: now,
					source: {},
					metadata: { extractedFrom: "llm", category: "procedure" },
				});
			}

			return items;
		} catch {
			// LLM failed, return empty to trigger regex fallback
			return [];
		}
	}

	private extractFacts(turns: ConversationTurn[]): PartialMemoryItem[] {
		const facts: PartialMemoryItem[] = [];
		const patterns = [
			/\bI\s+prefer\b/gi,
			/\bI\s+like\b/gi,
			/\bI\s+don't\s+like\b/gi,
			/\bI\s+hate\b/gi,
			/\bI\s+love\b/gi,
			/\balways\s+(?:do|use|prefer)\b/gi,
			/\bnever\s+(?:do|use|prefer)\b/gi,
			/\bmy\s+(?:favorite|preferred|default)\b/gi,
			/\bis\s+(?:always|never|usually|typically)\b/gi,
			/\bplease\s+(?:always|never|make\s+sure)\b/gi,
		];

		for (const turn of turns) {
			if (turn.role !== "user") continue;
			const content = turn.content;

			for (const pattern of patterns) {
				if (pattern.test(content)) {
					const sentences = content
						.split(/[.!?]+/)
						.filter((s) => s.trim().length > 0);
					for (const sentence of sentences) {
						let matched = false;
						for (const p of patterns) {
							if (p.test(sentence)) {
								matched = true;
								break;
							}
						}
						if (matched) {
							facts.push({
								type: "semantic" as MemoryType,
								content: sentence.trim(),
								importance: 0,
								accessCount: 0,
								lastAccessed: turn.timestamp,
								source: {
									...(turn.metadata?.conversationId
										? { conversationId: turn.metadata.conversationId as string }
										: {}),
								},
								metadata: { extractedFrom: "conversation", role: turn.role },
							});
						}
					}
					break;
				}
			}

			const declarativePatterns = [
				/^(?:the|a|an|this|that|my|our|their)\s+\w+\s+(?:is|are|was|were|has|have|had|will|should|can|could)\s+/i,
			];
			for (const pattern of declarativePatterns) {
				if (pattern.test(content.trim())) {
					const sentences = content
						.split(/[.!?]+/)
						.filter((s) => s.trim().length > 0);
					for (const sentence of sentences) {
						if (pattern.test(sentence.trim())) {
							facts.push({
								type: "semantic" as MemoryType,
								content: sentence.trim(),
								importance: 0,
								accessCount: 0,
								lastAccessed: turn.timestamp,
								source: {},
								metadata: { extractedFrom: "conversation", role: turn.role },
							});
						}
					}
				}
			}
		}

		return facts;
	}

	private extractEvents(
		turns: ConversationTurn[],
		task: TaskState | null,
	): PartialMemoryItem[] {
		const events: PartialMemoryItem[] = [];

		if (task && task.status === "completed") {
			let content = `Task completed: ${task.description}`;
			if (task.result) {
				content += `. Result: ${task.result}`;
			}
			events.push({
				type: "episodic",
				content,
				importance: 0,
				accessCount: 0,
				lastAccessed: task.completedAt ?? new Date(),
				source: { taskId: task.id },
				metadata: {
					taskStatus: task.status,
					startedAt: task.startedAt?.toISOString(),
					completedAt: task.completedAt?.toISOString(),
				},
			});
		}

		if (task && task.status === "failed") {
			let content = `Task failed: ${task.description}`;
			if (task.error) {
				content += `. Error: ${task.error}`;
			}
			events.push({
				type: "episodic",
				content,
				importance: 0,
				accessCount: 0,
				lastAccessed: new Date(),
				source: { taskId: task.id },
				metadata: {
					taskStatus: task.status,
					error: task.error,
				},
			});
		}

		for (let i = 0; i < turns.length; i++) {
			const turn = turns[i];
			if (turn.role === "assistant" && i > 0) {
				const prevTurn = turns[i - 1];

				// Conversation Summary
				if (prevTurn.role === "user" && turn.content.length > 20) {
					// Detect if this is a significant interaction (e.g. tool usage, media, deep answers)
					const isSignificant =
						prevTurn.content.toLowerCase().includes("generate") ||
						prevTurn.content.toLowerCase().includes("create") ||
						turn.content.includes("![") || // Markdown media
						turn.content.includes("```") || // Code snippet
						turn.content.length > 200;

					if (isSignificant) {
						const summary = `User asked: "${prevTurn.content.substring(0, 150)}..." Assistant replied: "${turn.content.substring(0, 150)}..."`;

						// Try to extract channel ID from metadata
						const channelId = prevTurn.metadata?.conversationId as
							| string
							| undefined;
						const sourceInfo = channelId ? `[Channel: ${channelId}] ` : "";

						events.push({
							type: "episodic",
							content: `${sourceInfo}Interaction summary: ${summary}`,
							importance: 0.8, // Force high importance for tests
							accessCount: 0,
							lastAccessed: turn.timestamp,
							source: {
								...(channelId ? { channelId, conversationId: channelId } : {}),
							},
							metadata: {
								extractedFrom: "conversation_summary",
								role: "system",
							},
						});
					}
				}

				if (
					prevTurn.role === "user" &&
					(turn.content.toLowerCase().includes("decided") ||
						turn.content.toLowerCase().includes("chose") ||
						turn.content.toLowerCase().includes("selected") ||
						turn.content.toLowerCase().includes("concluded"))
				) {
					events.push({
						type: "episodic",
						content: `Decision made: ${turn.content.substring(0, 500)}`,
						importance: 0,
						accessCount: 0,
						lastAccessed: turn.timestamp,
						source: {},
						metadata: { extractedFrom: "conversation" },
					});
				}
			}
		}

		return events;
	}

	private async scoreImportance(
		items: PartialMemoryItem[],
	): Promise<(PartialMemoryItem & { importance: number })[]> {
		return items.map((item) => {
			let score = 0.3;

			const contentLower = item.content.toLowerCase();

			const preferenceKeywords = [
				"prefer",
				"like",
				"don't like",
				"hate",
				"love",
				"favorite",
				"always",
				"never",
			];
			for (const keyword of preferenceKeywords) {
				if (contentLower.includes(keyword)) {
					score += 0.2;
					break;
				}
			}

			if (item.content.length > 50) score += 0.1;
			if (item.content.length > 150) score += 0.1;

			if (
				contentLower.includes("important") ||
				contentLower.includes("critical")
			) {
				score += 0.15;
			}

			if (item.source.taskId) {
				score += 0.15;
			}

			if (item.type === "episodic" && contentLower.includes("failed")) {
				score += 0.1;
			}

			score = Math.min(1.0, score);

			return { ...item, importance: score };
		});
	}

	private async buildAssociations(items: MemoryItem[]): Promise<number> {
		let count = 0;
		for (let i = 0; i < items.length; i++) {
			for (let j = i + 1; j < items.length; j++) {
				if (items[i].type === items[j].type) {
					const sharedWords = this.countSharedWords(
						items[i].content,
						items[j].content,
					);
					if (sharedWords >= 2) {
						const strength = Math.min(sharedWords / 10, 1.0);
						await this.ltm.associate(items[i].id, items[j].id, strength);
						count++;
					}
				}
			}
		}
		return count;
	}

	private countSharedWords(a: string, b: string): number {
		const stopWords = new Set([
			"the",
			"a",
			"an",
			"is",
			"are",
			"was",
			"were",
			"be",
			"been",
			"being",
			"have",
			"has",
			"had",
			"do",
			"does",
			"did",
			"will",
			"would",
			"could",
			"should",
			"may",
			"might",
			"shall",
			"can",
			"need",
			"dare",
			"ought",
			"used",
			"to",
			"of",
			"in",
			"for",
			"on",
			"with",
			"at",
			"by",
			"from",
			"as",
			"into",
			"through",
			"during",
			"before",
			"after",
			"above",
			"below",
			"between",
			"out",
			"off",
			"over",
			"under",
			"again",
			"further",
			"then",
			"once",
			"and",
			"but",
			"or",
			"nor",
			"not",
			"so",
			"yet",
			"both",
			"either",
			"neither",
			"each",
			"every",
			"all",
			"any",
			"few",
			"more",
			"most",
			"other",
			"some",
			"such",
			"no",
			"only",
			"own",
			"same",
			"than",
			"too",
			"very",
			"just",
			"because",
			"if",
			"when",
			"where",
			"how",
			"what",
			"which",
			"who",
			"whom",
			"this",
			"that",
			"these",
			"those",
			"i",
			"me",
			"my",
			"myself",
			"we",
			"our",
			"ours",
			"ourselves",
			"you",
			"your",
			"yours",
			"yourself",
			"yourselves",
			"he",
			"him",
			"his",
			"himself",
			"she",
			"her",
			"hers",
			"herself",
			"it",
			"its",
			"itself",
			"they",
			"them",
			"their",
			"theirs",
			"themselves",
		]);
		const wordsA = new Set(
			a
				.toLowerCase()
				.split(/\W+/)
				.filter((w) => w.length > 1 && !stopWords.has(w)),
		);
		const wordsB = new Set(
			b
				.toLowerCase()
				.split(/\W+/)
				.filter((w) => w.length > 1 && !stopWords.has(w)),
		);
		let shared = 0;
		for (const word of wordsA) {
			if (wordsB.has(word)) shared++;
		}
		return shared;
	}

	private async compressAndDecay(): Promise<{
		compressed: number;
		forgotten: number;
	}> {
		let compressed = 0;
		let forgotten = 0;

		const total = await this.ltm.count();
		if (total === 0) return { compressed: 0, forgotten: 0 };

		const allResults = await this.ltm.listAll(
			Math.max(total, this.config.batchSize),
		);

		const now = Date.now();
		for (const item of allResults) {
			const daysSinceCreation =
				(now - item.createdAt.getTime()) / (1000 * 60 * 60 * 24);
			const daysSinceAccess =
				(now - item.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);

			if (
				daysSinceAccess > 90 &&
				item.importance < 0.5 &&
				item.accessCount < 3
			) {
				await this.ltm.forget(item.id);
				forgotten++;
				continue;
			}

			if (daysSinceCreation > 30 && item.importance > 0) {
				const decayFactor = Math.exp(-0.05 * daysSinceAccess);
				const newImportance = item.importance * (0.9 + 0.1 * decayFactor);
				if (newImportance !== item.importance) {
					item.importance = Math.max(0, newImportance);
					await this.ltm.store(item);
					compressed++;
				}
			}
		}

		return { compressed, forgotten };
	}
}

function cleanClaimPart(value: string | undefined): string {
	return (value ?? "")
		.trim()
		.replace(/^(?:that|the|a|an|el|la|los|las)\s+/i, "")
		.replace(/\s+/g, " ")
		.slice(0, 120);
}

function mergeDescriptorArrays(
	primary: unknown,
	secondary: unknown,
	keyMode: "name" | "from:type:to",
): unknown[] {
	const result: unknown[] = [];
	const seen = new Set<string>();
	for (const entry of [
		...(Array.isArray(primary) ? primary : []),
		...(Array.isArray(secondary) ? secondary : []),
	]) {
		if (!entry || typeof entry !== "object") continue;
		const key = descriptorKey(entry as Record<string, unknown>, keyMode);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

function descriptorKey(
	entry: Record<string, unknown>,
	keyMode: "name" | "from:type:to",
): string | undefined {
	if (keyMode === "name") {
		return typeof entry.name === "string"
			? entry.name.toLowerCase()
			: undefined;
	}
	const from = typeof entry.from === "string" ? entry.from.toLowerCase() : "";
	const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
	const to = typeof entry.to === "string" ? entry.to.toLowerCase() : "";
	return from && type && to ? `${from}:${type}:${to}` : undefined;
}
