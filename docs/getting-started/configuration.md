# Configuración

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

## Ubicación del Archivo

`~/.octopus/config.json`

Se puede editar directamente o usar el comando `config`:

```bash
node packages/cli/dist/index.js config set <ruta> <valor>
node packages/cli/dist/index.js config get <ruta>
```

## Configuración Completa

### Servidor

```json
{
  "server": {
    "port": 18789,
    "host": "127.0.0.1",
    "transport": "auto"
  }
}
```

| Campo | Por defecto | Valores | Descripción |
|-------|------------|---------|-------------|
| `port` | `18789` | Número | Puerto del servidor |
| `host` | `"127.0.0.1"` | IP | Host de escucha |
| `transport` | `"auto"` | `"auto"`, `"stdio"`, `"sse"`, `"streamable-http"` | Protocolo de transporte |

### IA (Proveedores y Razonamiento)

```json
{
  "ai": {
    "default": "zhipu/glm-5.1",
    "fallback": "openai/gpt-4.1",
    "thinking": "medium",
    "maxTokens": 16384,
    "providers": {
      "zhipu": {
        "apiKey": "",
        "mode": "coding-plan",
        "models": ["glm-5.1", "glm-5", "glm-5-turbo", "glm-5v-turbo", "glm-4.6v"]
      },
      "openai": {
        "apiKey": "",
        "models": ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"]
      },
      "anthropic": {
        "apiKey": "",
        "models": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]
      },
      "google": {
        "apiKey": "",
        "models": ["gemini-2.5-pro", "gemini-2.5-flash"]
      },
      "deepseek": {
        "apiKey": "",
        "models": ["deepseek-chat", "deepseek-reasoner"]
      },
      "mistral": {
        "apiKey": "",
        "models": ["mistral-large-3", "mistral-small-4", "codestral-25-08"]
      },
      "xai": {
        "apiKey": "",
        "models": ["grok-4.20-0309-reasoning", "grok-4-1-fast-reasoning"]
      },
      "cohere": {
        "apiKey": "",
        "models": ["command-a-03-2025", "command-a-vision-07-2025"]
      },
      "openrouter": {
        "apiKey": ""
      },
      "local": {
        "baseUrl": "http://localhost:11434",
        "models": ["llama3.1", "codellama", "mistral", "qwen2.5"]
      }
    }
  }
}
```

#### Razonamiento / Thinking

| Valor | Efecto por proveedor |
|-------|---------------------|
| `"none"` | Sin razonamiento. Respuestas directas y rápidas |
| `"low"` | Razonamiento mínimo (OpenAI: effort=low, Anthropic: 2048 tokens, Google: 128 tokens) |
| `"medium"` | Balance (OpenAI: effort=medium, Anthropic: 8192 tokens, Google: 1024 tokens) |
| `"high"` | Máximo razonamiento (OpenAI: effort=high, Anthropic: 32768 tokens, Google: 8192 tokens) |

#### Z.ai / ZhipuAI — Modos de Endpoint

| Modo | URL | Descripción |
|------|-----|-------------|
| `"coding-plan"` | `open.bigmodel.cn/api/coding/paas/v4` | Plan de codificación China (por defecto) |
| `"coding-global"` | `api.z.ai/api/coding/paas/v4` | Plan de codificación Global |
| `"api"` | `open.bigmodel.cn/api/paas/v4` | API regular China (requiere créditos) |
| `"global"` | `api.z.ai/api/paas/v4` | API regular Global (requiere créditos) |

#### Formato de Modelos

Los modelos se especifican como `proveedor/modelo`:

```
zhipu/glm-5.1          → Proveedor Z.ai, modelo GLM-5.1
openai/gpt-4.1          → Proveedor OpenAI, modelo GPT-4.1
anthropic/claude-opus-4-6 → Proveedor Anthropic, modelo Claude Opus 4
local/llama3.1          → Proveedor Ollama local, modelo Llama 3.1
```

### Memoria

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
      "batchSize": 50,
      "extractFacts": true,
      "extractEvents": true,
      "extractProcedures": true,
      "buildAssociations": true,
      "compressAndDecay": true
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

### Skills (Habilidades)

```json
{
  "skills": {
    "enabled": true,
    "autoCreate": true,
    "autoImprove": true,
    "forge": {
      "complexityThreshold": 0.6,
      "selfCritique": true,
      "minQualityScore": 7,
      "includeExamples": true,
      "includeTemplates": true,
      "includeAntiPatterns": true
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
      "progressiveLevels": true,
      "autoUnload": true,
      "searchThreshold": 0.7
    },
    "registry": {
      "path": "~/.octopus/skills",
      "builtinSkills": ["general-reasoning", "code-generation", "writing", "research"]
    }
  }
}
```

### Canales

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

### Conexión

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

### Plugins

```json
{
  "plugins": {
    "directories": ["~/.octopus/plugins"],
    "builtin": ["productivity", "coding"]
  }
}
```

### Almacenamiento

```json
{
  "storage": {
    "backend": "sqlite",
    "path": "~/.octopus/data/octopus.db"
  }
}
```

### Seguridad

```json
{
  "security": {
    "encryptionKey": "",
    "allowedPaths": ["~/Documents", "~/Desktop"],
    "sandboxCommands": true
  }
}
```

## Variables de Entorno

Todas las opciones de configuración pueden sobreescribirse con variables de entorno:

| Variable | Equivalente |
|----------|-------------|
| `OCTOPUS_SERVER_PORT` | `server.port` |
| `OCTOPUS_AI_DEFAULT` | `ai.default` |
| `OCTOPUS_ANTHROPIC_API_KEY` | `ai.providers.anthropic.apiKey` |
| `OCTOPUS_OPENAI_API_KEY` | `ai.providers.openai.apiKey` |
| `OCTOPUS_ZHIPU_API_KEY` | `ai.providers.zhipu.apiKey` |
| `OCTOPUS_GOOGLE_API_KEY` | `ai.providers.google.apiKey` |
| `OCTOPUS_STORAGE_PATH` | `storage.path` |

## Siguiente Paso

- [Arquitectura](../architecture/overview.md) — Diseño del sistema
- [Referencia CLI](../api/cli.md) — Todos los comandos disponibles
