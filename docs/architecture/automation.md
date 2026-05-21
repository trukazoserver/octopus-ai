# Agente Autónomo y Automatizaciones

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Octopus AI ya no se limita a responder mensajes aislados. El runtime actual incorpora servicios persistentes, automatizaciones por cron y herramientas para delegar o ejecutar trabajo de forma segura en segundo plano.

---

## Componentes Principales

| Componente | Archivo | Rol |
|---|---|---|
| `AgentRuntime` | `packages/core/src/agent/runtime.ts` | Orquesta memoria, skills, tools, streaming y estados de ejecución |
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

## Tools Relacionadas

| Tool | Descripción |
|---|---|
| `schedule_task` | Crea una automatización recurrente con expresión cron |
| `list_tasks` | Lista tareas automáticas persistidas |
| `delegate_task` | Envía una subtarea aislada a un worker especializado |
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
- `/api/automations`
- `/api/agents`
- `/api/channels`
- `/api/status`

El streaming del agente tambien emite estados de UI como `thinking`, `tool`, `tool_done` y `tool_error`, que el dashboard usa para mostrar progreso en tiempo real.

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
