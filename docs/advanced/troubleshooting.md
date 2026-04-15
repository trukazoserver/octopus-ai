# Solución de Problemas

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

## Errores de Instalación

### "Could not locate the bindings file" (better-sqlite3)

**Causa:** Build Tools C++ no instalados o better-sqlite3 no compilado.

**Windows:**
```bash
# Opción 1: Via instalador automático
node scripts/install.mjs

# Opción 2: Instalar Build Tools manualmente
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait"

# Luego reconstruir
pnpm rebuild better-sqlite3
```

**Linux:**
```bash
sudo apt install build-essential python3
pnpm rebuild better-sqlite3
```

**macOS:**
```bash
xcode-select --install
pnpm rebuild better-sqlite3
```

### "error C2039" o errores de compilación C++

**Causa:** Falta el workload correcto de Visual Studio.

**Solución:**
1. Abrir "Visual Studio Installer"
2. Click "Modify" en Build Tools 2022
3. Marcar "Desktop development with C++"
4. Instalar y luego: `pnpm rebuild better-sqlite3`

### "gyp ERR! find Python"

**Causa:** Python no está instalado o no está en PATH.

**Windows:**
```bash
winget install Python.Python.3.12
# Cerrar y reabrir terminal
```

**Linux/macOS:**
```bash
# Debian/Ubuntu
sudo apt install python3

# macOS
brew install python3
```

### "Node.js version mismatch"

Octopus AI requiere Node.js >= 22:

```bash
node --version  # Verificar versión actual

# Si es menor, actualizar:
# https://nodejs.org (LTS)
# o via nvm: nvm install 22
```

## Errores de Ejecución

### "No AI providers available"

**Causa:** No se configuró ninguna API key.

**Solución:**
```bash
# Configurar Z.ai (proveedor por defecto)
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"

# O configurar otro proveedor
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-..."
```

### "Z.ai API error (api): 429"

**Causa:** El endpoint `api` regular de Z.ai no tiene créditos.

**Solución:** Usar el endpoint `coding-plan`:
```bash
node packages/cli/dist/index.js config set ai.providers.zhipu.mode "coding-plan"
```

### "Config file not found at ~/.octopus/config.json"

**Causa:** No se ejecutó el setup.

**Solución:**
```bash
node packages/cli/dist/index.js setup
# o
node scripts/install.mjs
```

### "Cannot access database"

**Causa:** better-sqlite3 no compilado o path de BD inválido.

**Solución:**
```bash
# 1. Verificar bindings
node packages/cli/dist/index.js doctor

# 2. Si falla better-sqlite3, reconstruir
pnpm rebuild better-sqlite3

# 3. Verificar path de BD
node packages/cli/dist/index.js config get storage.path
```

## Errores de Proveedores

### Timeout al conectar con API

**Causa:** Problemas de red o proxy.

**Soluciones:**
```bash
# Verificar conectividad
node packages/cli/dist/index.js doctor

# Si estás detrás de proxy, verificar config
node packages/cli/dist/index.js config get connection.autoProxy

# Para conexiones lentas, aumentar timeout en el código fuente
# (packages/core/src/ai/providers/*.ts: AbortSignal.timeout)
```

### "Invalid API Key"

**Causa:** API key incorrecta o expirada.

**Solución:** Verificar y actualizar la key:
```bash
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-nueva-key"
```

## Errores de Build

### "Cannot find module" al compilar

**Causa:** Dependencias no instaladas.

**Solución:**
```bash
pnpm install
pnpm build
```

### TypeScript errors

**Causa:** Cambios en el código que rompen tipos.

**Solución:**
```bash
# Verificar errores sin compilar
pnpm run typecheck

# Limpiar y reconstruir
pnpm run clean
pnpm install
pnpm build
```

## Diagnosticar con Doctor

El comando `doctor` verifica todo el sistema:

```bash
node packages/cli/dist/index.js doctor
```

Salida con todos los checks:

```
  ✓ Node.js:             v22.x (>= 22)
  ✓ pnpm:                v10.x
  ✓ Python:              Python 3.x
  ✗ Build Tools (C++):   No detectado
  ✗ better-sqlite3:      Bindings nativos no compilados
  ✓ Config File:         ~/.octopus/config.json
  ✓ Config Valid:        Configuration is valid
  ✗ Database:            Cannot access database
  ✓ API Keys:            Z.ai ✓
  ✓ Disk Space:          Writable
  ✓ Network:             Internet connectivity OK
```

Cada ✗ indica un problema con sugerencia de corrección.

## Obtener Ayuda

Si tu problema no aparece aquí:

1. Ejecuta `doctor` y verifica todos los checks
2. Revisa la [Configuración](../getting-started/configuration.md)
3. Reporta el issue en GitHub con la salida de `doctor`
