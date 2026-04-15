# Referencia de Comandos CLI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

---

## Uso General

```bash
node packages/cli/dist/index.js [comando] [opciones]
```

---

## Comandos Disponibles

### `setup`

Asistente de configuración inicial. Verifica requisitos, pide API keys, crea directorios e inicializa la base de datos.

```bash
node packages/cli/dist/index.js setup
```

**Ejemplo de uso:**
```bash
# Primera configuración después de instalar
node packages/cli/dist/index.js setup

# Reconfigurar (sobrescribe la configuración existente)
node packages/cli/dist/index.js setup
```

---

### `start`

Inicia el servidor de Octopus AI.

```bash
node packages/cli/dist/index.js start [opciones]
```

| Opción | Descripción |
|---|---|
| `--port <puerto>` | Puerto del servidor (sobrescribe config) |
| `--host <host>` | Host de escucha |
| `--transport <tipo>` | Tipo de transporte: `auto`, `stdio`, `sse`, `streamable-http` |

**Ejemplos:**
```bash
# Iniciar en el puerto por defecto (18789)
node packages/cli/dist/index.js start

# Iniciar en un puerto específico
node packages/cli/dist/index.js start --port 8080

# Accesible desde otros dispositivos en la red
node packages/cli/dist/index.js start --host 0.0.0.0 --port 18789
```

---

### `chat`

Inicia una sesión de chat interactiva con memoria.

```bash
node packages/cli/dist/index.js chat [opciones]
```

| Opción | Descripción |
|---|---|
| `--model <modelo>` | Modelo a usar (ej: `zhipu/glm-5.1`) |
| `--stream` | Habilitar streaming (por defecto) |
| `--no-stream` | Deshabilitar streaming |

**Ejemplos:**
```bash
# Chat interactivo normal
node packages/cli/dist/index.js chat

# Usar un modelo específico
node packages/cli/dist/index.js chat --model openai/gpt-4o

# Sin streaming (ver respuesta completa de golpe)
node packages/cli/dist/index.js chat --no-stream
```

**Comandos dentro del chat:**

| Comando | Acción |
|---|---|
| `/clear` | Limpia la ventana de chat (no borra la memoria) |
| `/exit` | Cierra la sesión |

---

### `agent`

Envía un mensaje directo al agente sin sesión interactiva. Ideal para scripts y automatización.

```bash
node packages/cli/dist/index.js agent [opciones]
```

| Opción | Descripción |
|---|---|
| `-m, --message <mensaje>` | Mensaje a enviar (requerido) |
| `--model <modelo>` | Sobrescribir modelo |
| `--stream` | Streaming en tiempo real |

**Ejemplos:**
```bash
# Mensaje simple
node packages/cli/dist/index.js agent --message "Explica qué es SQLite"

# Con streaming
node packages/cli/dist/index.js agent --message "Escribe un poema" --stream

# Usar modelo específico
node packages/cli/dist/index.js agent --message "Hello" --model openai/gpt-4o

# Análisis de código
node packages/cli/dist/index.js agent --message "Revisa src/index.ts y dime si hay errores" --stream

# Resumir un tema
node packages/cli/dist/index.js agent -m "Resume las novedades de TypeScript 5.8" --stream
```

---

### `config`

Gestiona la configuración de Octopus AI.

```bash
# Ver toda la configuración
node packages/cli/dist/index.js config get

# Ver un valor específico
node packages/cli/dist/index.js config get ai.default

# Establecer un valor
node packages/cli/dist/index.js config set <ruta> <valor>
```

**Rutas comunes:**

| Ruta | Ejemplo | Descripción |
|---|---|---|
| `ai.default` | `"zhipu/glm-5.1"` | Modelo por defecto |
| `ai.fallback` | `"openai/gpt-4.1"` | Modelo de respaldo |
| `ai.thinking` | `"medium"` | Nivel de razonamiento |
| `ai.maxTokens` | `16384` | Máximo tokens de respuesta |
| `ai.providers.zhipu.apiKey` | `"..."` | API Key de Z.ai |
| `ai.providers.zhipu.mode` | `"coding-plan"` | Modo de Z.ai |
| `ai.providers.openai.apiKey` | `"sk-..."` | API Key de OpenAI |
| `ai.providers.anthropic.apiKey` | `"sk-ant-..."` | API Key de Anthropic |
| `memory.enabled` | `true` | Activar/desactivar memoria |
| `server.port` | `18789` | Puerto del servidor |
| `server.host` | `"127.0.0.1"` | Host del servidor |

**Ejemplos:**
```bash
# Configurar API Key
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"

# Cambiar modelo por defecto
node packages/cli/dist/index.js config set ai.default "openai/gpt-4o"

# Ajustar nivel de razonamiento
node packages/cli/dist/index.js config set ai.thinking "high"

# Ver qué modelo está configurado
node packages/cli/dist/index.js config get ai.default

# Ver toda la configuración
node packages/cli/dist/index.js config get
```

---

### `doctor`

Ejecuta diagnósticos completos del sistema.

```bash
node packages/cli/dist/index.js doctor
```

**Verifica:**
- Node.js (versión >= 22)
- pnpm (disponible)
- Python (para módulos nativos)
- Build Tools C++ (para better-sqlite3)
- better-sqlite3 (bindings compilados)
- Archivo de configuración
- Base de datos SQLite
- API Keys configuradas
- Conectividad de red
- Espacio en disco

**Salida de ejemplo:**
```text
  ✓ Node.js:             v22.x (>= 22)
  ✓ pnpm:                v10.x
  ✓ Python:              Python 3.x
  ✓ Build Tools (C++):   OK
  ✓ better-sqlite3:      Bindings nativos OK
  ✓ Config File:         ~/.octopus/config.json
  ✓ Config Valid:        Configuration is valid
  ✓ Database:            OK
  ✓ API Keys:            Z.ai ✓
  ✓ Disk Space:          Writable
  ✓ Network:             Internet connectivity OK
```

---

### `memory`

Gestiona el sistema de memoria.

```bash
node packages/cli/dist/index.js memory <subcomando>
```

| Subcomando | Descripción | Ejemplo |
|---|---|---|
| `stats` | Estadísticas de memoria (STM y LTM) | `memory stats` |
| `search <consulta>` | Buscar en memorias almacenadas | `memory search "mi proyecto"` |
| `consolidate` | Forzar consolidación STM → LTM | `memory consolidate` |

**Ejemplos:**
```bash
# Ver cuántos recuerdos tiene la IA
node packages/cli/dist/index.js memory stats

# Buscar algo que le mencionaste antes
node packages/cli/dist/index.js memory search "mi nombre"

# Buscar recuerdos sobre un proyecto
node packages/cli/dist/index.js memory search "proyecto web"

# Forzar la consolidación de la memoria
node packages/cli/dist/index.js memory consolidate
```

---

### `skills`

Gestiona el sistema de habilidades.

```bash
node packages/cli/dist/index.js skills <subcomando>
```

| Subcomando | Descripción | Ejemplo |
|---|---|---|
| `list` | Listar skills instaladas | `skills list` |
| `create <nombre>` | Crear nueva skill | `skills create "analizador"` |
| `browse` | Explorar marketplace | `skills browse` |
| `import <archivo>` | Importar skill desde JSON | `skills import ./skill.json` |

**Ejemplos:**
```bash
# Ver todas las skills disponibles
node packages/cli/dist/index.js skills list

# Crear una nueva skill personalizada
node packages/cli/dist/index.js skills create "resumidor-texto"

# Explorar el marketplace
node packages/cli/dist/index.js skills browse

# Importar una skill desde un archivo
node packages/cli/dist/index.js skills import ./mis-skills/analizador.json
```

---

### `channels`

Gestiona canales de mensajería.

```bash
node packages/cli/dist/index.js channels <subcomando>
```

| Subcomando | Descripción | Ejemplo |
|---|---|---|
| `status` | Ver estado de todos los canales | `channels status` |
| `enable <canal>` | Habilitar canal | `channels enable telegram` |
| `disable <canal>` | Deshabilitar canal | `channels disable telegram` |

**Canales disponibles:** `whatsapp`, `telegram`, `discord`, `slack`, `teams`, `signal`, `wechat`, `webchat`

**Ejemplos:**
```bash
# Ver qué canales están activos
node packages/cli/dist/index.js channels status

# Habilitar Telegram
node packages/cli/dist/index.js channels enable telegram

# Habilitar WhatsApp (genera código QR)
node packages/cli/dist/index.js channels enable whatsapp

# Habilitar Discord
node packages/cli/dist/index.js channels enable discord

# Deshabilitar un canal
node packages/cli/dist/index.js channels disable telegram
```

---

### `plugins`

Gestiona plugins.

```bash
node packages/cli/dist/index.js plugins <subcomando>
```

| Subcomando | Descripción | Ejemplo |
|---|---|---|
| `list` | Listar plugins instalados | `plugins list` |
| `search <término>` | Buscar en marketplace | `plugins search "database"` |
| `install <nombre>` | Instalar plugin | `plugins install mi-plugin` |
| `uninstall <nombre>` | Desinstalar plugin | `plugins uninstall mi-plugin` |

**Ejemplos:**
```bash
# Ver plugins instalados
node packages/cli/dist/index.js plugins list

# Buscar plugins relacionados con bases de datos
node packages/cli/dist/index.js plugins search "database"

# Instalar un plugin
node packages/cli/dist/index.js plugins install mi-plugin

# Desinstalar un plugin
node packages/cli/dist/index.js plugins uninstall mi-plugin
```

---

## Opciones Globales

| Opción | Descripción |
|---|---|
| `-V, --version` | Mostrar versión |
| `-h, --help` | Mostrar ayuda |

---

## Casos de Uso Comunes

### Inicio diario

```bash
# Verificar que todo funciona
node packages/cli/dist/index.js doctor

# Iniciar chat
node packages/cli/dist/index.js chat
```

### Cambiar de modelo rápidamente

```bash
# Cambiar a OpenAI
node packages/cli/dist/index.js config set ai.default "openai/gpt-4o"

# Cambiar a Z.ai
node packages/cli/dist/index.js config set ai.default "zhipu/glm-5.1"

# Cambiar a modelo local
node packages/cli/dist/index.js config set ai.default "local/llama3.1"
```

### Automatización con scripts

```bash
# Script bash (Linux/macOS)
#!/bin/bash
echo "Enviando tarea a Octopus AI..."
node packages/cli/dist/index.js agent -m "Genera un resumen de las tareas pendientes" --stream
```

```powershell
# Script PowerShell (Windows)
Write-Host "Enviando tarea a Octopus AI..."
node packages/cli/dist/index.js agent -m "Genera un resumen de las tareas pendientes" --stream
```

### Pipeline CI/CD

```bash
# Verificar estado antes de deploy
node packages/cli/dist/index.js doctor
if [ $? -ne 0 ]; then
  echo "Error en el diagnóstico"
  exit 1
fi

# Enviar notificación
node packages/cli/dist/index.js agent -m "El deploy se ha completado exitosamente"
```

---

## Siguientes Pasos

- ⚙️ [Configuración](../getting-started/configuration.md) — Ajustar todos los parámetros
- 🚀 [Inicio Rápido](../getting-started/quick-start.md) — Primeros pasos
- 🔧 [Solución de Problemas](../advanced/troubleshooting.md) — Errores comunes
