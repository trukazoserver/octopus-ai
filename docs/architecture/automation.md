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

### Kanban Swarm

Para objetivos complejos, Octavio puede crear un workflow Kanban Swarm con `kanban_create_plan_from_goal` o `POST /api/kanban/plan`. Cada card reutiliza `agent_workflow_tasks` y declara `requires`/`produces` por artifact concreto, sin imponer barreras globales entre fases. `image_video_1 -> video_1` es solo un ejemplo; el mismo patrón aplica a `research_report_1 -> report_1`, `spec_module_2 -> implementation_module_2`, `dataset_3 -> analysis_3`, `test_plan_4 -> qa_result_4` o cualquier otro artifact tipado del dominio.

`KanbanDispatcher.tick()` ejecuta el ciclo operativo del tablero:

1. Expira leases vencidos y devuelve cards estancadas a estado recuperable.
2. Evalúa requirements pendientes contra artifacts verificados.
3. Desbloquea solo las cards cuyos requisitos concretos están satisfechos.
4. Reclama cards `ready` respetando límites de concurrencia globales y por brazo.
5. Lanza el executor configurado para el brazo o deja la card en `ready` si no hay executor.

Las cards pueden registrar comentarios persistentes, blockers, leases y artifacts verificados. Las acciones de review permiten aprobar, rechazar con feedback, comentar, bloquear, desbloquear o reintentar desde API o dashboard.

Cada card expone contexto operativo con `GET /api/kanban/tasks/{id}/context`, que devuelve requisitos faltantes, artifacts relacionados, blockers, comentarios y leases para depurar por qué una card espera, está bloqueada o requiere revisión.

El snapshot de workflow incluye `dependencyEdges`, una lista de aristas `producer -> consumer` derivadas de `requires`/`produces`. Esto permite visualizar el DAG del swarm para cualquier dominio sin asumir media: artifacts de investigación, especificaciones, implementaciones, datasets, análisis, documentos, QA o videos se tratan igual. Los requirements de artifact respetan `min_count`, por lo que una card puede exigir múltiples evidencias verificadas del mismo tipo/key antes de desbloquearse.

Los requirements manuales pueden operarse desde API o dashboard: `POST /api/kanban/requirements/{id}/satisfy` marca el requisito como satisfecho y puede desbloquear la card; `POST /api/kanban/requirements/{id}/reset` lo devuelve a pendiente y limpia la evidencia previa.

El dispatcher puede pausarse con `POST /api/kanban/dispatcher/pause` para impedir nuevos claims sin cancelar cards activas ni modificar workflows persistidos. `POST /api/kanban/dispatcher/resume` vuelve a habilitar los ticks automáticos o manuales. Este estado se guarda en `kanban_dispatcher_state`, por lo que sobrevive reinicios del proceso.

Flujo operativo recomendado:

1. Crear el swarm desde Octavio, dashboard o `POST /api/kanban/plan` con un objetivo natural o un plan estructurado.
2. Revisar `dependencyEdges` para confirmar que las dependencias son específicas por artifact y no barreras globales.
3. Usar `POST /api/kanban/dispatcher/tick` o esperar el tick periódico para reclamar cards `ready`.
4. Abrir el contexto de una card si queda esperando: revisar requirements, artifacts relacionados, blockers, comentarios y leases.
5. Para gates humanos, usar `POST /api/kanban/requirements/{id}/satisfy` o `reset`.
6. Si hay riesgo operativo, pausar con `POST /api/kanban/dispatcher/pause`; reanudar cuando el tablero esté listo.
7. Cerrar solo con artifacts verificados; si una dependencia se resetea, la card y el run se reabren automáticamente.

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
- `/api/kanban/dispatcher/status`
- `/api/kanban/dispatcher/tick`
- `/api/kanban/dispatcher/pause`
- `/api/kanban/dispatcher/resume`
- `/api/kanban/plan`
- `/api/kanban/runs/{id}`
- `/api/kanban/runs/{id}/board`
- `/api/kanban/workers/active`
- `/api/kanban/blackboard`
- `/api/kanban/inspect`
- `/api/kanban/tasks/{id}/approve`
- `/api/kanban/tasks/{id}/reject`
- `/api/kanban/tasks/{id}/context`
- `/api/kanban/tasks/{id}/comment`
- `/api/kanban/tasks/{id}/block`
- `/api/kanban/tasks/{id}/unblock`
- `/api/kanban/tasks/{id}/retry`
- `/api/kanban/requirements/{id}/satisfy`
- `/api/kanban/requirements/{id}/reset`
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
