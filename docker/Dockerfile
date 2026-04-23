# =============================================================================
# Octopus AI — Production Dockerfile
# Multi-stage build for optimized container size and security
# =============================================================================

# Stage 1: Build
# Install all dependencies, compile TypeScript, prune dev dependencies
FROM node:22-alpine AS builder

WORKDIR /app

# Install build tools for native deps (better-sqlite3)
RUN apk add --no-cache python3 make g++ git

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json turbo.json ./

# Copy all package.json files first (for better layer caching)
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/ packages/

# Build everything
RUN pnpm run build

# Prune dev dependencies
RUN pnpm prune --prod

# =============================================================================
# Stage 2: Runtime
# Minimal image with only production dependencies
# =============================================================================
FROM node:22-alpine AS runtime

WORKDIR /app

# Install runtime-only native dependencies
RUN apk add --no-cache tini curl

# Create non-root user
RUN addgroup -g 1001 octopus && \
    adduser -D -u 1001 -G octopus octopus

# Copy production files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/package.json ./

# Create data directories
RUN mkdir -p /data/db /data/skills /data/logs /data/workspace && \
    chown -R octopus:octopus /data

# Copy SOUL.md templates
COPY --chown=octopus:octopus docker/templates/ /data/workspace/

# Switch to non-root user
USER octopus

# Environment
ENV NODE_ENV=production
ENV OCTOPUS_DATA_DIR=/data
ENV OCTOPUS_DB_PATH=/data/db/octopus.db
ENV OCTOPUS_LOG_LEVEL=info
ENV OCTOPUS_DAEMON_MODE=true

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose ports
# 3000 = HTTP API / Health
# 5173 = Web Dashboard (if included)
EXPOSE 3000

# Use tini as init
ENTRYPOINT ["/sbin/tini", "--"]

# Start in daemon mode
CMD ["node", "packages/cli/dist/index.js", "daemon"]
