# Inicio Rápido con Octopus AI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Esta guía te mostrará cómo empezar a usar Octopus AI de inmediato después de completar la [Instalación](./installation.md). Aprenderás a configurar tu primer modelo, chatear con el asistente y explorar todas las interfaces disponibles.

---

## 📋 Tabla de Contenidos

- [1. Validar la Instalación](#1-validar-la-instalación)
- [2. Configurar tu Proveedor de IA](#2-configurar-tu-proveedor-de-ia)
- [3. Tu Primera Conversación (CLI)](#3-tu-primera-conversación-cli)
- [4. Usar el Panel Web](#4-usar-el-panel-web)
- [5. Usar la App de Escritorio](#5-usar-la-app-de-escritorio)
- [6. Explorar la Memoria](#6-explorar-la-memoria-humana)
- [7. Conectar Canales de Mensajería](#7-conectar-canales-de-mensajería)
- [8. Explorar las Skills](#8-explorar-las-skills-habilidades)
- [¿Qué puedes hacer con Octopus AI?](#-qué-puedes-hacer-con-octopus-ai)
- [Siguientes Pasos](#-siguientes-pasos)

---

## 1. Validar la Instalación

Antes de empezar, asegurémonos de que todo está en orden:

```bash
node packages/cli/dist/index.js doctor
```

Deberías ver todos los elementos con un check verde (✓):

```text
  ✓ Node.js:             v22.x (>= 22)
  ✓ pnpm:                v10.x
  ✓ Python:              Python 3.x
  ✓ Build Tools (C++):   OK
  ✓ better-sqlite3:      Bindings nativos OK
  ✓ Config File:         ~/.octopus/config.json
  ✓ API Keys:            Z.ai ✓
  ✓ Disk Space:          Writable
  ✓ Network:             Internet connectivity OK
```

Si algún elemento muestra ✗, el propio comando te indicará cómo solucionarlo. También puedes consultar la [Guía de Solución de Problemas](../advanced/troubleshooting.md).

---

## 2. Configurar tu Proveedor de IA

Octopus AI necesita al menos una API Key para funcionar. El proveedor por defecto es **Z.ai (ZhipuAI)**, pero puedes usar cualquiera de los soportados.

### Opción A: Z.ai / ZhipuAI (proveedor por defecto)

Regístrate en [Z.ai](https://open.bigmodel.cn/) y obtén tu API Key:

```bash
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY_ZAI"
node packages/cli/dist/index.js config set ai.providers.zhipu.mode "coding-plan"
```

### Opción B: OpenAI

Regístrate en [OpenAI](https://platform.openai.com/) y obtén tu API Key:

```bash
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-..."
node packages/cli/dist/index.js config set ai.default "openai/gpt-4o"
```

### Opción C: Anthropic (Claude)

Regístrate en [Anthropic](https://console.anthropic.com/):

```bash
node packages/cli/dist/index.js config set ai.providers.anthropic.apiKey "sk-ant-..."
node packages/cli/dist/index.js config set ai.default "anthropic/claude-sonnet-4-6"
```

### Opción D: Google (Gemini)

Regístrate en [Google AI Studio](https://aistudio.google.com/):

```bash
node packages/cli/dist/index.js config set ai.providers.google.apiKey "tu-key-google"
node packages/cli/dist/index.js config set ai.default "google/gemini-2.5-pro"
```

### Opción E: Modelo local con Ollama (100% offline, sin API Key)

Si prefieres privacidad total sin depender de servicios externos:

1. Instala [Ollama](https://ollama.com/)
2. Descarga un modelo: `ollama run llama3.1`
3. Configura Octopus AI:

```bash
node packages/cli/dist/index.js config set ai.default "local/llama3.1"
node packages/cli/dist/index.js config set ai.providers.local.baseUrl "http://localhost:11434"
```

> Consulta la [Guía de Configuración](./configuration.md) para ver todos los proveedores disponibles y sus opciones.

---

## 3. Tu Primera Conversación (CLI)

La forma más rápida de hablar con Octopus AI es a través del chat interactivo de la terminal:

```bash
node packages/cli/dist/index.js chat
```

Se abrirá una interfaz inmersiva en tu terminal. Prueba con algo como:

> *"Hola, mi nombre es [Tu Nombre]. Me gustaría que recuerdes que soy programador y trabajo con TypeScript. ¿Puedes explicarme brevemente de qué eres capaz?"*

Octopus AI recordará tu nombre y profesión para futuras conversaciones gracias a su sistema de memoria.

### Comandos dentro del chat

| Comando | Acción |
|---|---|
| `/clear` | Limpia la ventana actual (no borra la memoria) |
| `/exit` | Cierra el chat |
| `/help` | Muestra la ayuda |
| `/model <modelo>` | Cambia de modelo en medio de la conversación |

### Modo agente (un solo mensaje, sin chat interactivo)

Ideal para scripts y automatización:

```bash
# Mensaje simple
node packages/cli/dist/index.js agent --message "Explica qué es SQLite"

# Con streaming en tiempo real
node packages/cli/dist/index.js agent --message "Escribe un poema sobre la luna" --stream

# Usar un modelo específico
node packages/cli/dist/index.js agent --message "Revisa este código" --model openai/gpt-4o
```

---

## 4. Usar el Panel Web

Si prefieres una interfaz gráfica en lugar de la terminal:

```bash
# Iniciar servidor backend + frontend
pnpm dev
```

Luego abre tu navegador en **http://localhost:5173**

El panel web ofrece:
- Chat en tiempo real con streaming
- Visualización de la memoria (hechos, eventos, procedimientos)
- Gestión de skills
- Configuración visual
- Estado del sistema

> Guía completa: [Panel Web](./web-dashboard.md)

---

## 5. Usar la App de Escritorio

Para la experiencia nativa de escritorio:

```bash
# Compilar y ejecutar
pnpm build
pnpm dev
```

La app de escritorio (Electron) se abre como una ventana nativa de tu sistema operativo.

> Guía completa: [App de Escritorio](./desktop.md)

---

## 6. Explorar la Memoria Humana

Octopus AI "recuerda" información importante automáticamente. Puedes interactuar con su memoria desde la CLI:

```bash
# Ver estadísticas generales de lo que la IA ha aprendido
node packages/cli/dist/index.js memory stats

# Buscar algo específico
node packages/cli/dist/index.js memory search "mi nombre"

# Forzar la consolidación de memoria a corto plazo hacia largo plazo
node packages/cli/dist/index.js memory consolidate
```

### Ejemplo práctico

1. En un chat, dile a Octopus: *"Recuerda que soy alérgico a los frutos secos"*
2. Cierra el chat
3. Abre un nuevo chat días después y pregunta: *"¿Qué alergias tengo?"*
4. Octopus lo recordará gracias a la memoria a largo plazo

### Cómo funciona la memoria

Octopus AI tiene un sistema de memoria inspirado en el cerebro humano:

| Tipo | Duración | Qué almacena |
|---|---|---|
| **Corto plazo (STM)** | Durante la conversación | Contexto actual, tema de la charla |
| **Largo plazo (LTM)** | Permanente (con decaimiento) | Hechos sobre ti, eventos, procedimientos |

La consolidación (paso de STM a LTM) ocurre automáticamente cuando:
- Se completa una tarea
- Hay un periodo de inactividad (30 minutos)
- Lo fuerzas manualmente con `memory consolidate`

> Más detalles: [Sistema de Memoria](../architecture/memory.md)

---

## 7. Conectar Canales de Mensajería

Octopus AI puede funcionar en múltiples plataformas de mensajería. La misma IA, la misma memoria, en todos lados:

```bash
# Ver estado de todos los canales
node packages/cli/dist/index.js channels status

# Habilitar Telegram
node packages/cli/dist/index.js channels enable telegram

# Habilitar Discord
node packages/cli/dist/index.js channels enable discord

# Deshabilitar un canal
node packages/cli/dist/index.js channels disable telegram
```

### Canales disponibles

| Canal | Estado | Requisito adicional |
|---|---|---|
| **Webchat** | Habilitado por defecto | Ninguno |
| **WhatsApp** | Experimental | Escaneo de código QR |
| **Telegram** | Disponible | Bot token (via [@BotFather](https://t.me/BotFather)) |
| **Discord** | Disponible | Bot token (via [Discord Developer Portal](https://discord.com/developers/applications)) |
| **Slack** | Disponible | App OAuth token |
| **Microsoft Teams** | Disponible | Azure Bot registration |
| **Signal** | Experimental | Número de teléfono vinculado |
| **WeChat** | Experimental | Cuenta de desarrollador |

> Para instrucciones detalladas de cada canal, consulta la [Guía de Configuración](./configuration.md#canales-de-mensajería).

---

## 8. Explorar las Skills (Habilidades)

Las Skills son herramientas que Octopus AI puede usar para realizar tareas específicas:

```bash
# Listar skills disponibles
node packages/cli/dist/index.js skills list

# Habilitar una skill
node packages/cli/dist/index.js skills enable file-system

# Explorar el marketplace
node packages/cli/dist/index.js skills browse

# Crear una skill personalizada
node packages/cli/dist/index.js skills create mi-skill
```

### Skills incluidas por defecto

| Skill | Descripción |
|---|---|
| `general-reasoning` | Razonamiento general y resolución de problemas |
| `code-generation` | Generación, revisión y refactorización de código |
| `writing` | Escritura asistida (emails, documentos, creativa) |
| `research` | Investigación, búsqueda y síntesis de información |

### Skills auto-generadas

Octopus AI puede **crear automáticamente** nuevas skills cuando detecta que necesita una herramienta que no tiene. También las **auto-mejora** con el tiempo basándose en su tasa de éxito.

> Más detalles: [Motor de Skills](../architecture/skills.md)

---

## 🎯 ¿Qué puedes hacer con Octopus AI?

Aquí tienes ejemplos concretos de lo que puedes pedirle:

### Chat con memoria personal

```
Tú: "Me llamo Carlos y trabajo como desarrollador en Madrid"
Tú: "Mi proyecto actual usa React y TypeScript"
[Al día siguiente, en un chat nuevo]
Tú: "¿En qué estoy trabajando?"
IA: "Estás trabajando en un proyecto con React y TypeScript en Madrid, Carlos."
```

### Análisis de código

```bash
node packages/cli/dist/index.js agent --message "Revisa el archivo src/index.ts y dime si hay errores" --stream
```

### Escritura asistida

```bash
node packages/cli/dist/index.js agent --message "Ayúdame a redactar un email formal para solicitar una reunión con el director del proyecto" --stream
```

### Investigación

```bash
node packages/cli/dist/index.js agent --message "Resume las diferencias principales entre SQL y NoSQL, con ventajas y desventajas de cada uno" --stream
```

### Gestión de archivos

```bash
node packages/cli/dist/index.js agent --message "Lee el archivo config.json de mi proyecto y dime si hay algún error en la configuración" --stream
```

---

## Siguientes Pasos

- ⚙️ **[Configuración detallada](./configuration.md)** — Cambiar modelos, ajustar memoria, configurar canales
- 🐳 **[Usar con Docker](./docker.md)** — Ejecutar en contenedores
- 🖥️ **[App de Escritorio](./desktop.md)** — Experiencia nativa
- 🌐 **[Panel Web](./web-dashboard.md)** — Interfaz en el navegador
- 🧠 **[Cómo funciona la memoria](../architecture/memory.md)** — Arquitectura del sistema de memoria
- 📖 **[Referencia CLI completa](../api/cli.md)** — Todos los comandos disponibles
