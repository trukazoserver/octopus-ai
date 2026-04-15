# Referencia de Comandos CLI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

## Uso General

```bash
node packages/cli/dist/index.js [comando] [opciones]
```

## Comandos Disponibles

### `setup`

Asistente de configuración inicial. Verifica requisitos, pide API keys, crea directorios e inicializa la base de datos.

```bash
node packages/cli/dist/index.js setup
```

### `start`

Inicia el servidor de Octopus AI.

```bash
node packages/cli/dist/index.js start [opciones]
```

| Opción | Descripción |
|--------|-------------|
| `--port <puerto>` | Puerto del servidor (sobreescribe config) |
| `--host <host>` | Host de escucha |
| `--transport <tipo>` | Tipo de transporte: `auto`, `stdio`, `sse`, `streamable-http` |

### `chat`

Inicia una sesión de chat interactiva.

```bash
node packages/cli/dist/index.js chat [opciones]
```

| Opción | Descripción |
|--------|-------------|
| `--model <modelo>` | Modelo a usar (ej: `zhipu/glm-5.1`) |
| `--stream` | Habilitar streaming (por defecto) |
| `--no-stream` | Deshabilitar streaming |

### `agent`

Envía un mensaje directo al agente sin sesión interactiva.

```bash
node packages/cli/dist/index.js agent [opciones]
```

| Opción | Descripción |
|--------|-------------|
| `-m, --message <mensaje>` | Mensaje a enviar (requerido) |
| `--model <modelo>` | Sobreescribir modelo |
| `--stream` | Streaming en tiempo real |

**Ejemplos:**

```bash
# Mensaje simple
node packages/cli/dist/index.js agent --message "Explica qué es SQLite"

# Con streaming
node packages/cli/dist/index.js agent --message "Escribe un poema" --stream

# Usar modelo específico
node packages/cli/dist/index.js agent --message "Hello" --model openai/gpt-4.1
```

### `config`

Gestiona la configuración de Octopus AI.

```bash
# Ver toda la configuración
node packages/cli/dist/index.js config get

# Ver un valor específico
node packages/cli/dist/index.js config get ai.providers.zhipu.apiKey

# Establecer un valor
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"
node packages/cli/dist/index.js config set ai.thinking "high"
node packages/cli/dist/index.js config set ai.default "openai/gpt-4.1"
```

**Rutas comunes:**

| Ruta | Ejemplo |
|------|---------|
| `ai.default` | `"zhipu/glm-5.1"` |
| `ai.fallback` | `"openai/gpt-4.1"` |
| `ai.thinking` | `"none"`, `"low"`, `"medium"`, `"high"` |
| `ai.maxTokens` | `16384` |
| `ai.providers.zhipu.apiKey` | API key de Z.ai |
| `ai.providers.zhipu.mode` | `"api"`, `"coding-plan"`, `"coding-global"`, `"global"` |
| `ai.providers.openai.apiKey` | API key de OpenAI |
| `ai.providers.anthropic.apiKey` | API key de Anthropic |
| `memory.enabled` | `true` / `false` |
| `server.port` | `18789` |

### `doctor`

Ejecuta diagnósticos completos del sistema.

```bash
node packages/cli/dist/index.js doctor
```

Verifica:
- Node.js (versión >= 22)
- pnpm (disponible)
- Python (para módulos nativos)
- Build Tools C++ (para better-sqlite3)
- better-sqlite3 (bindings compilados)
- Archivo de configuración
- Base de datos SQLite
- API Keys configuradas
- Conectividad de red

### `memory`

Gestiona el sistema de memoria.

```bash
node packages/cli/dist/index.js memory <subcomando>
```

| Subcomando | Descripción |
|-----------|-------------|
| `stats` | Estadísticas de memoria (STM y LTM) |
| `search <consulta>` | Buscar en memorias almacenadas |
| `consolidate` | Forzar consolidación STM → LTM |

### `skills`

Gestiona el sistema de habilidades.

```bash
node packages/cli/dist/index.js skills <subcomando>
```

| Subcomando | Descripción |
|-----------|-------------|
| `list` | Listar skills instaladas |
| `create <nombre>` | Crear nueva skill |
| `browse` | Explorar marketplace de skills |
| `import <archivo>` | Importar skill desde archivo JSON |

### `channels`

Gestiona canales de mensajería.

```bash
node packages/cli/dist/index.js channels <subcomando>
```

| Subcomando | Descripción |
|-----------|-------------|
| `enable <canal>` | Habilitar canal (discord, telegram, slack, etc.) |
| `disable <canal>` | Deshabilitar canal |
| `status` | Ver estado de todos los canales |

Canales disponibles: `whatsapp`, `telegram`, `discord`, `slack`, `teams`, `signal`, `wechat`, `webchat`

### `plugins`

Gestiona plugins.

```bash
node packages/cli/dist/index.js plugins <subcomando>
```

| Subcomando | Descripción |
|-----------|-------------|
| `list` | Listar plugins instalados |
| `search <término>` | Buscar en marketplace |
| `install <nombre>` | Instalar plugin |
| `uninstall <nombre>` | Desinstalar plugin |

## Opciones Globales

| Opción | Descripción |
|--------|-------------|
| `-V, --version` | Mostrar versión |
| `-h, --help` | Mostrar ayuda |
