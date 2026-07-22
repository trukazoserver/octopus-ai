# =============================================================================
# Octopus AI - Production Dockerfile
# Installs the full runtime stack inside the image with no interactive steps.
# =============================================================================

FROM node:22-bookworm-slim AS builder

WORKDIR /app

ENV CI=true \
	OCTOPUS_DOCKER=true \
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Full build/runtime prerequisites for native modules, media tools, browser tools,
# and local automation in Docker. Docker images should be self-contained.
RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	chromium \
	curl \
	ffmpeg \
	fonts-liberation \
	g++ \
	git \
	make \
	python3 \
	python3-pip \
	python3-venv \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.8.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod

# =============================================================================
# Runtime
# =============================================================================

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
	CI=true \
	OCTOPUS_DOCKER=true \
	OCTOPUS_DATA_DIR=/data \
	OCTOPUS_DB_PATH=/data/db/octopus.db \
	OCTOPUS_LOG_LEVEL=info \
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
	CHROME_BIN=/usr/bin/chromium \
	PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
	OCTOPUS_SOFFICE_PATH=/usr/bin/soffice \
	OCTOPUS_TESSDATA_PATH=/data/tessdata

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	chromium \
	curl \
	ffmpeg \
	fontconfig \
	fonts-dejavu-core \
	fonts-liberation \
	fonts-noto-core \
	libreoffice-calc \
	libreoffice-impress \
	libreoffice-writer \
	python3 \
	tini \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd -g 1001 octopus \
	&& useradd -u 1001 -g octopus -m -s /usr/sbin/nologin octopus \
	&& mkdir -p /data/db /data/skills /data/plugins /data/logs /data/workspace \
	&& chown -R octopus:octopus /data /app

RUN soffice --headless --version

COPY --from=builder --chown=octopus:octopus /app/package.json ./package.json
COPY --from=builder --chown=octopus:octopus /app/node_modules ./node_modules
COPY --from=builder --chown=octopus:octopus /app/packages ./packages
COPY --from=builder --chown=octopus:octopus /app/docker/templates /data/workspace

USER octopus

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
	CMD curl -f http://127.0.0.1:18789/api/status || exit 1

EXPOSE 18789

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/cli/dist/index.js", "start", "--no-open", "--no-choice"]
