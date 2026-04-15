# Guía de Docker para Octopus AI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Guía completa para ejecutar Octopus AI en contenedores Docker.

---

## 📋 Tabla de Contenidos

- [¿Qué es Docker?](#-qué-es-docker)
- [Instalación de Docker](#-instalación-de-docker)
- [Configuración](#-configuración)
- [Comandos Básicos](#-comandos-básicos)
- [Persistencia de Datos](#-persistencia-de-datos)
- [Acceso a la Interfaz Web](#-acceso-a-la-interfaz-web)
- [Variables de Entorno](#-variables-de-entorno)
- [Actualizar el Contenedor](#-actualizar-el-contenedor)
- [Solución de Problemas](#-solución-de-problemas)

---

## 🐳 ¿Qué es Docker?

Docker es una herramienta que te permite ejecutar aplicaciones dentro de "contenedores" — entornos aislados que ya tienen todo lo necesario para funcionar. Piensa en ello como una máquina virtual más ligera.

**Ventajas de usar Docker con Octopus AI:**
- No necesitas instalar Node.js, Python ni Build Tools en tu máquina
- Funciona igual en Windows, macOS y Linux
- Ideal para servidores y despliegues en producción
- Fácil de actualizar y mantener

---

## 📥 Instalación de Docker

### Windows

1. Descarga [Docker Desktop para Windows](https://www.docker.com/products/docker-desktop/)
2. Ejecuta el instalador
3. Reinicia tu equipo si te lo pide
4. Verifica que funciona abriendo PowerShell:
   ```powershell
   docker --version
   docker compose version
   ```

> **Requisito:** Windows 10/11 Pro, Enterprise o Education con WSL 2 habilitado.

### macOS

1. Descarga [Docker Desktop para Mac](https://www.docker.com/products/docker-desktop/)
2. Arrastra Docker a la carpeta Aplicaciones
3. Abre Docker desde Aplicaciones
4. Verifica en Terminal:
   ```bash
   docker --version
   docker compose version
   ```

### Linux (Debian/Ubuntu)

```bash
# Instalar Docker
sudo apt update
sudo apt install -y docker.io docker-compose-plugin

# Agregar tu usuario al grupo docker (para no usar sudo)
sudo usermod -aG docker $USER

# Cerrar sesión y volver a entrar, luego verificar:
docker --version
docker compose version
```

---

## ⚙️ Configuración

### 1. Clonar el repositorio

```bash
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai
```

### 2. Crear archivo de variables de entorno

Crea un archivo llamado `.env` dentro de la carpeta `docker/`:

```bash
# docker/.env
OCTOPUS_SERVER_PORT=18789
OCTOPUS_AI_DEFAULT=zhipu/glm-5.1

# Configura al menos una API Key
OCTOPUS_OPENAI_API_KEY=sk-tu-api-key-aqui
# OCTOPUS_ANTHROPIC_API_KEY=sk-ant-...
# OCTOPUS_ZHIPU_API_KEY=tu-key-zhipu
```

### 3. Construir e iniciar

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

### Nota importante sobre el Dockerfile actual

El `Dockerfile` incluido realiza `pnpm install` y copia el código fuente, pero **no ejecuta `pnpm build`** antes del CMD. Esto significa que necesitas construir el proyecto primero o modificar el Dockerfile.

**Opción A: Construir localmente primero**

```bash
pnpm install
pnpm build
docker compose -f docker/docker-compose.yml up -d --build
```

**Opción B: Modificar el Dockerfile** para incluir el paso de build

Edita `docker/Dockerfile` y añade `RUN pnpm build` antes del CMD:

```dockerfile
FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml package.json ./
COPY packages ./packages

RUN pnpm install
RUN pnpm build

COPY . .

CMD ["node", "packages/cli/dist/index.js", "start"]
```

> El CMD original usa `pnpm start` pero ese script no existe en el `package.json` raíz. Se recomienda usar `node packages/cli/dist/index.js start` directamente.

---

## 📋 Comandos Básicos

| Acción | Comando |
|---|---|
| **Iniciar** | `docker compose -f docker/docker-compose.yml up -d` |
| **Detener** | `docker compose -f docker/docker-compose.yml down` |
| **Ver logs** | `docker compose -f docker/docker-compose.yml logs -f` |
| **Reiniciar** | `docker compose -f docker/docker-compose.yml restart` |
| **Ver estado** | `docker compose -f docker/docker-compose.yml ps` |
| **Reconstruir** | `docker compose -f docker/docker-compose.yml up -d --build` |

> **Tip:** Si estás dentro de la carpeta `docker/`, puedes usar simplemente `docker compose up -d` sin el flag `-f`.

---

## 💾 Persistencia de Datos

El `docker-compose.yml` monta un volumen para que tus datos sobrevivan entre reinicios:

```yaml
volumes:
  - ~/.octopus/data:/root/.octopus/data
```

Esto significa que:
- La **base de datos** SQLite se guarda en `~/.octopus/data/` de tu máquina
- Las **conversaciones y memoria** se conservan al detener el contenedor
- Al actualizar el contenedor, tus datos no se pierden

### Rutas según sistema operativo

| SO | Ruta en tu máquina |
|---|---|
| **Windows** | `C:\Users\TuUsuario\.octopus\data` |
| **macOS** | `~/.octopus/data` |
| **Linux** | `~/.octopus/data` |

---

## 🌐 Acceso a la Interfaz Web

Una vez que el contenedor esté corriendo, accede a:

- **Servidor API:** `http://localhost:18789`
- **Dashboard Web:** Depende de la configuración. Si también inicias el frontend, estará en `http://localhost:5173`

Para iniciar el panel web junto con el contenedor:

```bash
# En otra terminal, con el proyecto clonado localmente
pnpm dev
```

---

## 🔧 Variables de Entorno

Todas las variables de entorno que puedes configurar en el archivo `.env`:

| Variable | Equivalente en config.json | Descripción |
|---|---|---|
| `OCTOPUS_SERVER_PORT` | `server.port` | Puerto del servidor (defecto: 18789) |
| `OCTOPUS_AI_DEFAULT` | `ai.default` | Modelo por defecto (defecto: `zhipu/glm-5.1`) |
| `OCTOPUS_OPENAI_API_KEY` | `ai.providers.openai.apiKey` | API Key de OpenAI |
| `OCTOPUS_ANTHROPIC_API_KEY` | `ai.providers.anthropic.apiKey` | API Key de Anthropic |
| `OCTOPUS_LOCAL_BASE_URL` | `ai.providers.local.baseUrl` | URL de Ollama local |
| `OCTOPUS_STORAGE_PATH` | `storage.path` | Ruta de la base de datos |

---

## 🔄 Actualizar el Contenedor

```bash
cd octopus-ai

# 1. Obtener la última versión del código
git pull origin main

# 2. Reconstruir y reiniciar el contenedor
docker compose -f docker/docker-compose.yml up -d --build
```

Tus datos se conservan gracias al volumen montado.

---

## 🔧 Solución de Problemas

### El contenedor no inicia

```bash
# Ver los logs para ver qué falla
docker compose -f docker/docker-compose.yml logs
```

### Error: "pnpm start" falla

El `package.json` raíz no tiene un script `start`. Modifica el CMD del Dockerfile como se explica en la sección [Configuración](#-configuración).

### Error: "Cannot find module"

El proyecto no se compiló dentro del contenedor. Añade `RUN pnpm build` al Dockerfile.

### Error: "No AI providers available"

No configuraste ninguna API Key. Añade al menos una en el archivo `.env`:

```env
OCTOPUS_ZHIPU_API_KEY=tu-key-aqui
```

### No puedo acceder desde el navegador

Verifica que el puerto 18789 no esté siendo usado por otra aplicación:

```bash
# Linux/macOS
lsof -i :18789

# Windows
netstat -ano | findstr :18789
```

### Permisos en Linux

Si tienes errores de permisos con el volumen:

```bash
sudo chown -R $USER:$USER ~/.octopus
```

---

## Siguientes Pasos

- ➡️ [Inicio Rápido](./quick-start.md) — Tu primera conversación
- ⚙️ [Configuración](./configuration.md) — Ajustar modelos y memoria
- 🔧 [Solución de Problemas General](../advanced/troubleshooting.md)
