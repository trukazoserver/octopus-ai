# Arquitectura

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Octopus AI es un monorepo pnpm con Turborepo, compuesto por 11 paquetes TypeScript.

## Estructura de Paquetes

```
octopus-ai/
├── packages/
│   ├── core/                    # SDK principal
│   │   └── src/
│   │       ├── ai/              # Router LLM + 10 proveedores
│   │       ├── agent/           # Runtime, planificador, coordinador
│   │       ├── config/          # Schema TypeBox, loader, defaults
│   │       ├── connection/      # Proxy, retry, circuit breaker, health
│   │       ├── memory/          # STM, LTM, retrieval, consolidación
│   │       ├── plugins/         # Engine, registry, marketplace, MCP
│   │       ├── skills/          # Registry, forge, improver, evaluator
│   │       ├── storage/         # SQLite (better-sqlite3) + migraciones
│   │       ├── tools/           # Registry, executor, filesystem, shell
│   │       ├── transport/       # HTTP + WebSocket server/client
│   │       ├── utils/           # Logger, crypto, helpers, benchmark
│   │       └── voice/           # TTS, STT, wake word
│   ├── cli/                     # CLI interactivo (Commander.js + Ink)
│   ├── desktop/                 # App desktop (Electron)
│   ├── web/                     # Dashboard web (Vite + React)
│   └── plugins/                 # 7 plugins integrados
│       ├── productivity/        # Tareas, calendario, notas
│       ├── coding/              # Code review, refactoring, debugging
│       ├── research/            # Búsqueda, papers, resúmenes
│       ├── file-manager/        # Operaciones de archivos
│       ├── sales/               # CRM, pipeline, follow-ups
│       ├── customer-support/    # Tickets, respuestas, escalamiento
│       └── data/                # SQL, gráficos, ETL
├── scripts/
│   └── install.mjs              # Instalador automático
└── docs/                        # Documentación
```

## Módulos Core

| Módulo | Archivos | Descripción |
|--------|----------|-------------|
| `ai` | `router.ts`, `types.ts`, `tokenizer.ts`, `providers/*.ts` | Router LLM con 10 proveedores, failover automático, reasoning/thinking |
| `agent` | `runtime.ts`, `planner.ts`, `coordinator.ts` | Runtime de agente, planificación de tareas, coordinación multi-agente |
| `config` | `schema.ts`, `loader.ts`, `validator.ts`, `defaults.ts` | Schema TypeBox validado, loader con env vars, defaults inteligentes |
| `connection` | `manager.ts`, `network.ts`, `retry.ts`, `circuit-breaker.ts` | Detección de proxy, reintentos con backoff, circuit breaker, health check |
| `memory` | `stm.ts`, `ltm.ts`, `retrieval.ts`, `consolidator.ts`, `factory.ts` | Memoria a corto/largo plazo, recuperación ponderada, consolidación automática |
| `plugins` | `engine.ts`, `registry.ts`, `marketplace.ts`, `mcp/client.ts` | Engine de plugins, registry, marketplace, cliente MCP |
| `skills` | `registry.ts`, `forge.ts`, `improver.ts`, `evaluator.ts`, `loader.ts` | Registry de skills, creación automática, mejora continua, A/B testing |
| `storage` | `database.ts`, `sqlite.ts`, `migrations/` | Adaptador SQLite con better-sqlite3, migraciones versionadas |
| `tools` | `registry.ts`, `executor.ts`, `filesystem.ts`, `shell.ts`, `browser.ts` | Registry de herramientas, ejecutor con sandboxing, automatización browser |
| `transport` | `server.ts`, `client.ts`, `protocol.ts` | Servidor HTTP + WebSocket, cliente, protocolo de mensajes |
| `utils` | `logger.ts`, `helpers.ts`, `crypto.ts`, `benchmark.ts`, `security.ts` | Logging estructurado, encriptación AES-256, hashing bcrypt, benchmarks |

## Proveedores de IA

Cada proveedor extiende `BaseLLMProvider` con `chat()` y `chatStream()`:

| Proveedor | Clase | Razonamiento | Parámetro |
|-----------|-------|-------------|-----------|
| OpenAI | `OpenAIProvider` | o-series: `reasoning.effort` + `summary` | `providers/openai.ts` |
| Anthropic | `AnthropicProvider` | `thinking.type` + `budget_tokens` | `providers/anthropic.ts` |
| Google | `GoogleProvider` | `thinkingConfig.thinkingBudget` | `providers/google.ts` |
| Z.ai | `ZhipuProvider` | `thinking.type` (enabled/disabled) | `providers/zhipu.ts` |
| DeepSeek | `OpenAICompatibleProvider` | Automático (deepseek-reasoner) | `providers/openai-compatible.ts` |
| Mistral | `OpenAICompatibleProvider` | `prompt_mode: "reasoning"` | `providers/openai-compatible.ts` |
| xAI | `OpenAICompatibleProvider` | `reasoning_effort: "low"\|"high"` | `providers/openai-compatible.ts` |
| Cohere | `CohereProvider` | reasoning_tokens en meta | `providers/cohere.ts` |
| OpenRouter | `OpenAICompatibleProvider` | Passthrough | `providers/openai-compatible.ts` |
| Ollama | `OllamaProvider` | N/A (local) | `providers/ollama.ts` |

## Flujo de Datos

```
Entrada del Usuario
       ↓
  Canal (CLI/WebSocket/Discord/...)
       ↓
  Agent Runtime
       ├── Memory Retrieval (STM + LTM) → Contexto relevante
       ├── Skill Loader → Carga skills relevantes (progressive loading)
       ├── LLM Router → Selecciona proveedor (default → fallback)
       │       ↓
       │   AI Provider (ej: Z.ai GLM-5.1)
       │       ├── Reasoning/Thinking (si habilitado)
       │       ├── Tool Calls (si solicita herramientas)
       │       └── Response
       ↓
  Memory Consolidation (STM → LTM)
       ├── Extrae hechos (facts)
       ├── Extrae eventos (events)
       ├── Extrae procedimientos (procedures)
       └── Construye asociaciones (knowledge graph)
       ↓
  Respuesta → Canal → Usuario
```

## Tecnologías

| Tecnología | Uso |
|-----------|-----|
| TypeScript 5.8 | Lenguaje principal, strict mode |
| Node.js 22 | Runtime (ESM) |
| pnpm 10 + Turborepo | Monorepo y build |
| better-sqlite3 | Base de datos SQLite (bindings nativos C++) |
| TypeBox | Schema de configuración validado en runtime |
| Commander.js | CLI framework |
| Ink (React) | TUI del CLI |
| Vite + React | Dashboard web |
| Electron | App desktop |
| Vitest | Testing (130 tests) |
