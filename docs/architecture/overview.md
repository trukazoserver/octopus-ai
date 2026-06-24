# Arquitectura

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Octopus AI es un monorepo pnpm con Turborepo que agrupa el runtime del agente, las interfaces de usuario, la capa HTTP/WebSocket y el despliegue Docker alrededor de un mismo core TypeScript.

## Estructura de Paquetes

```text
octopus-ai/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── ai/              # Router LLM, proveedores, tokenizer
│   │       ├── agent/           # Runtime, coordinación, workflows, recovery, heartbeat
│   │       ├── auth/            # OAuth, browser auth, Vertex y tokens de proveedores
│   │       ├── channels/        # Integraciones de mensajería
│   │       ├── config/          # Loader, schema, defaults, env manager, SOUL parser
│   │       ├── memory/          # STM, LTM, orquestación, integridad, daily memory, perfil
│   │       ├── learning/        # Experiencias, insights, feedback y auto-mejora
│   │       ├── plugins/         # Engine, registry, marketplace, MCP
│   │       ├── skills/          # Registry, loader, forge, improver, evaluator
│   │       ├── storage/         # SQLite y adaptadores de base de datos
│   │       ├── tasks/           # Tareas, cron, automations, webhooks
│   │       ├── team/            # Delegación y permisos multi-agente
│   │       ├── tools/           # Registry, executor, browser, sandbox, media
│   │       ├── transport/       # HTTP + WebSocket + API administrativa
│   │       ├── utils/           # Logger, métricas, crypto, helpers
│   │       └── voice/           # TTS, STT, wake word
│   ├── cli/                     # CLI interactivo y bootstrap del sistema
│   ├── desktop/                 # App desktop (Electron)
│   ├── web/                     # Dashboard web (Vite + React)
│   └── plugins/                 # Plugins oficiales
├── docs/                        # Guías y referencia
└── docker/                      # Dockerfile, compose y plantillas de despliegue
```

## Módulos Core

| Módulo | Archivos principales | Descripción |
|---|---|---|
| `ai` | `router.ts`, `providers/*.ts`, `model-capabilities.ts`, `usage-store.ts`, `quota-service.ts` | Router con múltiples proveedores, razonamiento, capacidades por modelo, ledger de uso persistente y captura de cuotas |
| `agent` | `runtime.ts`, `orchestrator.ts`, `manager.ts`, `workflow-manager.ts`, `workflow-scheduler.ts`, `agent-coordination-bus.ts` | Ejecución conversacional, coordinación multi-agente, workflows persistentes, recovery, autoevaluación, reconfiguración en vivo de modelo/razonamiento y operación continua |
| `auth` | `oauth.ts`, `browser-auth.ts`, `jwt.ts`, `google-vertex.ts` | Autenticación de proveedores con API key, bearer, OAuth, sesiones de navegador y Google Vertex |
| `memory` | `stm.ts`, `ltm.ts`, `orchestrator.ts`, `integrity.ts`, `context-assembler.ts`, `daily.ts`, `user-profile.ts` | Contexto activo, memoria persistente, validación, evidencia, scopes, recuperación híbrida, resumen diario y perfil del usuario |
| `learning` | `engine.ts`, `types.ts` | Registra experiencias, extrae aprendizajes reutilizables y los reinyecta como guia operacional |
| `skills` | `loader.ts`, `forge.ts`, `improver.ts`, `evaluator.ts` | Carga progresiva, creación y mejora continua de skills |
| `tools` | `registry.ts`, `executor.ts`, `browser.ts`, `sandbox-tool.ts`, `media.ts`, `agent-comms.ts`, `agent-spawn.ts`, `rate-limiter.ts` | Catálogo de tools del agente, ejecución, browser automation, sandbox, media, comunicación/spawn de agentes y rate limiting |
| `tasks` | `manager.ts`, `automation-manager.ts`, `cron-runner.ts`, `webhooks.ts` | Tareas del workspace, automatizaciones y disparadores programados |
| `team` | `delegation.ts`, `permissions.ts` | Delegación a workers especializados y control de permisos |
| `transport` | `server.ts`, `client.ts`, `protocol.ts` | API HTTP/WebSocket, streaming, gestión de media y endpoints del dashboard |
| `channels` | `telegram/`, `manager.ts` | Canales de mensajería externos con memoria compartida |
| `config` | `loader.ts`, `defaults.ts`, `schema.ts`, `env-manager.ts` | Configuración persistente, validación y variables gestionadas |
| `storage` | `database.ts`, `sqlite.ts`, `migrations/` | Persistencia local del sistema |

## Flujo Principal

```text
Entrada del usuario o trigger del sistema
                ↓
        Canal / WebSocket / API HTTP
                ↓
            AgentRuntime
                 ├── User Profile + Daily Memory
        ├── Context Assembler + Memory Orchestrator
        │      ├── STM + LTM scoped retrieval
        │      ├── integridad, evidencia y confianza
        │      ├── recordatorios prospectivos
        │      └── incertidumbre y known gaps
        ├── Workflow Manager + Subtask Tracker
        │      ├── subtasks, attempts y artifacts persistidos
        │      ├── retry policy y recovery/resume
        │      └── cross-review + reconciliation
        ├── Agent Coordination Bus
        ├── Skill Loader
                ├── LLM Router
                └── Tool Executor
                       ├── filesystem / shell / code
                       ├── browser / media
                       ├── sandbox / agent spawn / agent comms
                       └── automations
                ↓
         Respuesta y eventos de estado
                ↓
   Consolidación + perfil + resumen diario + aprendizaje + workflow events + feedback de memoria
                ↓
            Persistencia en SQLite
```

## Ciclo de Auto-Mejora

Octopus registra cada trabajo como una experiencia con solicitud, respuesta final, tools usadas, skills cargadas, resultado estimado y confianza. A partir de esas experiencias extrae aprendizajes accionables:

- procedimientos que funcionaron
- estrategias de tools útiles
- antipatrones y fallos a evitar
- candidatos para nuevas skills

Los aprendizajes de alta confianza se guardan también como memoria procedural y se recuperan en tareas similares dentro de `Learned Operating Guidance`. Las llamadas de aprendizaje son best-effort: si fallan, no interrumpen la respuesta al usuario.

## Servicios Autónomos

| Servicio | Qué hace |
|---|---|
| `HeartbeatDaemon` | Evalúa una checklist periódica con el LLM y decide si actuar o permanecer en silencio |
| `AutomationRunner` | Registra jobs cron persistidos y lanza prompts del agente sin intervención humana |
| `ReflectionEngine` | Revisa tareas complejas y detecta patrones reutilizables para skills |
| `LearningEngine` | Convierte trabajos exitosos o fallidos en procedimientos, antipatrones y métricas de skills |
| `AgentCoordinationBus` | Registra mensajes directos, broadcasts e inbox entre agentes y workers |
| `WorkflowManager` | Persiste runs, subtareas, attempts, artifacts y eventos para trabajos largos |
| `WorkflowScheduler` | Reanuda workflows recuperables, ejecuta ticks y aplica retry/cancel |
| `SubtaskTracker` | Mantiene estado granular de subtareas, dependencias y progreso |
| `ArtifactVerifier` | Verifica entregables antes de cerrar subtareas o workflows |
| `CrossReviewEngine` | Solicita revisión cruzada entre workers especializados |
| `ReconciliationService` | Fusiona resultados parciales y resuelve discrepancias entre agentes |
| `RetryPolicy` | Evita loops sin progreso mediante step keys, firmas de progreso y límites de estancamiento |
| `OctopusDaemon` | Coordina heartbeat, automatizaciones, canales y health checks como proceso de larga vida |

## Capa HTTP/WebSocket

El servidor de transporte expone la API usada por el dashboard y por integraciones locales:

- salud y estado del sistema
- auth de proveedores, configuración, memoria y aprendizaje continuo
- skills, tools dinámicas y ejecución de código
- conversaciones, agentes, mensajes entre agentes, tareas, workflows y automatizaciones
- variables de entorno, MCP, canales y biblioteca multimedia

Referencia completa: [API HTTP y WebSocket](../api/http.md)

## Modelo, Razonamiento, Uso y Cuotas

El agente es la **fuente de verdad** de su modelo y nivel de razonamiento (no la configuración global):

- `ChatExecutionManager` ejecuta el runtime del agente seleccionado (`getRuntime(agentId) ?? agentRuntime`), con fallback al agente principal (Octavio).
- Al arrancar, el runtime de Octavio toma su modelo de la fila `agents.model`; cada agente carga su perfil de razonamiento por modelo desde `agent_model_profiles` (migración 018).
- `AgentRuntime.updateConfig()` reconfigura modelo/razonamiento en vivo sin reconstruir el runtime; `PUT /api/agents/{id}` lo invoca y persiste el perfil, validando el esfuerzo contra `model-capabilities.ts` (`supportsReasoning`, `allowedReasoningEfforts`). El cambio queda sincronizado entre chat, página de agentes y centro de control.
- El uso de tokens/costo se persiste en `ai_usage_events` (migración 018) vía `UsageStore`, conectado al router como `UsageSink`; cada `LLMRequest` lleva `metadata` (`agentId`, `conversationId`, `requestId`) para atribución. `/api/usage` sirve totales y desglose por proveedor/agente.
- `quota-service.ts` expone cuotas reales: Codex captura las cabeceras `x-codex-*` de cada `/responses` (`onResponseHeaders` en `BaseLLMProvider`) y las persiste en `provider_quota_cache` (migración 019); Zhipu/Z.ai se consulta en vivo del endpoint monitor. `/api/quotas` devuelve solo proveedores configurados, saneando errores y sin exponer secretos.

## Memoria y Contexto Avanzado

El runtime usa dos rutas complementarias de memoria:

- La ruta legacy `MemoryRetrieval` mantiene compatibilidad con STM/LTM y recuperación ponderada por relevancia, recencia y frecuencia.
- La ruta avanzada `ContextAssembler` usa `MemoryOrchestrator` para recuperar memorias filtradas por tenant, usuario, proyecto, rol, rango temporal y nivel mínimo de confianza.

La memoria avanzada persiste evidencia, usage, coverage, versiones y relaciones semánticas. Las memorias inactivas (`expired`, `superseded`, `user_deleted`) se ocultan de búsqueda vectorial, FTS, listados recientes y UI. El runtime expone trazas de memoria para explicar qué recuerdos influyeron en una respuesta.

La capa de conocimiento (`KnowledgeManager` y `KnowledgeExtractor`) añade colecciones, items y chunks buscables para texto, media y archivos. Se expone por `/api/memory/knowledge/*` y comparte los controles de seguridad de memoria.

Detalle completo: [Orquestación de Memoria](./memory-orchestration.md)

## Tecnologías

| Tecnología | Uso |
|---|---|
| TypeScript 5.8 | Lenguaje principal |
| Node.js 22 | Runtime |
| pnpm 10 + Turborepo | Monorepo y build |
| SQLite | Persistencia local |
| Commander.js | CLI |
| Ink | Interfaz TUI del CLI |
| Vite + React | Dashboard web |
| Electron | App desktop |
| Vitest | Testing |
