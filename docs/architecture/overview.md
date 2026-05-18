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
│   │       ├── agent/           # Runtime, reflection, heartbeat, daemon
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
| `ai` | `router.ts`, `providers/*.ts` | Router con múltiples proveedores, razonamiento y cambio dinámico de provider/modelo |
| `agent` | `runtime.ts`, `reflection.ts`, `heartbeat.ts`, `daemon.ts` | Ejecución conversacional, autoevaluación, trabajo proactivo y operación continua |
| `memory` | `stm.ts`, `ltm.ts`, `orchestrator.ts`, `integrity.ts`, `context-assembler.ts`, `daily.ts`, `user-profile.ts` | Contexto activo, memoria persistente, validación, evidencia, scopes, recuperación híbrida, resumen diario y perfil del usuario |
| `learning` | `engine.ts`, `types.ts` | Registra experiencias, extrae aprendizajes reutilizables y los reinyecta como guia operacional |
| `skills` | `loader.ts`, `forge.ts`, `improver.ts`, `evaluator.ts` | Carga progresiva, creación y mejora continua de skills |
| `tools` | `registry.ts`, `executor.ts`, `browser.ts`, `sandbox-tool.ts`, `media.ts` | Catálogo de tools del agente, ejecución, browser automation, sandbox y media |
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
        ├── Skill Loader
                ├── LLM Router
                └── Tool Executor
                       ├── filesystem / shell / code
                       ├── browser / media
                       ├── sandbox / delegation
                       └── automations
                ↓
         Respuesta y eventos de estado
                ↓
   Consolidación + perfil + resumen diario + aprendizaje + feedback de memoria
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
| `OctopusDaemon` | Coordina heartbeat, automatizaciones, canales y health checks como proceso de larga vida |

## Capa HTTP/WebSocket

El servidor de transporte expone la API usada por el dashboard y por integraciones locales:

- salud y estado del sistema
- configuración, memoria y aprendizaje continuo
- skills, tools dinámicas y ejecución de código
- conversaciones, agentes, tareas y automatizaciones
- variables de entorno, MCP, canales y biblioteca multimedia

Referencia completa: [API HTTP y WebSocket](../api/http.md)

## Memoria y Contexto Avanzado

El runtime usa dos rutas complementarias de memoria:

- La ruta legacy `MemoryRetrieval` mantiene compatibilidad con STM/LTM y recuperación ponderada por relevancia, recencia y frecuencia.
- La ruta avanzada `ContextAssembler` usa `MemoryOrchestrator` para recuperar memorias filtradas por tenant, usuario, proyecto, rol, rango temporal y nivel mínimo de confianza.

La memoria avanzada persiste evidencia, usage, coverage, versiones y relaciones semánticas. Las memorias inactivas (`expired`, `superseded`, `user_deleted`) se ocultan de búsqueda vectorial, FTS, listados recientes y UI. El runtime expone trazas de memoria para explicar qué recuerdos influyeron en una respuesta.

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
