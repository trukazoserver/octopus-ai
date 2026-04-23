# API HTTP y WebSocket

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="90" />
</p>

La orden `start` levanta un servidor HTTP/WebSocket usado por el dashboard web, las integraciones y la administracion local del sistema.

---

## Base URL

- Desarrollo local: `http://localhost:18789`
- Docker Compose: `http://localhost:3000`

> La API no incorpora autenticacion por defecto. Si la expones fuera de tu maquina o red de confianza, protege el acceso con reverse proxy, VPN o reglas de red.

---

## Salud y Estado

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/health` | Healthcheck simple |
| `GET` | `/api/health` | Alias del healthcheck |
| `GET` | `/api/status` | Estado general del sistema |

Ejemplo:

```bash
curl http://localhost:18789/health
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

## Memoria

| Metodo | Ruta | Uso |
|---|---|---|
| `GET` | `/api/memory/stats` | Estadisticas generales |
| `GET` | `/api/memory/config` | Configuracion de memoria |
| `GET` | `/api/memory/search?q=texto` | Busca recuerdos |
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
| `GET` | `/api/agents` | Lista agentes |
| `POST` | `/api/agents` | Crea agente |
| `GET` | `/api/agents/{id}` | Consulta un agente |
| `PUT` | `/api/agents/{id}` | Actualiza un agente |
| `DELETE` | `/api/agents/{id}` | Elimina un agente |

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
