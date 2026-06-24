<p align="center">
  <img src="logo repositorio.png" alt="Octopus AI" width="200" />
</p>

<h1 align="center">Octopus AI</h1>

<p align="center">
  <strong>Asistente de IA autoalojado con memoria persistente, aprendizaje continuo, automatizaciones autónomas y mensajería multicanal</strong>
</p>

<p align="center">
  <a href="https://github.com/trukazoserver/octopus-ai"><img src="https://img.shields.io/badge/GitHub-trukazoserver%2Foctopus--ai-181717?logo=github&style=flat-square" alt="GitHub" /></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&style=flat-square" alt="Node.js >=22" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/pnpm-10.8-F69220?logo=pnpm&style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" />
</p>

---

Octopus AI es un ecosistema avanzado de inteligencia artificial diseñado para correr en tu propia infraestructura. A diferencia de los chatbots tradicionales, Octopus cuenta con memoria a largo plazo, aprendizaje continuo basado en experiencias reales, razonamiento profundo nativo y la habilidad de crear y mejorar sus propias herramientas (Skills).

## Tabla de Contenidos

- [Características Principales](#-características-principales)
- [¿Qué puede hacer Octopus AI?](#-qué-puede-hacer-octopus-ai)
- [Interfaces](#-interfaces)
- [Inicio Rápido](#-inicio-rápido)
- [Instalación con Docker](#-instalación-con-docker)
- [Proveedores de IA Soportados](#-proveedores-de-ia-soportados)
- [Estructura del Proyecto](#-estructura-del-proyecto-monorepo)
- [Documentación](#-documentación)
- [Validación del Proyecto](#-validación-del-proyecto)
- [Contribución](#-contribución)
- [Licencia](#-licencia)

## ✨ Características Principales

- 🧠 **Razonamiento Profundo (Thinking):** Soporte nativo para *chain-of-thought* en proveedores como OpenAI o-series, Anthropic, Google, Z.ai y DeepSeek Reasoner.
- 💾 **Memoria Orquestada Persistente:** STM + LTM con integridad, evidencia, scopes, búsqueda híbrida vectorial/FTS, perfil de usuario, resumen diario, recordatorios prospectivos y trazabilidad de uso.
- 📈 **Aprendizaje Continuo:** Registra experiencias, extrae procedimientos/antipatrones, aprende qué funcionó y reutiliza esos insights en tareas futuras.
- 🤖 **Automatización Autónoma:** Tareas programadas por cron, heartbeat proactivo evaluado por LLM, workflows persistentes y runtime listo para ejecución continua en segundo plano.
- 🐙 **Coordinación Multi-Agente:** Bus de coordinación, workers especializados, perfiles de brazos, tracking de subtareas, Kanban Swarm con dependencias por artifact, recuperación de workflows, revisión cruzada y reconciliación de resultados.
- 🛠️ **Sistema de Tools Extensible:** Filesystem, shell, browser automation, media, sandbox Docker, comunicación/spawn de agentes, rate limiting y tools dinámicas creadas en tiempo real.
- 🌐 **Multi-Canal:** Integra el mismo agente con Telegram, Discord, Slack, Teams, webchat y otros canales manteniendo memoria compartida.
- 💻 **Interfaces Flexibles:** CLI, API HTTP/WebSocket, dashboard web servido por el backend compilado, modo desarrollo React/Vite y aplicación de escritorio con la misma base de runtime.
- 🔒 **Privacidad y Seguridad:** Compatibilidad con modelos locales, ejecución aislada para tareas sensibles, API key para endpoints sensibles fuera de loopback y control fino del entorno de trabajo.
- 🎛️ **Modelo y razonamiento por agente:** Cada agente recuerda su propio modelo y nivel de pensamiento (por modelo), seleccionable y editable desde el chat, la página de agentes o los ajustes; el cambio se aplica en vivo y se sincroniza en todas las vistas.
- 📊 **Uso y consumo persistente:** Tokens y costo estimado se registran en un ledger que sobrevive reinicios, con totales y desglose por proveedor y por agente, más cuotas de plan (Codex y Z.ai/Zhipu) con fecha de restablecimiento.

### Novedades de memoria avanzada

La capa de memoria actual incluye una arquitectura de orquestación pensada para uso multi-agente y auditoría:

- `MemoryIntegrityLayer` valida candidatos antes de persistirlos, aplica redacciones y registra patrones sospechosos.
- `MemoryOrchestrator` centraliza escrituras, lecturas, evidencia, feedback, forgetting activo, relaciones `supersedes`/`contradicts` y métricas de cobertura.
- `ContextAssembler` arma paquetes de contexto con presupuesto de tokens, preservando memoria de usuario y recordatorios prospectivos.
- `ProactiveMemoryScanner` detecta compromisos pendientes, vencidos o próximos.
- `UncertaintyEstimator` etiqueta lecturas como `HIGH_CONFIDENCE`, `LOW_CONFIDENCE` o `NO_COVERAGE`.
- La UI de memoria ahora muestra un Centro de Memoria con métricas, grafo navegable, inspector, filtros, minimapa y navegación contextual hacia STM, LTM, aprendizaje, perfil y resumen diario.

Guía detallada: [Orquestación de Memoria](docs/architecture/memory-orchestration.md)

### Novedades de coordinación y workflows

El runtime multi-agente incorpora piezas persistentes para dividir, recuperar y auditar trabajos largos:

- `AgentCoordinationBus` mantiene mensajería entre agentes, broadcasts e inbox por agente.
- `WorkflowManager` y `WorkflowScheduler` persisten runs, subtareas, attempts, artifacts y eventos para permitir recovery/resume.
- `KanbanPlanner`, `KanbanDispatcher` y `RequirementResolver` convierten objetivos complejos en tableros DAG, reclaman cards listas y desbloquean trabajo solo cuando los artifacts requeridos estan verificados.
- `SubtaskTracker`, `ArtifactVerifier`, `CrossReviewEngine` y `ReconciliationService` verifican entregables y sintetizan resultados de varios workers.
- `RetryPolicy` evita bucles de reintento sin progreso usando `progress_signature`, `step_key` y contadores de estancamiento.
- La API expone `/api/workflows`, acciones `retry`/`cancel`/`recover`, endpoints `/api/kanban/*` para operar tableros swarm y mensajería de agentes en `/api/agents/messages`.
- El CLI incluye `kanban swarm`, `kanban status`, `kanban list` y `kanban inspect` para crear, ejecutar e inspeccionar runs desde terminal.

Guía detallada: [Workflows y Automatizaciones](docs/architecture/automation.md)

## 🎯 ¿Qué puede hacer Octopus AI?

Octopus AI no es solo un chatbot. Es un asistente inteligente que aprende de ti con cada interacción:

| Caso de uso | Ejemplo |
|---|---|
| **Chat con memoria** | "Recuerda que soy alérgico a la lactosa" → Lo recordará en futuras conversaciones |
| **Auto-mejora** | Completa una tarea compleja → Guarda qué estrategia funcionó y la aplica en tareas parecidas |
| **Análisis de código** | "Revisa este archivo y dime si hay errores" → Analiza sintaxis, lógica y mejores prácticas |
| **Escritura asistida** | "Ayúdame a redactar un email formal" → Genera, edita y mejora textos |
| **Investigación** | "Resume los puntos clave de este tema" → Sintetiza información compleja |
| **Automatización** | "Cada mañana revisa mis tareas y genera un resumen" → Programa cron jobs, ejecuta prompts en segundo plano y mantiene seguimiento diario |
| **Kanban Swarm** | "Crea una campaña con investigacion, copy, assets y QA" → Divide el objetivo en cards paralelas con dependencias por artifact y gates de revision |
| **Gestión de archivos** | "Lee el archivo config.json y muéstrame los errores" → Opera con tu sistema de archivos |
| **Multi-canal** | Pregunta lo mismo desde WhatsApp, Telegram, Discord o la web → Misma memoria, misma IA |
| **Integración MCP** | Conecta con servidores Model Context Protocol (MCP) → Expande capacidades con herramientas externas |
| **Generación de Voz** | Soporte de STT y TTS → Interactúa mediante voz y generación de audio |
| **Ejecución de Código**| Ejecución en sandbox local → Prueba y ejecuta scripts de manera segura |
| **Delegación** | "Investiga esto y luego redacta una propuesta" → Divide subtareas complejas en workers especializados y sintetiza el resultado |

## 🖥️ Interfaces

Octopus AI ofrece tres formas de interactuar:

### Línea de Comandos (CLI)
La forma más directa. Abre tu terminal y chatea con el asistente con toda la potencia de la memoria y las skills.

### Panel Web (Dashboard)
Interfaz gráfica moderna en el navegador. Ideal para quienes prefieren no usar la terminal. Incluye chat con streaming, memoria, agentes, workflows/tareas, automatizaciones, tools, variables, auth de proveedores y biblioteca multimedia. En instalación normal accede desde `http://127.0.0.1:18789`; en desarrollo frontend usa `http://localhost:3000`.

### Aplicación de Escritorio (Electron)
App nativa para Windows, macOS y Linux. Experiencia de escritorio completa con todas las funcionalidades.

> Consulta las guías específicas: [Docker](docs/getting-started/docker.md), [Desktop](docs/getting-started/desktop.md), [Web Dashboard](docs/getting-started/web-dashboard.md)

## 🚀 Inicio Rápido

### Requisitos Previos

| Requisito | Versión | Para qué sirve |
|---|---|---|
| [Node.js](https://nodejs.org/) | >= 22 | Entorno de ejecución principal |
| [pnpm](https://pnpm.io/) | >= 10 | Gestor de paquetes |
| Python 3.x | >= 3.10 | Recomendado para herramientas y scripts auxiliares |
| C++ Build Tools | — | Recomendado para instalación completa y dependencias nativas |
| Docker | Compose v2 | Opcional para despliegue Docker y sandbox aislado |

> **Hardware recomendado:** 4 GB RAM, 2 GB almacenamiento libre.

### Instalación Interactiva (Recomendada)

```bash
# 1. Clonar el repositorio
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai

# 2. Ejecutar el instalador interactivo
pnpm run install:octopus
```

El instalador hace todo por ti y cada paso opcional se puede saltar con Enter o `n`:
1. Verifica Node.js, pnpm, Python, Build Tools y Docker.
2. Instala solo las dependencias faltantes si aceptas o si usas modo automatico.
3. Ejecuta `pnpm install` y `pnpm build` para compilar los 12 paquetes.
4. Crea `~/.octopus/config.json`, `~/.octopus/data`, `~/.octopus/logs`, `~/.octopus/skills` y `~/.octopus/plugins`.
5. Instala shims `octopus`/`octopus-ai` en `~/.octopus/bin`.
6. Pregunta API keys, pero puedes saltarlas y configurarlas luego desde la web.
7. Inicia Octopus en segundo plano y abre la web, salvo que uses `--no-start` o `--no-open`.

Modos utiles:

```bash
# Instalacion automatica sin prompts
pnpm run install:octopus:auto

# Instalar todo pero no iniciar al final
pnpm run install:octopus:skip-start

# Modo manual equivalente
pnpm run install:octopus -- --yes --no-open
```

> Guía completa: [Instalación paso a paso](docs/getting-started/installation.md)

### Uso Básico (CLI)

```bash
# Iniciar el backend HTTP/WebSocket local y UI compilada
pnpm start

# Iniciar y abrir la web
pnpm launch

# Iniciar un chat interactivo con memoria
node packages/cli/dist/index.js chat

# Enviar un comando directo
node packages/cli/dist/index.js agent --message "Resume los últimos cambios del proyecto" --stream

# Crear y ejecutar un Kanban Swarm desde un objetivo complejo
node packages/cli/dist/index.js kanban swarm "Investiga, planifica y valida una landing page"

# Buscar recuerdos previos
node packages/cli/dist/index.js memory search "proyecto"

# Configurar tu proveedor de IA (ej. Z.ai, el proveedor por defecto)
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"
```

## 🐳 Instalación con Docker

Si prefieres usar Docker (ideal para servidores o si no quieres instalar dependencias):

```bash
# Construir e iniciar con scripts del repositorio
pnpm run docker:up

# Equivalente directo
docker compose -f docker/docker-compose.yml up -d --build
```

El despliegue incluido levanta un servicio `octopus`, expone UI/API/WebSocket y healthcheck en `http://localhost:18789`, persiste datos en `/data` y aprovisiona plantillas base (`SOUL.md` y `HEARTBEAT.md`) en el workspace del contenedor. La imagen Docker instala el runtime completo dentro del contenedor: Node 22, pnpm, Python, build tools, Chromium, ffmpeg, fonts y dependencias de producción.

> Guía completa: [Docker](docs/getting-started/docker.md)

## 🤖 Proveedores de IA Soportados

Octopus AI es agnóstico al modelo. Puedes usar y combinar:

| Proveedor | Modelos Destacados | Soporte de Razonamiento |
|-----------|--------------------|-------------------------|
| **Z.ai (ZhipuAI)** | GLM-5.2, GLM-5.1, GLM-4.7, GLM-4.6 | Sí (`thinking: {type}`) |
| **OpenAI** | GPT-5.5, GPT-5.4, GPT-5.4-mini | Sí (`reasoning: {effort}`) |
| **Codex (cuenta ChatGPT)** | gpt-5.5, gpt-5.4 vía backend de Codex (login OAuth) | Sí (`reasoning: {effort}`) |
| **Anthropic** | Claude Opus 4, Sonnet 4 | Sí (`thinking: {budget_tokens}`) |
| **Google** | Gemini 2.5 Pro/Flash | Sí (`thinkingConfig: {budget}`) |
| **DeepSeek** | DeepSeek Reasoner, Chat | Automático (Full CoT) |
| **Mistral / xAI** | Mistral Large 3, Grok 4 | Sí |
| **Ollama (Local)** | Llama 3.x, Qwen, Mistral | Ejecución 100% privada sin conexión |

> **Proveedor por defecto:** Z.ai/ZhipuAI con modo `coding-plan`/`coding-global`. Puedes cambiar el modelo y el nivel de razonamiento **por agente** desde el chat, la página de agentes o los ajustes; el cambio se aplica en vivo y se refleja en el centro de control y en `/api/status`.

> **Notas de compatibilidad:** El backend de Codex requiere `stream: true` y **rechaza `temperature` cuando el razonamiento está activo** (los modelos reasoning no lo aceptan); el proveedor lo omite automaticamente en ese caso. Los modelos y sus capacidades de razonamiento se sirven en `/api/models` para que la UI muestre u oculte el control de pensamiento segun el modelo elegido.

## 📂 Estructura del Proyecto (Monorepo)

```text
octopus-ai/
├── packages/
│   ├── core/                 # SDK principal (Agentes, Memoria, Learning, Tools, Config)
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
- [Configuración](docs/getting-started/configuration.md) — Proveedores de IA, memoria, aprendizaje, skills, canales
- [Guía de Docker](docs/getting-started/docker.md) — Instalación y despliegue con contenedores
- [App de Escritorio](docs/getting-started/desktop.md) — Compilar y usar la app Electron
- [Panel Web](docs/getting-started/web-dashboard.md) — Usar el dashboard desde el navegador

### Arquitectura
- [Visión General](docs/architecture/overview.md) — Monorepo, módulos y flujo de datos
- [Sistema de Memoria](docs/architecture/memory.md) — STM, LTM, consolidación, grafo, decaimiento y memoria procedural
- [Orquestación de Memoria](docs/architecture/memory-orchestration.md) — Integridad, scopes, evidencia, incertidumbre, contexto avanzado y UI del Centro de Memoria
- [Motor de Aprendizaje](docs/architecture/learning.md) — Experiencias, insights, feedback y auto-mejora controlada
- [Agente Autónomo, Workflows y Automatizaciones](docs/architecture/automation.md) — Daemon, heartbeat, cron, coordinación multi-agente, Kanban Swarm, recovery y sandbox
- [Motor de Habilidades (Skills)](docs/architecture/skills.md) — Creación automática, mejora, A/B testing
- [Sistema de Plugins](docs/architecture/plugins.md) — Engine, MCP, marketplace

### Referencia
- [Comandos CLI](docs/api/cli.md) — Referencia completa de todos los comandos
- [API HTTP y WebSocket](docs/api/http.md) — Endpoints para auth, configuración, memoria, skills, tools, agentes, workflows, tareas y canales
- [Solución de Problemas](docs/advanced/troubleshooting.md) — Errores comunes y soluciones

## ✅ Validación del Proyecto

Antes de publicar cambios se recomienda ejecutar la matriz completa:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

La suite cubre runtime de agentes, workflows, memoria, learning, tools, CLI bootstrap y plugins oficiales. Para cambios de memoria o coordinación multi-agente, además se recomienda ejecutar:

```bash
pnpm --filter @octopus-ai/core test -- agent-runtime.test.ts workflow-scheduler.test.ts subtask-tracking.test.ts
```

## 🤝 Contribución

Las contribuciones son bienvenidas. Si deseas añadir un nuevo proveedor, mejorar la interfaz web o crear una tool/plugin, revisa [CONTRIBUTING.md](CONTRIBUTING.md) o abre un *Issue* en [GitHub](https://github.com/trukazoserver/octopus-ai/issues).

## 📄 Licencia

Este proyecto está bajo la Licencia [MIT](LICENSE).
