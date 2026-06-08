# Agente Autónomo, Workflows y Automatizaciones

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Octopus AI ya no se limita a responder mensajes aislados. El runtime actual incorpora servicios persistentes, automatizaciones por cron, workflows recuperables y herramientas para coordinar agentes o ejecutar trabajo de forma segura en segundo plano.

---

## Componentes Principales

| Componente | Archivo | Rol |
|---|---|---|
| `AgentRuntime` | `packages/core/src/agent/runtime.ts` | Orquesta memoria, skills, tools, streaming y estados de ejecución |
| `AgentCoordinationBus` | `packages/core/src/agent/agent-coordination-bus.ts` | Mensajería directa, broadcasts e inbox entre agentes/workers |
| `WorkflowManager` | `packages/core/src/agent/workflow-manager.ts` | Persiste workflows, subtareas, attempts, artifacts y eventos |
| `WorkflowScheduler` | `packages/core/src/agent/workflow-scheduler.ts` | Ejecuta ticks, recovery/resume, retry y cancelación |
| `SubtaskTracker` | `packages/core/src/agent/subtask-tracker.ts` | Registra progreso granular, dependencias y estado de subtareas |
| `RetryPolicy` | `packages/core/src/agent/retry-policy.ts` | Limita reintentos sin progreso y bloquea loops estancados |
| `ArtifactVerifier` | `packages/core/src/agent/artifact-verifier.ts` | Comprueba entregables antes de cerrar subtareas |
| `CrossReviewEngine` | `packages/core/src/agent/cross-review-engine.ts` | Coordina revisión cruzada entre workers especializados |
| `ReconciliationService` | `packages/core/src/agent/reconciliation-service.ts` | Fusiona resultados parciales y resuelve discrepancias |
| `HeartbeatDaemon` | `packages/core/src/agent/heartbeat.ts` | Evalúa una checklist periódica con un LLM y decide si hace falta actuar |
| `ReflectionEngine` | `packages/core/src/agent/reflection.ts` | Autoevalúa tareas complejas y extrae patrones reutilizables para skills |
| `OctopusDaemon` | `packages/core/src/agent/daemon.ts` | Coordina heartbeat, automatizaciones, canales, health checks y apagado ordenado |
| `AutomationRunner` | `packages/core/src/tasks/cron-runner.ts` | Registra automatizaciones persistidas y dispara prompts del agente en cada cron |

---

## Flujo de Automatización

```text
Usuario o tool schedule_task
          ↓
AutomationManager persiste el cron
          ↓
AutomationRunner registra el job
          ↓
Se dispara el trigger
          ↓
Se inyecta un prompt [SYSTEM TRIGGER] al AgentRuntime
          ↓
Memoria + skills + tools + modelo
          ↓
Resultado + consolidación + resumen diario
```

Las automatizaciones actuales se ejecutan como prompts del agente (`actionType: "agent_prompt"`), por lo que reutilizan el mismo pipeline de memoria, tools y consolidación que una conversación normal.

---

## Workflows Persistentes

Los trabajos largos se representan como workflows persistidos. Cada workflow puede contener subtareas, intentos, artifacts, eventos, dependencias y decisiones de recuperación.

| Estado | Significado |
|---|---|
| `ready` | Listo para ser ejecutado por el scheduler |
| `running` | Hay subtareas o workers activos |
| `blocked` | No puede avanzar por dependencia, error repetido o falta de progreso |
| `failed` | Terminó sin completar el objetivo |
| `interrupted` | El proceso se detuvo antes de cerrar el workflow |
| `partial` | Hay resultados útiles, pero incompletos |
| `done` | Todas las subtareas requeridas se completaron y verificaron |
| `cancelled` | Cancelado manualmente por API o UI |

`WorkflowScheduler.tick()` inspecciona workflows recuperables, reanuda los que quedaron `interrupted`, ejecuta subtareas `ready`, aplica retry/cancel y registra eventos para observabilidad. El recovery se puede invocar manualmente desde `POST /api/workflows/recover`.

### Política de reintentos

`RetryPolicy` registra `step_key`, `progress_signature`, número de intentos y `stagnant_attempt_count`. Si un paso repite la misma firma de progreso sin producir artifacts nuevos, el workflow se bloquea en lugar de consumir recursos indefinidamente.

---

## Tools Relacionadas

| Tool | Descripción |
|---|---|
| `schedule_task` | Crea una automatización recurrente con expresión cron |
| `list_tasks` | Lista tareas automáticas persistidas |
| `delegate_task` | Envía una subtarea aislada a un worker especializado |
| `agent_spawn_subagent` | Crea o selecciona un worker especializado para una subtarea |
| `agent_send_message` | Envía mensajes directos o broadcasts por el bus de coordinación |
| `agent_list_messages` | Lee mensajes pendientes para un agente o rol |
| `agent_mark_messages_read` | Marca mensajes como leídos para evitar reprocesamiento |
| `sandbox_execute` | Ejecuta comandos en un contenedor Docker aislado |
| `browser_*` | Navegación, lectura, captura e interacción con páginas web |

Estas tools se suman al conjunto base de filesystem, shell, code execution, media y tools dinámicas cargadas desde `~/.octopus/tools/`.

---

## Ejecución Proactiva

`HeartbeatDaemon` no dispara acciones ciegamente. En cada pulso:

1. Lee los items habilitados del checklist.
2. Pide al LLM una evaluación estructurada.
3. Decide si alguna acción es necesaria ahora.
4. Registra la decisión y ejecuta el callback asociado si existe.

Esto lo diferencia de un cron tradicional: el trigger es periódico, pero la decisión sigue siendo contextual e inteligente.

---

## Aprendizaje y Mejora

`ReflectionEngine` cierra el bucle de aprendizaje después de tareas suficientemente complejas:

1. Evalúa cumplimiento del objetivo, eficiencia y calidad.
2. Detecta fortalezas, debilidades y patrones reutilizables.
3. Genera insumos para crear o mejorar skills.

Con esto, la automatización no solo ejecuta tareas; también deja rastros útiles para futuras interacciones y mejora de habilidades.

---

## Estado y Observabilidad

El servidor HTTP expone recursos útiles para operar este subsistema:

- `/api/tasks`
- `/api/tasks/stats`
- `/api/workflows`
- `/api/workflows/{id}`
- `/api/workflows/recover`
- `/api/workflows/{id}/retry`
- `/api/workflows/{id}/cancel`
- `/api/automations`
- `/api/agents`
- `/api/agents/messages`
- `/api/agents/{id}/messages`
- `/api/channels`
- `/api/status`

El streaming del agente tambien emite estados de UI como `thinking`, `tool`, `tool_done` y `tool_error`, que el dashboard usa para mostrar progreso en tiempo real. La vista de tareas/workflows puede mostrar progreso, subtareas, artifacts, estados recuperables y acciones de reintento, cancelación o recovery.

---

## Despliegue con Docker

La imagen y el `docker-compose.yml` actuales estan preparados para operacion continua:

- servicio unico `octopus`
- puerto `18789` para UI web, HTTP API, WebSocket y *healthcheck*
- volumen persistente en `/data`
- workspace montado en `/data/workspace`
- plantillas base `SOUL.md` y `HEARTBEAT.md`
- runtime completo dentro del contenedor: Python, Build Tools, Chromium, ffmpeg, fonts, curl y tini

Esas plantillas sirven como punto de partida para personalizar personalidad, reglas y checklist operativa del asistente en despliegues autoalojados.
