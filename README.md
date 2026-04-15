<p align="center">
  <img src="logo repositorio.png" alt="Octopus AI" width="200" />
</p>

<h1 align="center">Octopus AI</h1>

<p align="center">
  <strong>Asistente AI autoalojado con memoria humana, habilidades auto-mejorables y mensajería multicanal</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js" alt="Node.js >=22" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/pnpm-10.8-F69220?logo=pnpm" alt="pnpm" />
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License" />
</p>

---

## Características

- **10 Proveedores de IA** — OpenAI, Anthropic, Google, Z.ai (ZhipuAI), DeepSeek, Mistral, xAI (Grok), Cohere, OpenRouter, Ollama (local)
- **Razonamiento/Thinking** — Soporte nativo para chain-of-thought en todos los proveedores (OpenAI o-series, Anthropic budget_tokens, Google thinkingBudget, Z.ai thinking, DeepSeek reasoner, Mistral Magistral, xAI Grok)
- **Memoria Humana** — Memoria a corto plazo (STM) y largo plazo (LTM) con consolidación automática, decaimiento temporal y grafo de asociaciones
- **Skill Forge** — Motor de creación automática de habilidades con auto-mejora, evaluación de calidad y A/B testing
- **Multi-Canal** — WhatsApp, Telegram, Discord, Slack, Microsoft Teams, Signal, WeChat, WebChat
- **Sistema de Plugins** — Engine extensible con marketplace, MCP (Model Context Protocol) y comandos slash
- **CLI + Desktop + Web** — Interfaz de línea de comandos, aplicación Electron y dashboard web
- **Voz** — Text-to-Speech (ElevenLabs), Speech-to-Text (Whisper), wake word
- **Seguridad** — Encriptación AES-256, sandboxing de comandos, RBAC

## Inicio Rápido

```bash
# Clonar repositorio
git clone https://github.com/your-org/octopus-ai.git
cd octopus-ai

# Ejecutar instalador automático
node scripts/install.mjs
```

El instalador verifica e instala automáticamente todos los requisitos:
- Node.js >= 22
- pnpm
- Python (para módulos nativos)
- Visual Studio Build Tools / gcc (para better-sqlite3)
- Dependencias del proyecto
- Compilación TypeScript
- Asistente de configuración de API keys

## Uso

```bash
# Chat interactivo
node packages/cli/dist/index.js chat

# Enviar mensaje directo
node packages/cli/dist/index.js agent --message "Hola, ¿qué puedes hacer?" --stream

# Diagnosticar instalación
node packages/cli/dist/index.js doctor

# Configurar
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"
```

## Proveedores de IA Soportados

| Proveedor | Modelos | Razonamiento | Notas |
|-----------|---------|-------------|-------|
| **Z.ai (ZhipuAI)** | GLM-5.1, GLM-5, GLM-5-Turbo | `thinking: {type}` | Proveedor por defecto, 4 endpoints |
| **OpenAI** | GPT-4.1, GPT-4o, o3, o4-mini | `reasoning: {effort}` | o-series con reasoning effort |
| **Anthropic** | Claude Opus 4, Sonnet 4, Haiku 4.5 | `thinking: {budget_tokens}` | Thinking blocks con signature |
| **Google** | Gemini 2.5 Pro/Flash, Gemini 3 | `thinkingConfig: {budget}` | thinkingBudget o thinkingLevel |
| **DeepSeek** | DeepSeek Chat, Reasoner | Automático | Full CoT via reasoning_content |
| **Mistral** | Mistral Large 3, Small 4, Codestral | `prompt_mode: "reasoning"` | Typed thinking blocks |
| **xAI** | Grok 4, Grok 3 Mini | `reasoning_effort` | reasoning_content en respuesta |
| **Cohere** | Command A, Command A Vision | N/A | reasoning_tokens en meta |
| **OpenRouter** | Passthrough | Passthrough | Acceso unificado a modelos |
| **Ollama** | Llama, CodeLlama, Mistral, Qwen | N/A | Ejecución local |

## Estructura del Proyecto

```
octopus-ai/
├── packages/
│   ├── core/                 # SDK principal (config, memoria, IA, skills, tools)
│   ├── cli/                  # CLI interactivo (Commander.js + Ink)
│   ├── desktop/              # App desktop (Electron)
│   ├── web/                  # Dashboard web (Vite + React)
│   └── plugins/
│       ├── productivity/     # Tareas, calendario, notas
│       ├── coding/           # Code review, refactoring, debugging
│       ├── research/         # Búsqueda web, papers, resúmenes
│       ├── file-manager/     # Operaciones de archivos
│       ├── sales/            # CRM, pipeline, follow-ups
│       ├── customer-support/ # Tickets, respuestas, escalamiento
│       └── data/             # SQL, gráficos, ETL
├── scripts/
│   └── install.mjs           # Instalador automático
├── docs/                     # Documentación completa
└── docker/                   # Configuración Docker
```

## Configuración

Archivo: `~/.octopus/config.json`

```json
{
  "ai": {
    "default": "zhipu/glm-5.1",
    "fallback": "openai/gpt-4.1",
    "thinking": "medium",
    "providers": {
      "zhipu": {
        "apiKey": "tu-api-key",
        "mode": "coding-plan",
        "models": ["glm-5.1", "glm-5"]
      }
    }
  }
}
```

Ver [Configuración Completa](docs/getting-started/configuration.md).

## Documentación

| Sección | Descripción |
|---------|-------------|
| [Instalación](docs/getting-started/installation.md) | Guía detallada de instalación y requisitos |
| [Inicio Rápido](docs/getting-started/quick-start.md) | Primeros pasos con Octopus AI |
| [Configuración](docs/getting-started/configuration.md) | Todas las opciones de configuración |
| [Arquitectura](docs/architecture/overview.md) | Diseño del sistema y módulos |
| [Memoria](docs/architecture/memory.md) | Sistema de memoria humana |
| [Skills](docs/architecture/skills.md) | Motor de habilidades auto-mejorables |
| [Plugins](docs/architecture/plugins.md) | Sistema de plugins y MCP |
| [CLI](docs/api/cli.md) | Referencia de comandos CLI |
| [Troubleshooting](docs/advanced/troubleshooting.md) | Solución de problemas |

## Licencia

MIT
