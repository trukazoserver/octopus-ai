<p align="center">
  <img src="logo repositorio.png" alt="Octopus AI" width="200" />
</p>

<h1 align="center">Octopus AI</h1>

<p align="center">
  <strong>Asistente de IA autoalojado con memoria humana, habilidades auto-mejorables y mensajería multicanal</strong>
</p>

<p align="center">
  <a href="https://github.com/trukazoserver/octopus-ai"><img src="https://img.shields.io/badge/GitHub-trukazoserver%2Foctopus--ai-181717?logo=github&style=flat-square" alt="GitHub" /></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&style=flat-square" alt="Node.js >=22" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/pnpm-10.8-F69220?logo=pnpm&style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" />
</p>

---

Octopus AI es un ecosistema avanzado de inteligencia artificial diseñado para correr en tu propia infraestructura. A diferencia de los chatbots tradicionales, Octopus cuenta con una memoria a largo plazo que evoluciona, capacidades de razonamiento profundo nativo y la habilidad de crear y mejorar sus propias herramientas (Skills).

## Tabla de Contenidos

- [Características Principales](#-características-principales)
- [¿Qué puede hacer Octopus AI?](#-qué-puede-hacer-octopus-ai)
- [Interfaces](#-interfaces)
- [Inicio Rápido](#-inicio-rápido)
- [Instalación con Docker](#-instalación-con-docker)
- [Proveedores de IA Soportados](#-proveedores-de-ia-soportados)
- [Estructura del Proyecto](#-estructura-del-proyecto-monorepo)
- [Documentación](#-documentación)
- [Contribución](#-contribución)
- [Licencia](#-licencia)

## ✨ Características Principales

- 🧠 **Razonamiento Profundo (Thinking):** Soporte nativo para *chain-of-thought* en todos los proveedores (OpenAI o-series, Anthropic, Google, Z.ai, DeepSeek Reasoner).
- 💾 **Memoria Humana Integrada:** Arquitectura de memoria a corto (STM) y largo plazo (LTM) con consolidación automática y prevención de decaimiento.
- 🛠️ **Skill Forge:** Motor de creación de habilidades. El asistente puede escribir, evaluar, y auto-mejorar sus propios plugins en tiempo real.
- 🌐 **Multi-Canal:** Conéctalo fácilmente con WhatsApp, Telegram, Discord, Slack, y Microsoft Teams.
- 🔌 **Sistema de Plugins Extensible:** Soporte para MCP (Model Context Protocol), integraciones de terceros y ejecución de código en entornos seguros (sandbox).
- 💻 **Interfaces Flexibles:** Úsalo desde la terminal (CLI), la aplicación de escritorio (Electron), o el panel web interactivo (React).
- 🔒 **Privacidad y Seguridad:** Cifrado AES-256 local, RBAC (Control de Acceso basado en Roles) y total compatibilidad con LLMs locales como Ollama.

## 🎯 ¿Qué puede hacer Octopus AI?

Octopus AI no es solo un chatbot. Es un asistente inteligente que aprende de ti con cada interacción:

| Caso de uso | Ejemplo |
|---|---|
| **Chat con memoria** | "Recuerda que soy alérgico a la lactosa" → Lo recordará en futuras conversaciones |
| **Análisis de código** | "Revisa este archivo y dime si hay errores" → Analiza sintaxis, lógica y mejores prácticas |
| **Escritura asistida** | "Ayúdame a redactar un email formal" → Genera, edita y mejora textos |
| **Investigación** | "Resume los puntos clave de este tema" → Sintetiza información compleja |
| **Automatización** | "Organiza mis notas por categoría" → Ejecuta tareas programadas (Cron), flujos de automatización y Webhooks |
| **Gestión de archivos** | "Lee el archivo config.json y muéstrame los errores" → Opera con tu sistema de archivos |
| **Multi-canal** | Pregunta lo mismo desde WhatsApp, Telegram, Discord o la web → Misma memoria, misma IA |
| **Integración MCP** | Conecta con servidores Model Context Protocol (MCP) → Expande capacidades con herramientas externas |
| **Generación de Voz** | Soporte de STT y TTS → Interactúa mediante voz y generación de audio |
| **Ejecución de Código**| Ejecución en sandbox local → Prueba y ejecuta scripts de manera segura |

## 🖥️ Interfaces

Octopus AI ofrece tres formas de interactuar:

### Línea de Comandos (CLI)
La forma más directa. Abre tu terminal y chatea con el asistente con toda la potencia de la memoria y las skills.

### Panel Web (Dashboard)
Interfaz gráfica moderna en el navegador. Ideal para quienes prefieren no usar la terminal. Accede desde `http://localhost:5173`.

### Aplicación de Escritorio (Electron)
App nativa para Windows, macOS y Linux. Experiencia de escritorio completa con todas las funcionalidades.

> Consulta las guías específicas: [Docker](docs/getting-started/docker.md), [Desktop](docs/getting-started/desktop.md), [Web Dashboard](docs/getting-started/web-dashboard.md)

## 🚀 Inicio Rápido

### Requisitos Previos

| Requisito | Versión | Para qué sirve |
|---|---|---|
| [Node.js](https://nodejs.org/) | >= 22 | Entorno de ejecución principal |
| [pnpm](https://pnpm.io/) | >= 10 | Gestor de paquetes |
| Python 3.x | >= 3.10 | Compilación de dependencias nativas (SQLite) |
| C++ Build Tools | — | Compilación de `better-sqlite3` |

> **Hardware recomendado:** 4 GB RAM, 2 GB almacenamiento libre.

### Instalación Automática (Recomendada)

```bash
# 1. Clonar el repositorio
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai

# 2. Ejecutar el instalador
pnpm run install:octopus
```

El instalador hace todo por ti:
1. Verifica Node.js, pnpm y Python
2. Instala Build Tools de C++ si faltan
3. Instala todas las dependencias
4. Compila `better-sqlite3` para tu sistema
5. Construye el proyecto completo
6. Te guía para configurar tus API Keys

> Guía completa: [Instalación paso a paso](docs/getting-started/installation.md)

### Uso Básico (CLI)

```bash
# Iniciar un chat interactivo con memoria
node packages/cli/dist/index.js chat

# Enviar un comando directo
node packages/cli/dist/index.js agent --message "Resume los últimos cambios del proyecto" --stream

# Configurar tu proveedor de IA (ej. Z.ai, el proveedor por defecto)
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"
```

## 🐳 Instalación con Docker

Si prefieres usar Docker (ideal para servidores o si no quieres instalar dependencias):

```bash
# Construir e iniciar
docker compose -f docker/docker-compose.yml up -d --build
```

> **Nota:** El Dockerfile actual necesita mejoras para producción. Consulta la [Guía completa de Docker](docs/getting-started/docker.md) para instrucciones detalladas incluyendo configuración, persistencia y solución de problemas.

## 🤖 Proveedores de IA Soportados

Octopus AI es agnóstico al modelo. Puedes usar y combinar:

| Proveedor | Modelos Destacados | Soporte de Razonamiento |
|-----------|--------------------|-------------------------|
| **Z.ai (ZhipuAI)** | GLM-5.1, GLM-5-Turbo | Sí (`thinking: {type}`) |
| **OpenAI** | GPT-4o, o3, o4-mini | Sí (`reasoning: {effort}`) |
| **Anthropic** | Claude Opus 4, Sonnet 4 | Sí (`thinking: {budget_tokens}`) |
| **Google** | Gemini 2.5 Pro/Flash | Sí (`thinkingConfig: {budget}`) |
| **DeepSeek** | DeepSeek Reasoner, Chat | Automático (Full CoT) |
| **Mistral / xAI** | Mistral Large 3, Grok 4 | Sí |
| **Ollama (Local)** | Llama 3.x, Qwen, Mistral | Ejecución 100% privada sin conexión |

> **Proveedor por defecto:** Z.ai/ZhipuAI con modo `coding-plan`. Puedes cambiarlo en cualquier momento desde la configuración.

## 📂 Estructura del Proyecto (Monorepo)

```text
octopus-ai/
├── packages/
│   ├── core/                 # SDK principal (Memoria, Agentes, Config)
│   ├── cli/                  # Interfaz de terminal interactiva
│   ├── desktop/              # App de escritorio (Electron)
│   ├── web/                  # Panel de control / Dashboard (Vite + React)
│   └── plugins/              # Plugins oficiales (Productividad, Código, etc.)
├── docs/                     # Documentación arquitectónica y guías
└── docker/                   # Archivos para despliegue en contenedores
```

## 📚 Documentación

### Empezando
- [Instalación Completa](docs/getting-started/installation.md) — Requisitos, instalador automático, manual y Docker
- [Inicio Rápido](docs/getting-started/quick-start.md) — Tu primera conversación con Octopus AI
- [Configuración](docs/getting-started/configuration.md) — Proveedores de IA, memoria, skills, canales
- [Guía de Docker](docs/getting-started/docker.md) — Instalación y despliegue con contenedores
- [App de Escritorio](docs/getting-started/desktop.md) — Compilar y usar la app Electron
- [Panel Web](docs/getting-started/web-dashboard.md) — Usar el dashboard desde el navegador

### Arquitectura
- [Visión General](docs/architecture/overview.md) — Monorepo, módulos y flujo de datos
- [Sistema de Memoria](docs/architecture/memory.md) — STM, LTM, consolidación, decaimiento
- [Motor de Habilidades (Skills)](docs/architecture/skills.md) — Creación automática, mejora, A/B testing
- [Sistema de Plugins](docs/architecture/plugins.md) — Engine, MCP, marketplace

### Referencia
- [Comandos CLI](docs/api/cli.md) — Referencia completa de todos los comandos
- [Solución de Problemas](docs/advanced/troubleshooting.md) — Errores comunes y soluciones

## 🤝 Contribución

¡Las contribuciones son bienvenidas! Si deseas añadir un nuevo proveedor, mejorar la interfaz web o crear un plugin, por favor revisa nuestra guía de contribución (próximamente) o abre un *Issue* en [GitHub](https://github.com/trukazoserver/octopus-ai/issues).

## 📄 Licencia

Este proyecto está bajo la Licencia [MIT](LICENSE).
