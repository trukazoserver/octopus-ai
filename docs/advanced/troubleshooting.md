# Solución de Problemas

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

Si tienes problemas con Octopus AI, esta guía te ayudará a resolverlos.

---

## 📋 Tabla de Contenidos

- [Herramienta de Diagnóstico](#-herramienta-de-diagnóstico-doctor)
- [Errores de Instalación](#-errores-de-instalación)
- [Errores de Ejecución](#-errores-de-ejecución)
- [Errores de Proveedores de IA](#-errores-de-proveedores-de-ia)
- [Errores de Build / Compilación](#-errores-de-build--compilación)
- [Problemas con Docker](#-problemas-con-docker)
- [Problemas con la App de Escritorio](#-problemas-con-la-app-de-escritorio)
- [Problemas con el Panel Web](#-problemas-con-el-panel-web)
- [Problemas de Conectividad con Canales](#-problemas-de-conectividad-con-canales)
- [Problemas de Memoria (Base de Datos)](#-problemas-de-memoria-base-de-datos)
- [Problemas de Aprendizaje Continuo](#-problemas-de-aprendizaje-continuo)
- [FAQ (Preguntas Frecuentes)](#-faq-preguntas-frecuentes)

---

## 🔍 Herramienta de Diagnóstico: `doctor`

El primer paso para cualquier problema es ejecutar el diagnóstico:

```bash
node packages/cli/dist/index.js doctor
```

Salida con todos los checks:

```text
  ✓ Node.js:             v22.x (>= 22)
  ✓ pnpm:                v10.x
  ✓ Python:              Python 3.x
  ✓ Config File:         ~/.octopus/config.json
  ✓ Config Valid:        Configuration is valid
  ✓ Database:            OK
  ✓ API Keys:            Z.ai ✓
  ✓ Disk Space:          Writable
  ✓ Network:             Internet connectivity OK
```

Cada ✗ indica un problema con sugerencia de corrección.

---

## 📥 Errores de Instalación

### "Could not locate the bindings file" en una dependencia nativa

**Causa:** Alguna dependencia opcional usa `node-gyp` y no encuentra Python o compiladores. La base de datos principal usa `sql.js` WASM y no necesita `better-sqlite3`.

**Windows:**
```bash
# Opción 1: Via instalador interactivo
pnpm run install:octopus

# Opción 2: Instalar Build Tools manualmente
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait"

# Luego reconstruir la dependencia afectada si aplica
pnpm rebuild
```

**Linux:**
```bash
sudo apt install build-essential python3
pnpm rebuild
```

**macOS:**
```bash
xcode-select --install
pnpm rebuild
```

---

### "error C2039" o errores de compilación C++

**Causa:** Falta el workload correcto de Visual Studio.

**Solución:**
1. Abrir **Visual Studio Installer**
2. Click **Modify** en Build Tools 2022
3. Marcar **"Desktop development with C++"**
4. Instalar y luego: `pnpm rebuild`

---

### "gyp ERR! find Python"

**Causa:** Python no está instalado o no está en PATH.

**Windows:**
```powershell
winget install Python.Python.3.12
# Cerrar y reabrir la terminal
```

**Linux/macOS:**
```bash
# Debian/Ubuntu
sudo apt install python3

# macOS
brew install python3
```

---

### "Node.js version mismatch"

Octopus AI requiere Node.js >= 22:

```bash
node --version   # Verificar versión actual

# Si es menor, actualizar:
# Desde https://nodejs.org (descargar LTS)
# O via nvm:
nvm install 22
nvm use 22
```

---

### "pnpm: command not found"

```bash
# Instalar pnpm globalmente
npm install -g pnpm

# Verificar
pnpm --version
```

---

## ⚡ Errores de Ejecución

### "No AI providers available"

**Causa:** No se configuró ninguna API key.

**Solución:**
```bash
# Configurar Z.ai (proveedor por defecto)
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"

# O configurar otro proveedor
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-..."
```

---

### "Z.ai API error (api): 429"

**Causa:** El endpoint `api` regular de Z.ai no tiene créditos.

**Solución:** Usar el endpoint `coding-plan`:
```bash
node packages/cli/dist/index.js config set ai.providers.zhipu.mode "coding-plan"
```

---

### "Config file not found at ~/.octopus/config.json"

**Causa:** No se ejecutó el setup.

**Solución:**
```bash
pnpm run install:octopus:skip-start
# o
node packages/cli/dist/index.js setup
```

---

### "Cannot access database"

**Causa:** path de BD inválido, permisos insuficientes o archivo SQLite corrupto. El runtime usa `sql.js` WASM con persistencia en disco.

**Solución:**
```bash
# 1. Ejecutar diagnóstico
node packages/cli/dist/index.js doctor

# 2. Verificar path de BD
node packages/cli/dist/index.js config get storage.path

# 3. Confirmar permisos de escritura en ~/.octopus/data
```

---

## 🤖 Errores de Proveedores de IA

### Timeout al conectar con API

**Causa:** Problemas de red o proxy.

**Soluciones:**
```bash
# Verificar conectividad
node packages/cli/dist/index.js doctor

# Si estás detrás de proxy, verificar config
node packages/cli/dist/index.js config get connection.autoProxy

# Habilitar auto-proxy
node packages/cli/dist/index.js config set connection.autoProxy true
```

---

### "Invalid API Key"

**Causa:** API key incorrecta o expirada.

**Solución:** Verificar y actualizar la key:
```bash
# Ver la key actual
node packages/cli/dist/index.js config get ai.providers.openai.apiKey

# Actualizar
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-nueva-key"
```

---

### "Model not found" o "Model not available"

**Causa:** El modelo especificado no existe o no está disponible para tu cuenta.

**Solución:**
```bash
# Cambiar a un modelo disponible
node packages/cli/dist/index.js config set ai.default "zhipu/glm-5.1"
```

---

## 🔨 Errores de Build / Compilación

### "Cannot find module" al compilar

**Causa:** Dependencias no instaladas.

**Solución:**
```bash
pnpm install
pnpm build
```

---

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

---

### Error de memoria durante la compilación

**Causa:** Poca memoria RAM disponible.

**Solución:**
```bash
# Aumentar memoria para Node.js
export NODE_OPTIONS="--max-old-space-size=4096"
pnpm build
```

---

## 🐳 Problemas con Docker

### El contenedor no inicia

```bash
# Ver los logs
docker compose -f docker/docker-compose.yml logs

# Ver estado del contenedor
docker compose -f docker/docker-compose.yml ps
```

---

### Error: `unhealthy` en Docker

**Causa:** El healthcheck no puede leer `http://127.0.0.1:18789/api/status` dentro del contenedor, normalmente por fallo de arranque, API/config inválida o puerto ocupado.

**Solución:**
```bash
docker compose -f docker/docker-compose.yml logs -f
docker exec -it octopus-ai node packages/cli/dist/index.js doctor
```

---

### No puedo acceder a la interfaz web

```bash
# Verificar que el puerto está mapeado correctamente
docker compose -f docker/docker-compose.yml ps

# Verificar que no hay otro servicio usando el puerto
# Linux/macOS
lsof -i :18789
# Windows
netstat -ano | findstr :18789
```

La URL correcta para Docker y servidor estable local es `http://localhost:18789`, no `3000` ni `5173`.

---

### Problemas de permisos con el volumen (Linux)

```bash
# Dar permisos al directorio de datos
sudo chown -R $USER:$USER ~/.octopus
```

---

## 🖥️ Problemas con la App de Escritorio

### La app no abre ninguna ventana

**Causa:** Electron no se instaló correctamente.

```bash
# Verificar que Electron está instalado
cd packages/desktop
ls node_modules/electron

# Reinstalar si falta
pnpm install
```

---

### Error al compilar el paquete desktop

```bash
cd packages/desktop

# Verificar errores
pnpm typecheck

# Limpiar y recompilar
pnpm clean
pnpm build
```

---

### La app no conecta con el backend

Asegúrate de que el servidor Core esté corriendo:
```bash
pnpm start
```

El servidor debe estar en `http://127.0.0.1:18789`.

---

### Problemas en Linux (librerías faltantes)

```bash
# Debian/Ubuntu
sudo apt install -y libgtk-3-dev libnotify-dev libxss1 libxtst6 libnss3 libasound2

# Fedora
sudo dnf install -y gtk3 libnotify libXScrnSaver libXtst nss alsa-lib
```

---

## 🌐 Problemas con el Panel Web

### "No se puede acceder a 127.0.0.1:18789"

```bash
# Verificar que el proceso está activo
# Windows
netstat -ano | findstr :18789

# macOS/Linux
lsof -i :18789

# Reiniciar
pnpm start
```

`localhost:3000` se usa solo para desarrollo del dashboard con `pnpm run start:web`. `localhost:5173` se usa para el renderer desktop/Vite.

---

### El chat no responde en el panel web

1. Verifica que el backend está corriendo:
   ```bash
   node packages/cli/dist/index.js doctor
   ```

2. Verifica que tienes API Keys configuradas:
   ```bash
   node packages/cli/dist/index.js config get ai.providers.zhipu.apiKey
   ```

---

### La página carga mal o sin estilos

Limpia la caché del navegador: `Ctrl + Shift + R` (o `Cmd + Shift + R` en Mac).

---

## 📱 Problemas de Conectividad con Canales

### WhatsApp: El código QR no aparece

```bash
# Asegúrate de que el canal está habilitado
node packages/cli/dist/index.js channels enable whatsapp

# Verificar estado
node packages/cli/dist/index.js channels status
```

---

### Telegram: "Unauthorized" o "Invalid token"

1. Verifica el token con @BotFather
2. Actualiza la configuración:
   ```bash
   node packages/cli/dist/index.js config set channels.telegram.token "NUEVO_TOKEN"
   ```

---

### Discord: "Disallowed intent"

1. Ve a Discord Developer Portal → Tu bot → Privileged Gateway Intents
2. Habilita los intents necesarios (Message Content, Presence, Server Members)
3. Reinicia Octopus AI

---

### Slack: "missing_scope"

La app de Slack no tiene los permisos necesarios. Ve a api.slack.com/apps → OAuth & Permissions y añade los scopes requeridos.

---

## 🧠 Problemas de Memoria (Base de Datos)

### La memoria no funciona o no recuerda nada

```bash
# Verificar que la memoria está habilitada
node packages/cli/dist/index.js config get memory.enabled

# Si es false, habilitarla
node packages/cli/dist/index.js config set memory.enabled true

# Verificar la base de datos
node packages/cli/dist/index.js doctor
```

---

### Error: "database is locked"

**Causa:** Otra instancia de Octopus AI está usando la base de datos.

**Solución:**
```bash
# Verificar procesos de Octopus
# Linux/macOS
ps aux | grep octopus

# Windows
tasklist | findstr node

# Cerrar la otra instancia antes de continuar
```

---

### La base de datos crece mucho

```bash
# Ver el tamaño del archivo
# Linux/macOS
du -h ~/.octopus/data/octopus.db

# Windows
dir "%USERPROFILE%\.octopus\data\octopus.db"
```

La base de datos puede crecer con el uso. Puedes consolidar la memoria para optimizar:

```bash
node packages/cli/dist/index.js memory consolidate
```

---

## 📈 Problemas de Aprendizaje Continuo

### No aparecen aprendizajes nuevos

```bash
# Verificar que learning está activo
node packages/cli/dist/index.js config get learning.enabled

# Si está desactivado, activarlo
node packages/cli/dist/index.js config set learning.enabled true

# Ver insights desde la API con el backend activo
curl http://localhost:18789/api/learning/insights
```

El motor guarda aprendizajes cuando la experiencia tiene suficiente confianza. Si una respuesta fue muy corta, ambigua o fallida, puede no guardar insights nuevos.

---

### Octopus aprendió algo incorrecto

Puedes borrar el insight incorrecto o enviar feedback negativo:

```bash
# Borrar insight por id
curl -X DELETE http://localhost:18789/api/learning/insights/INSIGHT_ID

# Enviar feedback negativo a la conversación
curl -X POST http://localhost:18789/api/learning/feedback \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"CONV_ID","rating":"negative","comment":"Este aprendizaje no aplica"}'
```

---

### Demasiados aprendizajes en el contexto

Reduce el presupuesto de contexto:

```bash
node packages/cli/dist/index.js config set learning.maxInsightsPerContext 3
node packages/cli/dist/index.js config set learning.maxContextTokens 500
```

---

## ❓ FAQ (Preguntas Frecuentes)

### ¿Necesito internet para usar Octopus AI?

Solo si usas proveedores de IA en la nube (OpenAI, Anthropic, etc.). Si usas Ollama con modelos locales, funciona 100% offline.

### ¿Puedo usar múltiples proveedores de IA a la vez?

Sí. Configura un proveedor principal (`ai.default`) y un fallback (`ai.fallback`). Si el principal falla, usa el fallback automáticamente.

### ¿Se pierden mis datos al actualizar?

No. Los datos se almacenan en `~/.octopus/data/` separado del código fuente. Al hacer `git pull` y reconstruir, tus datos se conservan.

### ¿Cuántos recursos consume?

- **Mínimo:** ~200 MB RAM (solo CLI con proveedor en la nube)
- **Recomendado:** ~2 GB RAM (con panel web y memoria activa)
- **Con Ollama:** +4 GB RAM (depende del modelo local)

### ¿Puedo usar Octopus AI en un servidor?

Sí. Puedes usar Docker para desplegar en servidores. Consulta la [Guía de Docker](../getting-started/docker.md).

### ¿Cómo cambio el idioma de las respuestas?

Las respuestas dependen del modelo y de las instrucciones que le des. Puedes decirle: "A partir de ahora, responde siempre en español" y la IA lo recordará gracias a la memoria.

---

## Obtener Ayuda

Si tu problema no aparece aquí:

1. Ejecuta `node packages/cli/dist/index.js doctor` y verifica todos los checks
2. Revisa la [Configuración](../getting-started/configuration.md)
3. Reporta el issue en [GitHub](https://github.com/trukazoserver/octopus-ai/issues) con la salida de `doctor`
