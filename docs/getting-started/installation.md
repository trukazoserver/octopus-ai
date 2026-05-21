# Instalación de Octopus AI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="120" />
</p>

Esta guía te ayudará a instalar Octopus AI paso a paso, sin importar tu nivel técnico.

---

## 📋 Tabla de Contenidos

- [Requisitos del Sistema](#-requisitos-del-sistema)
- [Preparación por Sistema Operativo](#-preparación-por-sistema-operativo)
- [Método 1: Instalador Interactivo (Recomendado)](#-método-1-instalador-interactivo-recomendado)
- [Método 2: Instalación Manual](#-método-2-instalación-manual)
- [Método 3: Docker](#-método-3-despliegue-con-docker)
- [Verificación Post-Instalación](#-verificación-post-instalación)
- [Actualizar a una Nueva Versión](#-actualizar-a-una-nueva-versión)
- [Desinstalación](#-desinstalación)
- [Primeros Pasos](#-primeros-pasos-después-de-instalar)

---

## 🖥️ Requisitos del Sistema

### Hardware

| Componente | Mínimo | Recomendado |
|---|---|---|
| **Memoria RAM** | 4 GB | 8 GB (para modelos locales con Ollama) |
| **Almacenamiento** | 2 GB libres | 5 GB (con modelos locales) |
| **Procesador** | Cualquier CPU moderna | Multi-núcleo para compilación rápida |

### Software

| Requisito | Versión Mínima | Para qué sirve |
|---|---|---|
| **Node.js** | >= 22.0.0 | Entorno de ejecución principal |
| **pnpm** | >= 10.0.0 | Gestor de paquetes del monorepo |
| **Python** | >= 3.10 | Tools auxiliares, scripts y compatibilidad completa |
| **C++ Build Tools** | Ver abajo | Dependencias nativas y compatibilidad completa de instalación |
| **Docker** | Compose v2 | Opcional para despliegue en contenedores y sandbox aislado |
| **Git** | Cualquiera | Clonar el repositorio |

> **¿No sabes qué es Node.js, pnpm, Python, Docker o Build Tools?** No te preocupes. El instalador verifica cada requisito, instala solo lo que falte si aceptas y permite saltar pasos opcionales.

---

## 📦 Preparación por Sistema Operativo

Antes de instalar Octopus AI necesitas Node.js, pnpm y Git. Python, Build Tools y Docker se recomiendan para funcionamiento al 100%: scripts Python, dependencias nativas, browser/media tooling, despliegue Docker y sandbox aislado. El instalador detecta lo que ya existe y solo instala lo faltante.

### Windows

#### 1. Abrir PowerShell como Administrador

1. Haz clic en el botón **Inicio** de Windows
2. Escribe **PowerShell**
3. Haz clic derecho sobre **Windows PowerShell**
4. Selecciona **Ejecutar como administrador**

> Todos los comandos que siguen debes pegarlos en esa ventana de PowerShell y presionar Enter.

#### 2. Instalar Node.js

```powershell
winget install OpenJS.NodeJS.LTS
```

Cierra y reabre la terminal después de instalar. Verifica con:
```powershell
node --version
```
Deberías ver algo como `v22.x.x`.

#### 3. Instalar Python

```powershell
winget install Python.Python.3.12
```

Cierra y reabre la terminal. Verifica con:
```powershell
python --version
```

#### 4. Instalar Build Tools de C++

Recomendado para instalación completa y dependencias nativas que usen `node-gyp`:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --force --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait"
```

> La descarga es de aproximadamente 2 GB y puede tardar varios minutos.

#### 5. Instalar Git (si no lo tienes)

```powershell
winget install Git.Git
```

#### 6. Instalar Docker Desktop (opcional para Docker/sandbox)

```powershell
winget install Docker.DockerDesktop
```

Reinicia Windows si Docker Desktop lo solicita.

#### 7. Instalar pnpm

```powershell
npm install -g pnpm
```

---

### macOS

#### 1. Abrir la Terminal

1. Presiona `Cmd + Espacio`
2. Escribe **Terminal**
3. Presiona Enter

#### 2. Instalar Homebrew (gestor de paquetes)

Si no tienes Homebrew, instálalo con:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

#### 3. Instalar Xcode Command Line Tools

```bash
xcode-select --install
```

Se abrirá una ventana pidiendo confirmación. Haz clic en **Instalar**.

#### 4. Instalar Node.js

```bash
brew install node@22
```

Verifica: `node --version` (debe mostrar v22.x.x o superior).

#### 5. Instalar Python

```bash
brew install python3
```

#### 6. Instalar Git

```bash
brew install git
```

#### 7. Instalar pnpm

```bash
npm install -g pnpm
```

---

### Linux

#### Debian / Ubuntu

```bash
# Actualizar paquetes
sudo apt update

# Instalar todo lo necesario
sudo apt install -y build-essential python3 git curl

# Instalar Node.js 22 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Instalar pnpm
npm install -g pnpm

# Verificar
node --version   # v22.x
python3 --version # Python 3.x
```

#### Fedora

```bash
# Instalar herramientas de compilación
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y python3 git

# Instalar Node.js 22 (via NodeSource)
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs

# Instalar pnpm
npm install -g pnpm
```

#### Arch Linux

```bash
# Instalar todo desde los repositorios oficiales
sudo pacman -S base-devel python git nodejs npm

# Instalar pnpm
npm install -g pnpm
```

---

## 🚀 Método 1: Instalador Interactivo (Recomendado)

La forma más fácil y segura. El instalador detecta lo que falta, te pregunta qué instalar y configura todo por ti. Puedes presionar Enter para aceptar valores por defecto o saltar API keys. Si quieres cero preguntas, usa `--yes`.

```bash
# 1. Clonar el repositorio
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai

# 2. Ejecutar el instalador interactivo
pnpm run install:octopus
```

Variantes útiles:

```bash
# Automático: acepta instalación de faltantes y usa variables de entorno si existen
pnpm run install:octopus:auto

# Instala/configura/compila, pero no arranca Octopus al final
pnpm run install:octopus:skip-start

# No abrir navegador al finalizar
pnpm run install:octopus -- --no-open

# Modo automático explícito
pnpm run install:octopus -- --yes

# No intentar instalar dependencias del sistema; solo verificar y continuar si es posible
pnpm run install:octopus -- --no-system-deps
```

### ¿Qué hace el instalador paso a paso?

El instalador ejecuta **7 pasos principales** y una verificación adicional de Docker:

| Paso | Acción | ¿Qué pasa si falla? |
|---|---|---|
| 1/7 | Verifica Node.js >= 22 | Te pide actualizar |
| 2/7 | Verifica/instala pnpm | Lo instala con `npm install -g pnpm` |
| 3/7 | Verifica/instala Python | Si falta, pregunta si quieres instalarlo; en `--yes` lo instala automáticamente |
| 4/7 | Verifica/instala Build Tools C++ | Si falta, pregunta si quieres instalarlo; en `--yes` lo instala automáticamente |
| 4b/7 | Verifica/instala Docker | Si falta, pregunta si quieres instalarlo; en `--yes` lo instala automáticamente |
| 5/7 | `pnpm install` | Descarga todas las dependencias |
| 6/7 | `pnpm build` | Compila los 12 paquetes TypeScript |
| 7/7 | Configuración inicial | Crea config, lee API keys de entorno o pregunta por ellas |

### Qué instala y qué no reinstala

El instalador no reinstala lo que ya existe:

- Si `pnpm` ya está disponible, lo reutiliza.
- Si Python ya está instalado, no ejecuta winget/brew/apt.
- Si Build Tools ya existen, no descarga Visual Studio Build Tools ni `build-essential`.
- Si Docker ya existe, no instala Docker Desktop/Engine.
- `pnpm install` usa el lockfile para descargar solo paquetes faltantes o desactualizados.

En Docker el comportamiento es diferente por diseño: la imagen instala todo dentro del contenedor para ser autosuficiente y reproducible.

Usa `--no-system-deps` si no quieres que el instalador intente instalar Python, Build Tools o Docker. En ese modo solo verifica lo disponible y continúa con lo que ya tengas instalado.

### Durante el paso 7 (Configuración inicial)

El instalador te pedirá las API Keys de los proveedores que quieras usar:

```
  Z.ai / ZhipuAI API Key (proveedor por defecto, Enter para saltar): ____
  Anthropic API Key (Enter para saltar): ____
  OpenAI API Key (Enter para saltar): ____
  Google AI API Key (Enter para saltar): ____
  DeepSeek API Key (Enter para saltar): ____
```

> Puedes pulsar Enter para saltar cualquiera. Luego puedes configurarlas desde la interfaz web o con `config set`. Si exportas `ZHIPU_API_KEY`, `ZAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY` o `DEEPSEEK_API_KEY`, el instalador las conserva automáticamente.

Al finalizar, el instalador crea:
- **Directorio** `~/.octopus/` (en Windows: `C:\Users\TuUsuario\.octopus\`)
- **Configuración** `~/.octopus/config.json`
- **Base de datos** `~/.octopus/data/octopus.db`
- **Logs** `~/.octopus/logs/server.log` y `~/.octopus/logs/server.err.log`
- **Comandos** `octopus` y `octopus-ai` en `~/.octopus/bin`

Al finalizar, salvo `--no-start`, deja Octopus ejecutándose en segundo plano y abre `http://127.0.0.1:18789` salvo `--no-open`.

---

## 🛠️ Método 2: Instalación Manual

Si prefieres tener control sobre cada paso o el instalador interactivo no funciona:

```bash
# 1. Clonar e inicializar
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai

# 2. Instalar dependencias
pnpm install

# 3. Compilar el monorepo (TypeScript)
pnpm build

# 4. Configuración inicial interactiva del CLI
node packages/cli/dist/index.js setup

# 5. Iniciar servidor estable con UI/API/WebSocket
pnpm start
```

El comando `setup` lanzará un asistente interactivo para configurar tus API Keys.

---

## 🐳 Método 3: Despliegue con Docker

Ideal para servidores o si no quieres instalar dependencias en tu máquina.

```bash
# Construir e iniciar el contenedor en segundo plano
docker compose -f docker/docker-compose.yml up -d --build
```

También puedes usar el script incluido:

```bash
pnpm run docker:up
```

### Variables de entorno

Crea un archivo `.env` en la raíz del repositorio o exporta las variables antes de levantar Docker:

```env
ZHIPU_API_KEY=tu-key-zhipu
# OPENAI_API_KEY=sk-tu-api-key
# ANTHROPIC_API_KEY=sk-ant-...
# GOOGLE_API_KEY=tu-key-google
# TELEGRAM_BOT_TOKEN=123456:ABCDEF
```

### Persistencia de datos

El despliegue actual usa un volumen persistente para `/data` y un bind mount para el workspace del contenedor, así que la base de datos, skills, logs y plantillas operativas sobreviven entre reinicios.

El contenedor expone Octopus en `http://localhost:18789` y trae todo el runtime necesario instalado dentro de la imagen: Node.js 22, pnpm, Python, Build Tools, Chromium, ffmpeg, fonts y dependencias de producción.

> Para instrucciones completas de Docker (instalación, configuración, actualización y solución de problemas), consulta la [Guía dedicada de Docker](./docker.md).

---

## ✅ Verificación Post-Instalación

Ejecuta el diagnóstico para confirmar que todo funciona:

```bash
node packages/cli/dist/index.js doctor
```

También puedes comprobar que el servidor responde:

```bash
curl http://127.0.0.1:18789/api/status
```

Deberías ver algo como:

```text
  ✓ Node.js:             v22.x (>= 22)
  ✓ pnpm:                v10.x
  ✓ Python:              Python 3.x
  ✓ Build Tools (C++, opcional): OK
  ✓ Database:            OK
  ✓ Config File:         ~/.octopus/config.json
  ✓ API Keys:            Z.ai ✓
```

Si algún elemento muestra ✗, el propio comando te indicará cómo solucionarlo.

> Si tienes problemas, consulta la [Guía de Solución de Problemas](../advanced/troubleshooting.md).

---

## 🔄 Actualizar a una Nueva Versión

```bash
cd octopus-ai
git pull origin main
pnpm install
pnpm build
pnpm start
```

Si la actualización incluye cambios en la base de datos, ejecuta también:
```bash
node packages/cli/dist/index.js doctor
```

---

## 🗑️ Desinstalación

Para eliminar completamente Octopus AI de tu sistema:

```bash
# 1. Eliminar el directorio del proyecto
rm -rf octopus-ai

# 2. Eliminar la configuración y datos
# Windows:
rmdir /s /q "%USERPROFILE%\.octopus"
# macOS/Linux:
rm -rf ~/.octopus
```

---

## 🚀 Primeros Pasos Después de Instalar

1. **Verifica la instalación:** `node packages/cli/dist/index.js doctor`
2. **Configura tu proveedor de IA:** [Guía de Configuración](./configuration.md)
3. **Abre la web:** `http://127.0.0.1:18789`
4. **Tu primera conversación:** [Inicio Rápido](./quick-start.md)
5. **Explora las interfaces:**
   - [Panel Web](./web-dashboard.md)
   - [App de Escritorio](./desktop.md)
   - [Docker](./docker.md)
