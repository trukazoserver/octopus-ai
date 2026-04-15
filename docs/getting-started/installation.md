# Instalación

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="120" />
</p>

## Requisitos del Sistema

| Requisito | Versión Mínima | Propósito |
|-----------|---------------|-----------|
| **Node.js** | >= 22.0.0 | Runtime principal |
| **pnpm** | >= 10.0.0 | Gestor de paquetes (monorepo) |
| **Python** | >= 3.x | Compilación de módulos nativos (better-sqlite3) |
| **Build Tools C++** | VS 2022 Build Tools (Win) / gcc (Linux) / Xcode CLT (Mac) | Bindings nativos |
| **Git** | Cualquier versión | Control de versiones |
| **RAM** | 4 GB mínimo | Compilación TypeScript (11 paquetes) |
| **Disco** | 2 GB libres | Dependencias + build artifacts |

### Requisitos por Plataforma

#### Windows

- **Visual Studio 2022 Build Tools** con workload "Desktop development with C++"
  - Descarga: https://visualstudio.microsoft.com/visual-cpp-build-tools/
  - O instala via winget: `winget install Microsoft.VisualStudio.2022.BuildTools`
- **Python 3** (marcar "Add to PATH" durante instalación)

#### macOS

```bash
xcode-select --install
brew install python3
```

#### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y build-essential python3
```

## Método 1: Instalador Automático (Recomendado)

El instalador verifica todos los requisitos, instala los faltantes y configura el proyecto:

```bash
git clone https://github.com/your-org/octopus-ai.git
cd octopus-ai
node scripts/install.mjs
```

### Flujo del Instalador

```
Paso 1/7: Verificando Node.js ✓ v22.x
Paso 2/7: Verificando pnpm       ✓ v10.x
Paso 3/7: Verificando Python     ✓ Python 3.x
Paso 4/7: Build Tools (C++)      → ¿Instalar automáticamente? (S/n)
Paso 5/7: pnpm install           → Instalando dependencias...
Paso 5b:  better-sqlite3         → Recompilando bindings nativos...
Paso 6/7: pnpm build             → Compilando 11 paquetes TypeScript...
Paso 7/7: Configuración          → Asistente de API keys
```

### Auto-Instalación de Requisitos

| Requisito | Windows | macOS | Linux |
|-----------|---------|-------|-------|
| **pnpm** | `npm install -g pnpm` | `npm install -g pnpm` | `npm install -g pnpm` |
| **Python** | `winget install Python.Python.3.12` | `brew install python3` | `sudo apt install python3` |
| **Build Tools** | `winget install Microsoft.VisualStudio.2022.BuildTools` (workload VCTools) | `xcode-select --install` | `sudo apt install build-essential` |
| **better-sqlite3** | `pnpm rebuild better-sqlite3` | `pnpm rebuild better-sqlite3` | `pnpm rebuild better-sqlite3` |

## Método 2: Instalación Manual

### 1. Clonar y entrar al directorio

```bash
git clone https://github.com/your-org/octopus-ai.git
cd octopus-ai
```

### 2. Instalar dependencias

```bash
pnpm install
```

### 3. Compilar bindings nativos

```bash
pnpm rebuild better-sqlite3
```

Si falla con errores de `node-gyp`, verifica que Build Tools C++ esté instalado correctamente.

### 4. Compilar TypeScript

```bash
pnpm build
```

Esto compila 11 paquetes con Turborepo en paralelo (~15 segundos).

### 5. Configurar

```bash
node packages/cli/dist/index.js setup
```

O manualmente:

```bash
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_API_KEY"
```

### 6. Verificar instalación

```bash
node packages/cli/dist/index.js doctor
```

## Método 3: Docker

```bash
docker compose -f docker/docker-compose.yml up -d
```

## Verificación Post-Instalación

### Comando Doctor

```bash
node packages/cli/dist/index.js doctor
```

Resultado esperado:

```
  ✓ Node.js:             v22.x (>= 22)
  ✓ pnpm:                v10.x
  ✓ Python:              Python 3.x
  ✓ Build Tools (C++):   Visual Studio Build Tools detectado
  ✓ better-sqlite3:      Bindings nativos OK
  ✓ Config File:         ~/.octopus/config.json
  ✓ Config Valid:        Configuration is valid
  ✓ Database:            SQLite database accessible
  ✓ API Keys:            Z.ai ✓
  ✓ LLM Providers:       Available: zhipu
  ✓ Disk Space:          Writable
  ✓ Network:             Internet connectivity OK
```

### Test Rápido

```bash
node packages/cli/dist/index.js agent --message "Hola, responde en una frase" --stream
```

## Solución de Problemas de Instalación

### Error: "Could not locate the bindings file" (better-sqlite3)

Build Tools C++ no instalados o no detectados.

**Windows:**
```bash
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait"
pnpm rebuild better-sqlite3
```

**Linux:**
```bash
sudo apt install build-essential python3
pnpm rebuild better-sqlite3
```

### Error: "No AI providers available"

No se configuró ninguna API key:

```bash
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"
```

### Error: "Node.js version mismatch"

Octopus AI requiere Node.js >= 22:

```bash
node --version  # Debe ser v22.x o superior
```

Más soluciones en [Troubleshooting](../advanced/troubleshooting.md).

## Siguiente Paso

- [Inicio Rápido](./quick-start.md) — Tu primera conversación con Octopus AI
- [Configuración](./configuration.md) — Configurar proveedores, memoria y skills
