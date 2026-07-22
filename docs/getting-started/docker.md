# Guía de Docker para Octopus AI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Esta guía explica cómo ejecutar Octopus AI en contenedores usando el `Dockerfile` y `docker-compose.yml` incluidos. El despliegue Docker está pensado para instalación completa, reproducible y sin prompts.

---

## Qué Despliega Docker

El stack levanta un único servicio `octopus` con:

- Imagen multi-stage basada en Node.js 22 Bookworm Slim.
- Runtime completo dentro del contenedor: Node.js, pnpm, Python, Build Tools, Chromium, ffmpeg, LibreOffice Writer/Calc/Impress, fuentes, OCR offline `eng+spa`, curl y tini.
- Servidor Octopus en `http://localhost:18789`.
- API HTTP, WebSocket y UI web compilada en el mismo puerto `18789`.
- Healthcheck contra `http://127.0.0.1:18789/api/status`.
- Volumen persistente `/data` para base de datos, skills, plugins y logs.
- Workspace en `/data/workspace` con plantillas `SOUL.md` y `HEARTBEAT.md`.

A diferencia de una instalación local interactiva, Docker instala todo lo necesario dentro de la imagen aunque tu host no tenga Python, Build Tools, Chromium o ffmpeg.

---

## Requisitos del Host

Solo necesitas:

- Docker Desktop o Docker Engine reciente.
- Docker Compose v2.

Verificación:

```bash
docker --version
docker compose version
```

Si usas el instalador local `pnpm run install:octopus`, también puede detectar Docker y ofrecer instalarlo si falta.

---

## Arranque Rápido

Desde la raíz del repositorio:

```bash
pnpm run docker:up
```

Comando equivalente:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Después del arranque:

- UI/API/WebSocket: `http://localhost:18789`
- Estado: `http://localhost:18789/api/status`
- Healthcheck simple: `http://localhost:18789/health`

---

## Variables de Entorno

Puedes crear un archivo `.env` en la raíz del repositorio o exportar variables antes de levantar el stack. Docker Compose las inyecta al contenedor.

```env
# Proveedor recomendado por defecto
ZHIPU_API_KEY=tu-key-zhipu

# Proveedores alternativos
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# GOOGLE_API_KEY=tu-key-google
# DEEPSEEK_API_KEY=tu-key-deepseek

# Tokens de canales
# TELEGRAM_BOT_TOKEN=123456:ABCDEF
# DISCORD_BOT_TOKEN=...
# SLACK_BOT_TOKEN=...

# Opcional: almacenamiento externo/vectorial
# OCTOPUS_POSTGRES_URL=postgres://...
# OCTOPUS_VECTOR_URL=https://...
# OCTOPUS_QDRANT_URL=http://...
```

Si no defines API keys, el contenedor arranca igual. Podrás entrar a `http://localhost:18789` y configurar proveedores desde la UI o usando CLI dentro del contenedor.

---

## Persistencia de Datos

La configuración monta:

```yaml
volumes:
  - octopus-data:/data
  - ./workspace:/data/workspace
```

Esto conserva:

- Base de datos en `/data/db/octopus.db`.
- Skills en `/data/skills`.
- Plugins en `/data/plugins`.
- Logs en `/data/logs`.
- Workspace operativo en `/data/workspace`.
- Memoria, conversaciones, aprendizajes, tareas y automatizaciones.

Para borrar todo el estado persistente:

```bash
docker compose -f docker/docker-compose.yml down -v
```

---

## Comandos Comunes

| Acción | Comando |
|---|---|
| Construir imagen | `pnpm run docker:build` |
| Iniciar/reconstruir | `pnpm run docker:up` |
| Detener | `pnpm run docker:down` |
| Ver logs | `docker compose -f docker/docker-compose.yml logs -f` |
| Ver estado | `docker compose -f docker/docker-compose.yml ps` |
| Entrar al contenedor | `docker exec -it octopus-ai sh` |
| Diagnóstico interno | `docker exec -it octopus-ai node packages/cli/dist/index.js doctor` |

---

## Configurar Proveedor Dentro del Contenedor

Puedes pasar variables por `.env` o configurar después:

```bash
docker exec -it octopus-ai node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"
docker exec -it octopus-ai node packages/cli/dist/index.js config set ai.default "zhipu/glm-5.1"
```

La configuración se guarda en el volumen `/data`, por lo que sobrevive a recreaciones del contenedor.

---

## Qué Incluye la Imagen

La imagen instala explícitamente:

- `node:22-bookworm-slim`
- `pnpm@10.8.0`
- `python3`, `python3-pip`, `python3-venv`
- `g++`, `make`, `git`
- `chromium`
- `ffmpeg`
- `fonts-liberation`
- `fonts-dejavu-core`, `fonts-noto-core`, `fontconfig`
- `libreoffice-writer`, `libreoffice-calc`, `libreoffice-impress`
- Modelos Tesseract.js `eng` y `spa` empaquetados por npm
- `curl`
- `tini`

Esto cubre ejecución del backend, UI compilada, herramientas de media, browser automation, scripts Python, creación/edición documental, formatos legacy, conversión Office a PDF y QA visual.

---

## Healthcheck y Observabilidad

La imagen usa:

```bash
curl -f http://127.0.0.1:18789/api/status
```

Inspección manual:

```bash
curl http://localhost:18789/api/status
docker compose -f docker/docker-compose.yml logs -f
```

Si el contenedor aparece `unhealthy`, revisa logs y valida que no haya otro servicio usando el puerto `18789` en el host.

---

## Actualizar el Despliegue

```bash
git pull origin main
pnpm run docker:up
```

El comando reconstruye la imagen si cambió el código y conserva `octopus-data`.

---

## Problemas Comunes

### El contenedor no arranca

```bash
docker compose -f docker/docker-compose.yml logs
```

Revisa errores de API keys, permisos de volumen o puerto ocupado.

### El puerto 18789 está ocupado

Cambia el puerto publicado en `docker/docker-compose.yml`:

```yaml
ports:
  - "18800:18789"
```

Luego accede por `http://localhost:18800`.

### No hay proveedores disponibles

Configura al menos una API key válida:

```env
ZHIPU_API_KEY=tu-key-zhipu
```

O configúrala dentro del contenedor con `config set`.

### Necesitas sandbox aislado desde dentro de Octopus

La tool `sandbox_execute` requiere Docker disponible para el runtime. Si quieres ejecutar contenedores desde dentro del contenedor principal, deberás montar el socket Docker del host bajo tu propio modelo de seguridad. No se monta por defecto.

---

## Siguientes Pasos

- [Inicio Rápido](./quick-start.md) — Primer uso del asistente
- [Configuración](./configuration.md) — Modelos, memoria, aprendizaje y canales
- [API HTTP y WebSocket](../api/http.md) — Endpoints del backend
