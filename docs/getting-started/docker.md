# Guía de Docker para Octopus AI

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Guía actualizada para ejecutar Octopus AI en contenedores usando el `Dockerfile` y `docker-compose.yml` incluidos en el repositorio.

---

## Qué Despliega la Configuración Actual

El despliegue Docker del repositorio está orientado a operación continua y arranca un único servicio `octopus` con:

- imagen multi-stage basada en Node.js 22
- puerto `3000` para HTTP y healthcheck
- volumen persistente en `/data`
- workspace montado en `/data/workspace`
- plantillas iniciales `SOUL.md` y `HEARTBEAT.md`

---

## Requisitos

- Docker Desktop o Docker Engine reciente
- Docker Compose v2

Verificación rápida:

```bash
docker --version
docker compose version
```

---

## Arranque Rápido

```bash
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai
docker compose -f docker/docker-compose.yml up -d --build
```

Después del arranque:

- API y healthcheck: `http://localhost:3000`
- healthcheck simple: `http://localhost:3000/health`

---

## Variables de Entorno

Crea un archivo `.env` junto al `docker-compose.yml` dentro de `docker/` o exporta estas variables antes de levantar el stack:

```env
ZHIPU_API_KEY=tu-key-zhipu
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# GOOGLE_API_KEY=tu-key-google
# DEEPSEEK_API_KEY=tu-key-deepseek

# Tokens de canales
# TELEGRAM_BOT_TOKEN=123456:ABCDEF
# DISCORD_BOT_TOKEN=...
# SLACK_BOT_TOKEN=...
```

El `docker-compose.yml` tambien exporta variables de proceso útiles para el contenedor, como `OCTOPUS_DATA_DIR`, `OCTOPUS_DB_PATH` y `OCTOPUS_LOG_LEVEL`.

---

## Persistencia de Datos

La configuración incluida monta:

```yaml
volumes:
  - octopus-data:/data
  - ./workspace:/data/workspace
```

Esto deja persistidos:

- base de datos en `/data/db/octopus.db`
- skills y artefactos del sistema en `/data/skills`
- logs en `/data/logs`
- archivos operativos del workspace en `/data/workspace`

En el primer arranque se copian plantillas base como `SOUL.md` y `HEARTBEAT.md` al workspace del contenedor.

---

## Comandos Comunes

| Acción | Comando |
|---|---|
| Iniciar | `docker compose -f docker/docker-compose.yml up -d` |
| Reconstruir | `docker compose -f docker/docker-compose.yml up -d --build` |
| Ver logs | `docker compose -f docker/docker-compose.yml logs -f` |
| Ver estado | `docker compose -f docker/docker-compose.yml ps` |
| Detener | `docker compose -f docker/docker-compose.yml down` |

---

## Dashboard Web

El contenedor actual expone el backend HTTP/health. El dashboard React se usa normalmente aparte durante desarrollo con:

```bash
pnpm dev
```

Si deseas servir tambien la UI desde la misma imagen, necesitas incluir `packages/web/dist` en la imagen runtime o usar un contenedor adicional para frontend.

---

## Healthcheck y Observabilidad

La imagen incorpora:

- `curl` para el healthcheck interno
- `tini` como init process
- healthcheck contra `http://localhost:3000/health`

Para inspección manual:

```bash
docker compose -f docker/docker-compose.yml logs -f
curl http://localhost:3000/health
```

---

## Actualizar el Despliegue

```bash
git pull origin main
docker compose -f docker/docker-compose.yml up -d --build
```

El volumen `octopus-data` conserva la base de datos y el estado persistente entre recreaciones del contenedor.

---

## Problemas Comunes

### El contenedor no arranca

```bash
docker compose -f docker/docker-compose.yml logs
```

### El healthcheck falla

Comprueba que el contenedor esté exponiendo el puerto `3000` y que no haya otro proceso ocupándolo en tu host.

### No hay proveedores disponibles

Configura al menos una API key válida en `docker/.env`, por ejemplo:

```env
ZHIPU_API_KEY=tu-key-zhipu
```

### Necesitas sandbox aislado dentro del asistente

La tool `sandbox_execute` depende de Docker disponible para el runtime donde se ejecute Octopus. Si la usas fuera del contenedor principal, instala Docker Desktop/Engine en esa máquina.

---

## Siguientes Pasos

- [Inicio Rápido](./quick-start.md) — Primer uso del asistente
- [Configuración](./configuration.md) — Modelos, memoria y canales
- [API HTTP y WebSocket](../api/http.md) — Endpoints del backend
