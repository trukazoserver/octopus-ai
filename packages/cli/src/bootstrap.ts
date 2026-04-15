import { ConfigLoader } from "@octopus-ai/core/dist/config/loader.js";
import type { OctopusConfig } from "@octopus-ai/core/dist/config/schema.js";
import { LLMRouter } from "@octopus-ai/core/dist/ai/router.js";
import { TokenCounter } from "@octopus-ai/core/dist/ai/tokenizer.js";
import type { ProviderConfig } from "@octopus-ai/core/dist/ai/types.js";
import { AgentRuntime } from "@octopus-ai/core/dist/agent/runtime.js";
import type { AgentConfig } from "@octopus-ai/core/dist/agent/types.js";
import { ShortTermMemory } from "@octopus-ai/core/dist/memory/stm.js";
import { LongTermMemory } from "@octopus-ai/core/dist/memory/ltm.js";
import { MemoryRetrieval } from "@octopus-ai/core/dist/memory/retrieval.js";
import { MemoryConsolidator } from "@octopus-ai/core/dist/memory/consolidator.js";
import { createVectorStore } from "@octopus-ai/core/dist/memory/factory.js";
import type { EmbeddingFunction } from "@octopus-ai/core/dist/memory/types.js";
import { SkillRegistry } from "@octopus-ai/core/dist/skills/registry.js";
import { SkillLoader } from "@octopus-ai/core/dist/skills/loader.js";
import { SkillForge } from "@octopus-ai/core/dist/skills/forge.js";
import { ConnectionManager } from "@octopus-ai/core/dist/connection/manager.js";
import { createDatabaseAdapter } from "@octopus-ai/core/dist/storage/database.js";
import type { DatabaseAdapter } from "@octopus-ai/core/dist/storage/database.js";
import { PluginRegistry } from "@octopus-ai/core/dist/plugins/registry.js";
import { PluginMarketplace } from "@octopus-ai/core/dist/plugins/marketplace.js";
import { SkillMarketplace } from "@octopus-ai/core/dist/skills/marketplace.js";

export interface OctopusSystem {
  config: OctopusConfig;
  db: DatabaseAdapter;
  router: LLMRouter;
  stm: ShortTermMemory;
  ltm: LongTermMemory;
  memoryRetrieval: MemoryRetrieval;
  memoryConsolidator: MemoryConsolidator;
  skillRegistry: SkillRegistry;
  skillLoader: SkillLoader;
  skillForge: SkillForge;
  skillMarketplace: SkillMarketplace;
  agentRuntime: AgentRuntime;
  connectionManager: ConnectionManager;
  pluginRegistry: PluginRegistry;
  pluginMarketplace: PluginMarketplace;
  embedFn: EmbeddingFunction;
  shutdown: () => Promise<void>;
}

const embedFn: EmbeddingFunction = async (_text: string) => {
  const dim = 384;
  const vec = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
};

export async function bootstrap(options?: {
  configPath?: string;
}): Promise<OctopusSystem> {
  const loader = new ConfigLoader(options?.configPath);
  const config = loader.load();

  const db = createDatabaseAdapter(config.storage.backend, {
    path: config.storage.path,
  });
  await db.initialize();

  const tokenCounter = new TokenCounter();

  const stm = new ShortTermMemory({
    maxTokens: config.memory.shortTerm.maxTokens,
    scratchPadSize: config.memory.shortTerm.scratchPadSize,
    autoEviction: config.memory.shortTerm.autoEviction,
    tokenCounter: {
      countTokens: (text: string) => tokenCounter.countTokens(text),
      countMessagesTokens: (msgs: { content: string }[]) =>
        msgs.reduce((sum, m) => sum + tokenCounter.countTokens(m.content), 0),
    },
  });

  const vectorStore = createVectorStore(config.memory.longTerm.backend, db);
  const ltm = new LongTermMemory(vectorStore, db);

  const memoryRetrieval = new MemoryRetrieval(ltm, stm, embedFn, {
    maxResults: config.memory.retrieval.maxResults,
    maxTokens: config.memory.retrieval.maxTokens,
    minRelevance: config.memory.retrieval.minRelevance,
    weights: config.memory.retrieval.weights,
  });

  const memoryConsolidator = new MemoryConsolidator(ltm, db, embedFn, {
    importanceThreshold: config.memory.longTerm.importanceThreshold,
    batchSize: config.memory.consolidation.batchSize,
    extractFacts: config.memory.consolidation.extractFacts,
    extractEvents: config.memory.consolidation.extractEvents,
    extractProcedures: config.memory.consolidation.extractProcedures,
  });

  const providers: Record<string, ProviderConfig> = {};
  const providerEntries = Object.entries(config.ai.providers) as Array<[string, { apiKey?: string; baseUrl?: string; models?: string[] }]>;
  for (const [name, pConfig] of providerEntries) {
    if (name === "local") {
      providers.local = { baseUrl: pConfig.baseUrl || "http://localhost:11434" };
    } else if (pConfig.apiKey) {
      providers[name] = { apiKey: pConfig.apiKey, ...(pConfig.baseUrl ? { baseUrl: pConfig.baseUrl } : {}) };
    }
  }

  const router = new LLMRouter({
    default: config.ai.default,
    fallback: config.ai.fallback,
    providers,
  });
  await router.initialize();

  const skillRegistry = new SkillRegistry(db, embedFn);
  const skillLoader = new SkillLoader(skillRegistry, embedFn, {
    maxTokenBudget: config.skills.loading.maxTokenBudget,
    progressiveLevels: config.skills.loading.progressiveLevels,
    autoUnload: config.skills.loading.autoUnload,
    searchThreshold: config.skills.loading.searchThreshold,
  });

  const skillForge = new SkillForge(skillRegistry, embedFn, {
    complexityThreshold: config.skills.forge.complexityThreshold,
    selfCritique: config.skills.forge.selfCritique,
    minQualityScore: config.skills.forge.minQualityScore,
    includeExamples: config.skills.forge.includeExamples,
    includeTemplates: config.skills.forge.includeTemplates,
    includeAntiPatterns: config.skills.forge.includeAntiPatterns,
  });

  const agentConfig: AgentConfig = {
    id: "default-agent",
    name: "Octopus AI",
    description: "Default Octopus AI agent",
    systemPrompt: `You are Octopus AI, an intelligent assistant with memory and skill capabilities.
You help users accomplish tasks efficiently by leveraging your memory of past interactions
and your library of learned skills. Be concise, helpful, and proactive.`,
    model: config.ai.default,
    maxTokens: config.ai.maxTokens,
  };

  const agentRuntime = new AgentRuntime(
    agentConfig,
    router,
    stm,
    memoryRetrieval,
    memoryConsolidator,
    skillLoader,
  );
  await agentRuntime.initialize();

  const connectionManager = new ConnectionManager({
    retryMaxAttempts: config.connection.retryMaxAttempts,
    retryBaseDelay: config.connection.retryBaseDelay,
    circuitBreakerThreshold: config.connection.circuitBreakerThreshold,
    healthCheckInterval: config.connection.healthCheckInterval,
    offlineQueueSize: config.connection.offlineQueueSize,
    preferIPv4: config.connection.preferIPv4,
  });

  const pluginRegistry = new PluginRegistry();
  const pluginMarketplace = new PluginMarketplace(pluginRegistry);

  const skillMarketplace = new SkillMarketplace(skillRegistry, embedFn);

  return {
    config,
    db,
    router,
    stm,
    ltm,
    memoryRetrieval,
    memoryConsolidator,
    skillRegistry,
    skillLoader,
    skillForge,
    skillMarketplace,
    agentRuntime,
    connectionManager,
    pluginRegistry,
    pluginMarketplace,
    embedFn,
    shutdown: async () => {
      connectionManager.shutdown();
      await db.close();
    },
  };
}
