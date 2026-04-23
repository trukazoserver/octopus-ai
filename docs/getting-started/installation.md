# Instalación de Octopus AI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="120" />
</p>

Esta guía te ayudará a instalar Octopus AI paso a paso, sin importar tu nivel técnico.

---

## 📋 Tabla de Contenidos

- [Requisitos del Sistema](#-requisitos-del-sistema)
- [Preparación por Sistema Operativo](#-preparación-por-sistema-operativo)
- [Método 1: Instalador Automático (Recomendado)](#-método-1-instalador-automático-recomendado)
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
| **Python** | >= 3.10 | Compilación de módulos nativos (node-gyp) |
| **C++ Build Tools** | Ver abajo | Compilación de `better-sqlite3` (base de datos) |
| **Git** | Cualquiera | Clonar el repositorio |

> **¿No sabes qué es Node.js o pnpm?** No te preocupes. El instalador automático verifica e instala lo que falte.

---

## 📦 Preparación por Sistema Operativo

Antes de instalar Octopus AI, necesitas tener Node.js, Python y las herramientas de compilación. A continuación, las instrucciones detalladas para cada sistema operativo.

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

Esto es necesario para que la base de datos SQLite funcione correctamente:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --force --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait"
```

> La descarga es de aproximadamente 2 GB y puede tardar varios minutos.

#### 5. Instalar Git (si no lo tienes)

```powershell
winget install Git.Git
```

#### 6. Instalar pnpm

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

## 🚀 Método 1: Instalador Automático (Recomendado)

La forma más fácil y segura. El instalador detecta lo que falta, lo instala y configura todo por ti.

```bash
# 1. Clonar el repositorio
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai

# 2. Ejecutar el instalador
pnpm run install:octopus
```

### ¿Qué hace el instalador paso a paso?

El instalador ejecuta **7 pasos automáticamente**:

| Paso | Acción | ¿Qué pasa si falla? |
|---|---|---|
| 1/7 | Verifica Node.js >= 22 | Te pide actualizar |
| 2/7 | Verifica/instala pnpm | Lo instala con `npm install -g pnpm` |
| 3/7 | Verifica Python | Te pregunta si quieres instalarlo automáticamente |
| 4/7 | Verifica Build Tools C++ | Te pregunta si quieres instalarlas automáticamente |
| 5/7 | `pnpm install` | Descarga todas las dependencias |
| 5b | `pnpm rebuild better-sqlite3` | Compila la base de datos nativa para tu sistema |
| 6/7 | `pnpm build` | Compila los 11 paquetes TypeScript |
| 7/7 | Asistente de API Keys | Te pregunta por las claves de cada proveedor de IA |

### Durante el paso 7 (Configuración inicial)

El instalador te pedirá las API Keys de los proveedores que quieras usar:

```
  Z.ai / ZhipuAI API Key (proveedor por defecto, Enter para saltar): ____
  Anthropic API Key (Enter para saltar): ____
  OpenAI API Key (Enter para saltar): ____
  Google AI API Key (Enter para saltar): ____
  DeepSeek API Key (Enter para saltar): ____
```

> Puedes pulsar Enter para saltar cualquiera. Luego puedes configurarlas con el comando `config set`.

Al finalizar, el instalador crea:
- **Directorio** `~/.octopus/` (en Windows: `C:\Users\TuUsuario\.octopus\`)
- **Configuración** `~/.octopus/config.json`
- **Base de datos** `~/.octopus/data/octopus.db`

---

## 🛠️ Método 2: Instalación Manual

Si prefieres tener control sobre cada paso o el instalador automático no funciona:

```bash
# 1. Clonar e inicializar
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai

# 2. Instalar dependencias
pnpm install

# 3. Recompilar bindings nativos (Importante)
pnpm rebuild better-sqlite3
```

> Si este paso falla con errores de `node-gyp`, revisa que tengas Python y Build Tools C++ instalados (ver sección de preparación por SO).

```bash
# 4. Compilar el monorepo (TypeScript)
pnpm build

# 5. Configuración inicial
node packages/cli/dist/index.js setup
```

El comando `setup` lanzará un asistente interactivo para configurar tus API Keys.

---

## 🐳 Método 3: Despliegue con Docker

Ideal para servidores o si no quieres instalar dependencias en tu máquina.

```bash
# Construir e iniciar el contenedor en segundo plano
docker compose -f docker/docker-compose.yml up -d --build
```

### Variables de entorno

Crea un archivo `.env` en la carpeta `docker/`:

```env
ZHIPU_API_KEY=tu-key-zhipu
# OPENAI_API_KEY=sk-tu-api-key
# ANTHROPIC_API_KEY=sk-ant-...
# GOOGLE_API_KEY=tu-key-google
# TELEGRAM_BOT_TOKEN=123456:ABCDEF
```

### Persistencia de datos

El despliegue actual usa un volumen persistente para `/data` y un bind mount para el workspace del contenedor, así que la base de datos, skills, logs y plantillas operativas sobreviven entre reinicios.

> Para instrucciones completas de Docker (instalación, configuración, actualización y solución de problemas), consulta la [Guía dedicada de Docker](./docker.md).

---

## ✅ Verificación Post-Instalación

Ejecuta el diagnóstico para confirmar que todo funciona:

```bash
node packages/cli/dist/index.js doctor
```

Deberías ver algo como:

```text
  ✓ Node.js:             v22.x (>= 22)
  ✓ pnpm:                v10.x
  ✓ Python:              Python 3.x
  ✓ Build Tools (C++):   OK
  ✓ better-sqlite3:      Bindings nativos OK
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
3. **Tu primera conversación:** [Inicio Rápido](./quick-start.md)
4. **Explora las interfaces:**
   - [Panel Web](./web-dashboard.md)
   - [App de Escritorio](./desktop.md)
   - [Docker](./docker.md)
