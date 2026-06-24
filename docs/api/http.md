# API HTTP y WebSocket

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="90" />
</p>

La orden `start` levanta un servidor HTTP/WebSocket usado por el dashboard web, las integraciones y la administracion local del sistema.

---

## Base URL

- Servidor local estable: `http://localhost:18789`
- Docker Compose: `http://localhost:18789`
- Desarrollo frontend Vite: `http://localhost:3000` solo sirve la UI y se conecta al backend en `18789`

> Los endpoints sensibles son libres en loopback si no configuras una clave. Si el servidor escucha en un host no-loopback, deben autenticarse con `security.memoryApiKey`, `OCTOPUS_MEMORY_API_KEY` u `OCTOPUS_API_KEY`.

---

## Seguridad de API

Las rutas de configuración, memoria, aprendizaje, skills, tasks, workflows, automatizaciones, canales, MCP y variables de entorno se consideran sensibles. Cuando hay clave configurada, envíala en cualquiera de estos headers:

```bash
curl http://localhost:18789/api/memory/stats \
  -H "X-Octopus-Api-Key: $OCTOPUS_API_KEY"

curl http://localhost:18789/api/workflows \
  -H "Authorization: Bearer $OCTOPUS_API_KEY"
```

Precedencia de clave esperada:

1. `security.memoryApiKey` en `~/.octopus/config.json`.
2. `OCTOPUS_MEMORY_API_KEY`.
3. `OCTOPUS_API_KEY`.

Si expones el dashboard o API fuera de tu red de confianza, usa además reverse proxy, TLS, VPN o reglas de firewall.

---

## Salud y Estado

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/health` | Healthcheck simple |
| `GET` | `/api/health` | Alias del healthcheck |
| `GET` | `/api/status` | Estado general del sistema |
| `GET` | `/api/models` | Modelos disponibles por proveedor + capacidades de razonamiento |
| `GET` | `/api/usage` | Uso persistido de tokens/costo (totales, por proveedor y por agente) |
| `GET` | `/api/quotas` | Cuotas de plan (Codex 5h/semanal y Zhipu/Z.ai Coding Plan) |

`GET /api/status` ahora incluye un campo `agent` con el modelo, proveedor y nivel de razonamiento **efectivo** del agente principal (Octavio), ademas de los alias de compatibilidad `provider`, `model` y `thinking`:

```json
{
  "agent": {
    "id": "default-agent",
    "name": "Octavio",
    "model": "gpt-5.5",
    "provider": "openai",
    "providerDisplayName": "OpenAI",
    "reasoningEffort": "high"
  },
  "provider": "openai",
  "model": "gpt-5.5",
  "thinking": "high",
  "usage": { "totalTokens": 12345, "totalCost": 0.42, "byProvider": { ... } }
}
```

`GET /api/models` devuelve `providers` (lista de modelos por proveedor, sin romper compatibilidad) y `modelCapabilities` con `supportsReasoning`, `allowedReasoningEfforts` y `defaultReasoningEffort` por modelo, para que los selectores de la UI muestren u oculten el control de razonamiento segun el modelo elegido.

`GET /api/usage` lee del ledger persistente `ai_usage_events` (sobrevive reinicios). Acepta filtros opcionales `from`, `to`, `agentId`, `provider` y devuelve `total` (agregado), `byProvider` y `byAgent`.

`GET /api/quotas` devuelve solo los proveedores con cuota configurable:

- **Codex (OpenAI en modo `authMode: codex`)**: ventanas de 5 horas y semanal con `% usado` y fecha de reset, capturadas de las cabeceras `x-codex-*` de cada llamada real a `/responses` (no hay endpoint de uso dedicado). El ultimo valor se persiste en `provider_quota_cache` para sobrevivir reinicios.
- **Zhipu / Z.ai (modo `coding-*`)**: ventanas MCP mensual y de 5 horas, consultadas en vivo del endpoint monitor `api.z.ai/api/monitor/usage/quota/limit` (mismo metodo que los plugins de OpenCode). `Authorization: {key}` sin prefijo `Bearer`.

Ejemplo:

```bash
curl http://localhost:18789/health
curl "http://localhost:18789/api/usage?provider=openai"
curl http://localhost:18789/api/quotas
```

---

## Configuracion

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/config` | Devuelve la configuracion completa enmascarando secretos |
| `GET` | `/api/config/{path}` | Lee una clave concreta, por ejemplo `server.port` |
| `PUT` | `/api/config/{path}` | Actualiza una clave concreta |

Ejemplo:

```bash
curl http://localhost:18789/api/config/server.port
```

---

## Autenticacion de Proveedores

Estas rutas ayudan al dashboard a configurar credenciales de proveedores sin editar JSON manualmente.

| Metodo | Ruta | Uso |
|---|---|---|
| `POST` | `/api/auth/{provider}/start` | Inicia OAuth para `google`, `openai`, `anthropic`, `deepseek` o `xai` |
| `GET` | `/api/auth/{provider}/callback` | Callback OAuth usado por el navegador |
| `POST` | `/api/auth/{provider}/refresh` | Refresca tokens OAuth guardados |
| `POST` | `/api/auth/{provider}/browser-start` | Inicia captura asistida de sesión de navegador |
| `GET` | `/api/auth/{provider}/browser-status` | Consulta el estado de la captura browser auth |
| `POST` | `/api/auth/{provider}/browser-result` | Guarda cookies/token de browser auth |
| `POST` | `/api/auth/google/vertex-setup` | Configura Google Vertex con service account, proyecto y región |

`{provider}` acepta `google`, `openai`, `anthropic`, `deepseek` y `xai` según la ruta.

---

## Memoria

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/memory/stats` | Estadisticas generales |
| `GET` | `/api/memory/config` | Configuracion de memoria |
| `GET` | `/api/memory/search?q=texto` | Busca recuerdos |
| `POST` | `/api/memory/context/retrieve` | Recupera contexto avanzado con scopes, presupuesto e incertidumbre |
| `POST` | `/api/memory/create` | Crea una memoria avanzada con evidencia |
| `POST` | `/api/memory/feedback` | Registra feedback sobre una memoria usada |
| `POST` | `/api/memory/forget` | Solicita forgetting o borrado logico de memorias |
| `POST` | `/api/memory/backfill` | Ejecuta backfill de memoria avanzada |
| `POST` | `/api/memory/retention/run` | Aplica retención, expiración y limpieza activa |
| `GET` | `/api/memory/sources` | Lista fuentes/evidencia disponibles |
| `GET` | `/api/memory/graph` | Devuelve grafo de memoria para la UI |
| `POST` | `/api/memory/graph/traverse` | Recorre conexiones del grafo desde uno o varios nodos |
| `GET` | `/api/memory/audit` | Auditoría de uso, evidencia, versiones y relaciones |
| `GET` | `/api/memory/audit/integrity` | Auditoría de redacciones/bloqueos de integridad |
| `GET` | `/api/memory/actions` | Acciones recomendadas o pendientes sobre memoria |
| `GET` | `/api/memory/verify?id=...` | Verifica una memoria concreta |
| `POST` | `/api/memory/verify` | Verifica varias memorias o artifacts de memoria |
| `POST` | `/api/memory/consolidate` | Fuerza consolidacion STM -> LTM |
| `GET` | `/api/memory/stm` | Inspeccion de memoria a corto plazo |
| `GET` | `/api/memory/daily` | Resumen diario global y actividad no resumida |
| `GET` | `/api/memory/profile` | Perfil persistente del usuario |
| `PUT` | `/api/memory/profile` | Ajusta manualmente el perfil |
| `GET` | `/api/memory/ltm/recent` | Memorias recientes de largo plazo |

Ejemplo:

```bash
curl "http://localhost:18789/api/memory/search?q=proyecto"
```

### Knowledge Base

La base de conocimiento se integra bajo `/api/memory/knowledge` para indexar colecciones, textos, media y archivos.

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/memory/knowledge/collections` | Lista colecciones de conocimiento |
| `POST` | `/api/memory/knowledge/collections` | Crea una coleccion |
| `GET` | `/api/memory/knowledge/collections/{id}` | Devuelve colección e items asociados |
| `DELETE` | `/api/memory/knowledge/collections/{id}` | Elimina una colección |
| `GET` | `/api/memory/knowledge/items` | Lista items, opcionalmente por `collectionId` |
| `POST` | `/api/memory/knowledge/items/text` | Crea un item desde texto directo |
| `POST` | `/api/memory/knowledge/items/media` | Crea un item desde media ya registrada |
| `POST` | `/api/memory/knowledge/items/file` | Crea un item desde un archivo del workspace |
| `GET` | `/api/memory/knowledge/search?q=...` | Busca en chunks de conocimiento indexados |

---

## Aprendizaje Continuo

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/learning/insights` | Lista aprendizajes recientes |
| `GET` | `/api/learning/insights?limit=20&type=procedure` | Filtra insights por tipo y limite |
| `POST` | `/api/learning/feedback` | Registra feedback humano positivo o negativo |
| `DELETE` | `/api/learning/insights/{id}` | Borra un aprendizaje incorrecto |

Tipos de insight: `procedure`, `tool_strategy`, `anti_pattern`, `what_worked`, `what_failed`, `skill_candidate`.

Ejemplo para listar aprendizajes:

```bash
curl http://localhost:18789/api/learning/insights
```

Ejemplo para corregir una experiencia:

```bash
curl -X POST http://localhost:18789/api/learning/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "conv_123",
    "rating": "negative",
    "comment": "La respuesta no resolvió la tarea"
  }'
```

Ejemplo para borrar un insight:

```bash
curl -X DELETE http://localhost:18789/api/learning/insights/learn_123
```

---

## Skills y Tools

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/skills` | Lista skills |
| `POST` | `/api/skills/create` | Crea una skill |
| `PUT` | `/api/skills/{name}` | Actualiza una skill |
| `DELETE` | `/api/skills/{name}` | Elimina una skill |
| `POST` | `/api/skills/{name}/toggle` | Activa o desactiva una skill |
| `GET` | `/api/tools/registered` | Lista todas las tools registradas |
| `GET` | `/api/code/tools` | Lista tools dinamicas creadas por codigo |
| `POST` | `/api/code/create-tool` | Crea una tool dinamica |
| `DELETE` | `/api/tools/dynamic/{name}` | Elimina una tool dinamica |
| `POST` | `/api/code/execute` | Ejecuta codigo desde la API |

---

## Workspace, Conversaciones y Agentes

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/workspace/{path}` | Lee archivos del workspace |
| `PUT` | `/api/workspace/{path}` | Escribe archivos del workspace |
| `GET` | `/api/conversations` | Lista conversaciones |
| `POST` | `/api/conversations` | Crea conversacion |
| `GET` | `/api/conversations/{id}` | Recupera una conversacion |
| `PATCH` | `/api/conversations/{id}` | Actualiza metadatos |
| `DELETE` | `/api/conversations/{id}` | Elimina conversacion |
| `GET` | `/api/agents` | Lista agentes (con `effectiveModel`, `reasoningEffort` y `capabilities`) |
| `POST` | `/api/agents` | Crea agente |
| `GET` | `/api/agents/{id}` | Consulta un agente (enriquecido) |
| `PUT` | `/api/agents/{id}` | Actualiza un agente (`model`, `reasoningEffort`, ...) y refresca el runtime en vivo |
| `DELETE` | `/api/agents/{id}` | Elimina un agente |
| `POST` | `/api/agents/messages` | Envía mensaje directo, broadcast o coordinación entre agentes |
| `GET` | `/api/agents/{id}/messages` | Lista inbox/mensajes de un agente |
| `POST` | `/api/agents/{id}/messages/read` | Marca mensajes como leídos |

Cada agente es ahora la **fuente de verdad** de su modelo y nivel de razonamiento. `PUT /api/agents/{id}` acepta `model` y `reasoningEffort` (validado contra las capacidades del modelo), persiste el perfil de razonamiento por `(agent, model)` en `agent_model_profiles`, reconfigura el runtime en vivo con `AgentRuntime.updateConfig(...)` y devuelve el agente actualizado junto con `effectiveModel` y `effectiveReasoning`. Si el agente es el principal (Octavio), el cambio tambien se refleja en `config.ai.default` / `config.ai.thinking` por compatibilidad. Cambiar modelo o razonamiento desde el chat, la pagina de agentes o los ajustes queda sincronizado en los tres.

---

## Tareas y Automatizaciones

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/tasks` | Lista tareas |
| `POST` | `/api/tasks` | Crea tarea |
| `GET` | `/api/tasks/stats` | Estadisticas de tareas |
| `GET` | `/api/tasks/{id}` | Consulta tarea |
| `PUT` | `/api/tasks/{id}` | Actualiza tarea |
| `DELETE` | `/api/tasks/{id}` | Elimina tarea |
| `GET` | `/api/workflows` | Lista workflows persistentes, subtareas, progreso y estado |
| `GET` | `/api/workflows/{id}` | Consulta detalle de un workflow, attempts, artifacts y eventos |
| `POST` | `/api/workflows/recover` | Reanuda workflows interrumpidos o recuperables |
| `POST` | `/api/workflows/{id}/retry` | Reintenta un workflow fallido o bloqueado |
| `POST` | `/api/workflows/{id}/cancel` | Cancela un workflow activo o pendiente |
| `GET` | `/api/kanban/dispatcher/status` | Consulta estado del dispatcher Kanban Swarm |
| `POST` | `/api/kanban/dispatcher/tick` | Ejecuta un tick manual: expira leases, evalúa requirements y reclama cards listas |
| `POST` | `/api/kanban/dispatcher/pause` | Pausa nuevos claims del dispatcher sin cancelar workflows ni cards activas |
| `POST` | `/api/kanban/dispatcher/resume` | Reanuda nuevos claims del dispatcher |
| `POST` | `/api/kanban/plan` | Crea un workflow Kanban Swarm desde `goal` natural o desde `tasks` estructuradas |
| `GET` | `/api/kanban/runs/{id}` | Consulta snapshot Kanban de un workflow con tasks, requirements, leases, blockers, comments y metrics |
| `GET` | `/api/kanban/runs/{id}/board` | Consulta el tablero de un run agrupado por columnas y dependencias |
| `GET` | `/api/kanban/workers/active` | Lista workers activos y claims en ejecucion del dispatcher |
| `GET` | `/api/kanban/blackboard` | Lee el blackboard compartido del swarm |
| `POST` | `/api/kanban/blackboard` | Escribe valores compartidos en el blackboard del swarm |
| `GET` | `/api/kanban/inspect` | Devuelve inspeccion global del subsistema Kanban |
| `POST` | `/api/kanban/tasks/{id}/approve` | Aprueba una card en review y la marca como completada |
| `POST` | `/api/kanban/tasks/{id}/reject` | Rechaza una card en review, guarda feedback y vuelve la card a ready |
| `GET` | `/api/kanban/tasks/{id}/context` | Consulta contexto operativo de una card: requisitos faltantes, artifacts relacionados, blockers, comentarios y leases |
| `POST` | `/api/kanban/tasks/{id}/comment` | Añade comentario persistente a una card |
| `POST` | `/api/kanban/tasks/{id}/block` | Bloquea manualmente una card |
| `POST` | `/api/kanban/tasks/{id}/unblock` | Resuelve blockers abiertos y vuelve la card a ready |
| `POST` | `/api/kanban/tasks/{id}/retry` | Reintenta una card fallida, expirada o bloqueada |
| `POST` | `/api/kanban/requirements/{id}/satisfy` | Marca manualmente un requirement como satisfecho y desbloquea la card si todos sus requisitos están completos |
| `POST` | `/api/kanban/requirements/{id}/reset` | Devuelve un requirement a pendiente y retira la evidencia previa de satisfacción |
| `GET` | `/api/automations` | Lista automatizaciones |
| `POST` | `/api/automations` | Crea automatizacion |
| `GET` | `/api/automations/{id}` | Consulta automatizacion |
| `PUT` | `/api/automations/{id}` | Actualiza automatizacion |
| `POST` | `/api/automations/{id}/toggle` | Activa o pausa una automatizacion |
| `DELETE` | `/api/automations/{id}` | Elimina automatizacion |

Ejemplo minimo:

```bash
curl -X POST http://localhost:18789/api/automations \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily recap",
    "triggerType": "cron",
    "triggerConfig": {"expression": "0 8 * * *"},
    "actionType": "agent_prompt",
    "actionConfig": {"prompt": "Genera un resumen del dia"}
  }'
```

---

## Entorno, MCP, Canales y Media

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/env` | Lista variables gestionadas |
| `POST` | `/api/env` | Crea o actualiza una variable |
| `DELETE` | `/api/env/{key}` | Elimina una variable |
| `GET` | `/api/mcp/servers` | Lista servidores MCP |
| `POST` | `/api/mcp/servers` | Agrega servidor MCP |
| `PUT` | `/api/mcp/servers` | Sincroniza lista completa |
| `DELETE` | `/api/mcp/servers/{name}` | Elimina servidor MCP |
| `POST` | `/api/mcp/servers/{name}/restart` | Reinicia servidor MCP |
| `GET` | `/api/mcp/catalog` | Catalogo embebido de MCP |
| `GET` | `/api/channels` | Lista canales |
| `PUT` | `/api/channels/{name}/config` | Actualiza config de canal |
| `POST` | `/api/channels/{name}/toggle` | Activa o desactiva canal |
| `POST` | `/api/channels/telegram/test` | Prueba conexion de Telegram |
| `GET` | `/api/media` | Lista biblioteca multimedia |
| `POST` | `/api/media/upload` | Sube un archivo |
| `POST` | `/api/media/save` | Guarda media desde base64 |
| `GET` | `/api/media/file/{id}` | Sirve el archivo multimedia |
| `DELETE` | `/api/media/{id}` | Elimina media |

---

## Streaming por WebSocket

El mismo servidor de transporte mantiene conexiones WebSocket para el chat en tiempo real del dashboard. Durante una respuesta con streaming se emiten:

- fragmentos de texto
- fin de stream
- errores
- eventos de estado del agente como `thinking`, `tool`, `tool_done` y `tool_error`

Esto permite que la UI muestre progreso de razonamiento y ejecucion de tools sin bloquear la conversacion.
