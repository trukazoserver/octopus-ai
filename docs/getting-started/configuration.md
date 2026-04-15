# Configuración de Octopus AI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Octopus AI es altamente configurable. Toda la configuración se almacena localmente en tu máquina y puede gestionarse desde la CLI o editando el archivo JSON directamente.

---

## 📋 Tabla de Contenidos

- [Ubicación del Archivo de Configuración](#-ubicación-del-archivo-de-configuración)
- [Comandos de Configuración (CLI)](#-comandos-de-configuración-cli)
- [Configuración para Principiantes](#-configuración-para-principiantes)
- [Proveedores de IA](#-proveedores-de-ia-y-razonamiento)
- [Configurar Modelos Locales (Ollama)](#-configurar-modelos-locales-ollama)
- [Niveles de Razonamiento](#-niveles-de-razonamiento-aithinking)
- [Sistema de Memoria](#-sistema-de-memoria)
- [Motor de Skills](#-motor-de-skills-habilidades)
- [Canales de Mensajería](#-canales-de-mensajería)
- [Configuración del Servidor](#-configuración-del-servidor)
- [Seguridad](#-seguridad)
- [Almacenamiento](#-almacenamiento)
- [Conexión y Red](#-conexión-y-red)
- [Variables de Entorno](#-variables-de-entorno)
- [Configuraciones de Ejemplo](#-configuraciones-de-ejemplo)
- [Siguientes Pasos](#-siguientes-pasos)

---

## 📂 Ubicación del Archivo de Configuración

Dependiendo de tu sistema operativo:

| Sistema Operativo | Ruta |
|---|---|
| **Windows** | `C:\Users\TuUsuario\.octopus\config.json` |
| **macOS** | `~/.octopus/config.json` |
| **Linux** | `~/.octopus/config.json` |

Estructura del directorio `.octopus/`:

```text
~/.octopus/
├── config.json       # Configuración principal
├── data/
│   └── octopus.db    # Base de datos SQLite (memoria, conversaciones)
├── skills/           # Skills personalizadas
└── plugins/          # Plugins instalados
```

---

## 🔧 Comandos de Configuración (CLI)

No necesitas editar el JSON a mano. Usa la CLI para leer y escribir valores:

```bash
# Establecer un valor
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-..."

# Leer un valor específico
node packages/cli/dist/index.js config get ai.default

# Ver toda la configuración
node packages/cli/dist/index.js config get

# Ejecutar el asistente de configuración
node packages/cli/dist/index.js setup
```

---

## 🚀 Configuración para Principiantes

Si acabas de instalar Octopus AI, estas son las **3 cosas que necesitas configurar** para empezar:

### 1. Añadir una API Key

```bash
# Z.ai (proveedor por defecto)
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"

# O cambiar a OpenAI
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-..."
node packages/cli/dist/index.js config set ai.default "openai/gpt-4o"
```

### 2. Verificar con doctor

```bash
node packages/cli/dist/index.js doctor
```

### 3. ¡Chatear!

```bash
node packages/cli/dist/index.js chat
```

> El resto de la configuración tiene valores predeterminados que funcionan bien para la mayoría de usuarios.

---

## 🤖 Proveedores de IA y Razonamiento

Octopus AI soporta múltiples proveedores de IA. Puedes configurar varios y definir un modelo por defecto y uno de respaldo (fallback).

### Configuración general de IA

```json
{
  "ai": {
    "default": "zhipu/glm-5.1",
    "fallback": "openai/gpt-4o",
    "thinking": "medium",
    "maxTokens": 16384
  }
}
```

| Parámetro | Descripción | Valores |
|---|---|---|
| `ai.default` | Modelo principal a usar | `"proveedor/modelo"` (ej: `"openai/gpt-4o"`) |
| `ai.fallback` | Modelo de respaldo si el principal falla | `"proveedor/modelo"` |
| `ai.thinking` | Nivel de razonamiento | `"none"`, `"low"`, `"medium"`, `"high"` |
| `ai.maxTokens` | Máximo de tokens en la respuesta | Número (recomendado: `4096`-`32768`) |

### Proveedores disponibles

#### Z.ai / ZhipuAI (proveedor por defecto)

```bash
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"
node packages/cli/dist/index.js config set ai.providers.zhipu.mode "coding-plan"
```

| Parámetro | Descripción |
|---|---|
| `apiKey` | Tu API Key de Z.ai ([open.bigmodel.cn](https://open.bigmodel.cn/)) |
| `mode` | Modo de acceso: `"api"`, `"coding-plan"`, `"coding-global"`, `"global"` |

**Modos de Z.ai:**
- `"api"`: Endpoint regular (requiere créditos)
- `"coding-plan"`: Endpoint para suscriptores del plan coding (recomendado)
- `"coding-global"`: Endpoint global para suscriptores coding
- `"global"`: Endpoint global regular

**Modelos disponibles:** `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-5v-turbo`, `glm-4.6v`

#### OpenAI

```bash
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-..."
```

**Dónde obtener la key:** [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

**Modelos disponibles:** `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`, `o3`, `o4-mini`

#### Anthropic (Claude)

```bash
node packages/cli/dist/index.js config set ai.providers.anthropic.apiKey "sk-ant-..."
```

**Dónde obtener la key:** [console.anthropic.com](https://console.anthropic.com/)

**Modelos disponibles:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`

#### Google (Gemini)

```bash
node packages/cli/dist/index.js config set ai.providers.google.apiKey "tu-key"
```

**Dónde obtener la key:** [aistudio.google.com](https://aistudio.google.com/)

**Modelos disponibles:** `gemini-2.5-pro`, `gemini-2.5-flash`

#### DeepSeek

```bash
node packages/cli/dist/index.js config set ai.providers.deepseek.apiKey "tu-key"
```

**Dónde obtener la key:** [platform.deepseek.com](https://platform.deepseek.com/)

**Modelos disponibles:** `deepseek-chat`, `deepseek-reasoner`

#### Mistral

```bash
node packages/cli/dist/index.js config set ai.providers.mistral.apiKey "tu-key"
```

**Modelos disponibles:** `mistral-large-3`, `mistral-small-4`, `codestral-25-08`

#### xAI (Grok)

```bash
node packages/cli/dist/index.js config set ai.providers.xai.apiKey "tu-key"
```

**Modelos disponibles:** `grok-4.20-0309-reasoning`, `grok-4-1-fast-reasoning`

#### Cohere

```bash
node packages/cli/dist/index.js config set ai.providers.cohere.apiKey "tu-key"
```

**Modelos disponibles:** `command-a-03-2025`, `command-a-vision-07-2025`

#### OpenRouter (agregador de múltiples modelos)

```bash
node packages/cli/dist/index.js config set ai.providers.openrouter.apiKey "tu-key"
```

OpenRouter te da acceso a cientos de modelos de diferentes proveedores con una sola API Key.

---

## 🦙 Configurar Modelos Locales (Ollama)

Para usar Octopus AI 100% offline y de forma privada:

### 1. Instalar Ollama

Descarga Ollama desde [ollama.com](https://ollama.com/) e instálalo en tu sistema.

### 2. Descargar un modelo

```bash
# Modelo general recomendado (4.7 GB)
ollama run llama3.1

# Modelo para código
ollama run codellama

# Modelo ligero (ideal para máquinas con poca RAM)
ollama run mistral

# Modelo Qwen (buen soporte multilenguaje)
ollama run qwen2.5
```

### 3. Configurar Octopus AI

```bash
node packages/cli/dist/index.js config set ai.default "local/llama3.1"
node packages/cli/dist/index.js config set ai.providers.local.baseUrl "http://localhost:11434"
```

### Requisitos de hardware para Ollama

| Modelo | RAM Mínima | RAM Recomendada |
|---|---|---|
| Llama 3.1 8B | 8 GB | 16 GB |
| Mistral 7B | 8 GB | 16 GB |
| Code Llama 7B | 8 GB | 16 GB |
| Qwen 2.5 7B | 8 GB | 16 GB |
| Llama 3.1 70B | 40 GB | 64 GB |

---

## 🧠 Niveles de Razonamiento (`ai.thinking`)

El razonamiento (chain-of-thought) permite que el modelo "piense" antes de responder. Octopus traduce este parámetro a la API específica de cada proveedor:

| Nivel | Comportamiento | Cuándo usarlo |
|---|---|---|
| `"none"` | Respuestas directas sin razonamiento | Tareas simples, respuestas rápidas |
| `"low"` | Razonamiento mínimo | Tareas moderadas |
| `"medium"` | Balance estándar (por defecto) | Uso general |
| `"high"` | Razonamiento exhaustivo | Problemas complejos, análisis profundo |

**Cómo se traduce para cada proveedor:**

| Proveedor | low | medium | high |
|---|---|---|---|
| OpenAI (o-series) | `effort=low` | `effort=medium` | `effort=high` |
| Anthropic | 2048 tokens | 8192 tokens | 16384 tokens |
| Google | 2048 budget | 8192 budget | 16384 budget |
| Z.ai | enabled | enabled | enabled |

```bash
# Cambiar nivel de razonamiento
node packages/cli/dist/index.js config set ai.thinking "high"
```

---

## 💾 Sistema de Memoria

La configuración de memoria controla cómo el agente retiene, olvida y asocia información.

```json
{
  "memory": {
    "enabled": true,
    "shortTerm": {
      "maxTokens": 8192,
      "scratchPadSize": 2048,
      "autoEviction": true
    },
    "longTerm": {
      "backend": "sqlite-vss",
      "importanceThreshold": 0.5,
      "maxItems": 100000,
      "episodic": {
        "decayRate": 0.003,
        "compressionAfter": "30d",
        "maxAge": "365d"
      },
      "semantic": {
        "decayRate": 0.0001,
        "contradictionCheck": true
      },
      "associative": {
        "enabled": true,
        "cascadeDepth": 2,
        "cascadeThreshold": 0.8
      }
    },
    "consolidation": {
      "trigger": "task-complete",
      "idleInterval": "30m",
      "batchSize": 50
    },
    "retrieval": {
      "maxResults": 10,
      "maxTokens": 2000,
      "minRelevance": 0.6,
      "weights": {
        "relevance": 0.5,
        "recency": 0.3,
        "frequency": 0.2
      }
    }
  }
}
```

### Parámetros principales

| Sección | Parámetro | Descripción | Valor por defecto |
|---|---|---|---|
| **General** | `memory.enabled` | Activar/desactivar la memoria | `true` |
| **Corto plazo** | `shortTerm.maxTokens` | Tokens en contexto activo | `8192` |
| **Corto plazo** | `shortTerm.autoEviction` | Auto-limpiar cuando se llena | `true` |
| **Largo plazo** | `longTerm.backend` | Motor de búsqueda vectorial | `"sqlite-vss"` |
| **Largo plazo** | `longTerm.importanceThreshold` | Importancia mínima para almacenar | `0.5` |
| **Largo plazo** | `longTerm.maxItems` | Máximo de recuerdos | `100000` |
| **Consolidación** | `consolidation.trigger` | Cuándo consolidar STM→LTM | `"task-complete"` |
| **Consolidación** | `consolidation.idleInterval` | Intervalo de inactividad | `"30m"` |
| **Recuperación** | `retrieval.maxResults` | Máximos recuerdos por búsqueda | `10` |
| **Recuperación** | `retrieval.minRelevance` | Relevancia mínima para incluir | `0.6` |

> Más detalles sobre la arquitectura: [Sistema de Memoria](../architecture/memory.md)

---

## 🛠️ Motor de Skills (Habilidades)

```json
{
  "skills": {
    "enabled": true,
    "autoCreate": true,
    "autoImprove": true,
    "forge": {
      "complexityThreshold": 0.6,
      "selfCritique": true,
      "minQualityScore": 7
    },
    "improvement": {
      "triggerOnSuccessRate": 0.7,
      "triggerOnRating": 3.5,
      "reviewEveryNUses": 10,
      "abTestMajorChanges": true,
      "abTestSampleSize": 20
    },
    "loading": {
      "maxTokenBudget": 3000,
      "progressiveLevels": true
    }
  }
}
```

| Parámetro | Descripción | Valor por defecto |
|---|---|---|
| `skills.enabled` | Activar/desactivar skills | `true` |
| `skills.autoCreate` | La IA puede crear nuevas skills automáticamente | `true` |
| `skills.autoImprove` | La IA puede mejorar skills con baja tasa de éxito | `true` |
| `forge.complexityThreshold` | Umbral de complejidad para crear skill nueva | `0.6` |
| `forge.minQualityScore` | Puntuación mínima (1-10) para aceptar una skill | `7` |
| `improvement.triggerOnSuccessRate` | Mejorar cuando la tasa de éxito baja de este valor | `0.7` (70%) |

> Más detalles: [Motor de Skills](../architecture/skills.md)

---

## 📡 Canales de Mensajería

Octopus AI puede conectarse a múltiples plataformas de mensajería para que interactúes con la IA desde tu app favorita.

### Configuración general

```json
{
  "channels": {
    "whatsapp": { "enabled": false },
    "telegram": { "enabled": false },
    "discord": { "enabled": false },
    "slack": { "enabled": false },
    "teams": { "enabled": false },
    "signal": { "enabled": false },
    "wechat": { "enabled": false },
    "webchat": { "enabled": true }
  }
}
```

### Telegram

**Requisitos:** Un bot token obtenido desde [@BotFather](https://t.me/BotFather) en Telegram.

```bash
# 1. Habilitar el canal
node packages/cli/dist/index.js channels enable telegram

# 2. Configurar el token del bot
# (Se te pedirá el token al habilitar el canal)
```

**Pasos para crear un bot en Telegram:**
1. Abre Telegram y busca `@BotFather`
2. Envía `/newbot`
3. Elige un nombre y username para tu bot
4. Copia el token que te da BotFather
5. Configúralo en Octopus AI

### Discord

**Requisitos:** Un bot token desde el [Discord Developer Portal](https://discord.com/developers/applications).

**Pasos para crear un bot en Discord:**
1. Ve a [Discord Developer Portal](https://discord.com/developers/applications)
2. Click en "New Application"
3. Ve a la sección "Bot"
4. Click en "Add Bot"
5. Copia el token
6. Activa los "Message Content Intent" en la sección de Bot
7. Invita el bot a tu servidor usando el OAuth2 URL generator

```bash
node packages/cli/dist/index.js channels enable discord
```

### Slack

**Requisitos:** Un Slack App con OAuth token.

**Pasos:**
1. Ve a [api.slack.com/apps](https://api.slack.com/apps)
2. Crea una nueva app
3. Configura los scopes necesarios (`chat:write`, `channels:history`, etc.)
4. Instala la app en tu workspace
5. Copia el Bot User OAuth Token

```bash
node packages/cli/dist/index.js channels enable slack
```

### WhatsApp

**Estado:** Experimental (usa la librería Baileys para la API no oficial).

```bash
node packages/cli/dist/index.js channels enable whatsapp
```

Al habilitarlo, se mostrará un código QR que debes escanear desde WhatsApp ( similar a WhatsApp Web).

> **Nota:** WhatsApp puede bloquear cuentas que usen APIs no oficiales. Úsalo con precaución.

### Microsoft Teams

**Requisitos:** Azure Bot registration.

```bash
node packages/cli/dist/index.js channels enable teams
```

### Webchat

El canal `webchat` está habilitado por defecto y funciona a través del panel web. No requiere configuración adicional.

---

## 🖥️ Configuración del Servidor

```json
{
  "server": {
    "port": 18789,
    "host": "127.0.0.1",
    "transport": "auto"
  }
}
```

| Parámetro | Descripción | Valores |
|---|---|---|
| `server.port` | Puerto del servidor | Número (defecto: `18789`) |
| `server.host` | Dirección de escucha | `"127.0.0.1"` (solo local), `"0.0.0.0"` (todas las interfaces) |
| `server.transport` | Protocolo de transporte | `"auto"`, `"stdio"`, `"sse"`, `"streamable-http"` |

```bash
# Cambiar puerto
node packages/cli/dist/index.js config set server.port 8080

# Permitir acceso desde la red local
node packages/cli/dist/index.js config set server.host "0.0.0.0"
```

---

## 🔒 Seguridad

```json
{
  "security": {
    "encryptionKey": "",
    "allowedPaths": ["~/Documents", "~/Desktop"],
    "sandboxCommands": true
  }
}
```

| Parámetro | Descripción |
|---|---|
| `encryptionKey` | Clave para cifrar datos sensibles (AES-256). Vacío = sin cifrado |
| `allowedPaths` | Directorios a los que la IA puede acceder para leer/escribir archivos |
| `sandboxCommands` | Ejecutar comandos del sistema en un entorno aislado |

> **Importante:** Si configuras una `encryptionKey`, no la pierdas. Sin ella, los datos cifrados son irrecuperables.

---

## 💽 Almacenamiento

```json
{
  "storage": {
    "backend": "sqlite",
    "path": "~/.octopus/data/octopus.db"
  }
}
```

| Parámetro | Descripción |
|---|---|
| `storage.backend` | Motor de base de datos. Actualmente solo `"sqlite"` |
| `storage.path` | Ruta al archivo de base de datos |

---

## 🌐 Conexión y Red

```json
{
  "connection": {
    "autoProxy": true,
    "retryMaxAttempts": 5,
    "retryBaseDelay": 1000,
    "circuitBreakerThreshold": 5,
    "healthCheckInterval": 30000,
    "offlineQueueSize": 1000,
    "preferIPv4": true
  }
}
```

| Parámetro | Descripción | Valor por defecto |
|---|---|---|
| `autoProxy` | Detectar configuración de proxy automáticamente | `true` |
| `retryMaxAttempts` | Reintentos máximos al conectar con APIs | `5` |
| `retryBaseDelay` | Espera base entre reintentos (ms) | `1000` |
| `circuitBreakerThreshold` | Fallos antes de activar el circuit breaker | `5` |
| `healthCheckInterval` | Intervalo entre health checks (ms) | `30000` |
| `offlineQueueSize` | Mensajes en cola cuando no hay conexión | `1000` |
| `preferIPv4` | Preferir IPv4 sobre IPv6 | `true` |

---

## 🔐 Variables de Entorno

Puedes sobrescribir cualquier valor del JSON con variables de entorno. Útil para Docker o CI/CD.

| Variable de Entorno | Equivalente JSON | Ejemplo |
|---|---|---|
| `OCTOPUS_SERVER_PORT` | `server.port` | `18789` |
| `OCTOPUS_AI_DEFAULT` | `ai.default` | `zhipu/glm-5.1` |
| `OCTOPUS_OPENAI_API_KEY` | `ai.providers.openai.apiKey` | `sk-...` |
| `OCTOPUS_ANTHROPIC_API_KEY` | `ai.providers.anthropic.apiKey` | `sk-ant-...` |
| `OCTOPUS_LOCAL_BASE_URL` | `ai.providers.local.baseUrl` | `http://localhost:11434` |
| `OCTOPUS_STORAGE_PATH` | `storage.path` | `~/.octopus/data/octopus.db` |

**Ejemplo en Linux/macOS:**
```bash
export OCTOPUS_OPENAI_API_KEY="sk-..."
node packages/cli/dist/index.js chat
```

**Ejemplo en Windows (PowerShell):**
```powershell
$env:OCTOPUS_OPENAI_API_KEY = "sk-..."
node packages/cli/dist/index.js chat
```

**Ejemplo en Docker (.env):**
```env
OCTOPUS_SERVER_PORT=18789
OCTOPUS_AI_DEFAULT=openai/gpt-4o
OCTOPUS_OPENAI_API_KEY=sk-...
```

---

## 📝 Configuraciones de Ejemplo

### Configuración personal (uso diario)

```json
{
  "ai": {
    "default": "zhipu/glm-5.1",
    "fallback": "openai/gpt-4o",
    "thinking": "medium",
    "maxTokens": 16384
  },
  "memory": {
    "enabled": true
  },
  "channels": {
    "webchat": { "enabled": true },
    "telegram": { "enabled": true }
  }
}
```

### Configuración para desarrollo de código

```json
{
  "ai": {
    "default": "anthropic/claude-sonnet-4-6",
    "fallback": "openai/gpt-4o",
    "thinking": "high",
    "maxTokens": 32768
  },
  "skills": {
    "enabled": true,
    "autoCreate": true
  }
}
```

### Configuración 100% offline (privacidad máxima)

```json
{
  "ai": {
    "default": "local/llama3.1",
    "thinking": "medium",
    "maxTokens": 8192
  },
  "connection": {
    "autoProxy": false,
    "healthCheckInterval": 0
  }
}
```

### Configuración para equipo (servidor compartido)

```json
{
  "server": {
    "port": 18789,
    "host": "0.0.0.0"
  },
  "ai": {
    "default": "openai/gpt-4o",
    "fallback": "anthropic/claude-sonnet-4-6",
    "thinking": "medium"
  },
  "security": {
    "encryptionKey": "tu-clave-de-cifrado-segura",
    "sandboxCommands": true
  },
  "channels": {
    "webchat": { "enabled": true },
    "slack": { "enabled": true },
    "discord": { "enabled": true }
  }
}
```

---

## Siguientes Pasos

- ➡️ **[Inicio Rápido](./quick-start.md)** — Tu primera conversación
- 📖 **[Referencia de la CLI](../api/cli.md)** — Todos los comandos
- 🧠 **[Sistema de Memoria](../architecture/memory.md)** — Cómo funciona la memoria
- 🛠️ **[Motor de Skills](../architecture/skills.md)** — Habilidades automáticas
