FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.8.0 --activate

RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/plugins/coding/package.json packages/plugins/coding/
COPY packages/plugins/customer-support/package.json packages/plugins/customer-support/
COPY packages/plugins/data/package.json packages/plugins/data/
COPY packages/plugins/document-gen/package.json packages/plugins/document-gen/
COPY packages/plugins/file-manager/package.json packages/plugins/file-manager/
COPY packages/plugins/productivity/package.json packages/plugins/productivity/
COPY packages/plugins/research/package.json packages/plugins/research/
COPY packages/plugins/sales/package.json packages/plugins/sales/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/cli/ packages/cli/
COPY packages/plugins/ packages/plugins/

RUN pnpm build

RUN pnpm prune --prod

FROM node:22-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache python3

RUN corepack enable && corepack prepare pnpm@10.8.0 --activate

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=builder /app/packages/plugins/coding/dist ./packages/plugins/coding/dist
COPY --from=builder /app/packages/plugins/coding/package.json ./packages/plugins/coding/package.json
COPY --from=builder /app/packages/plugins/customer-support/dist ./packages/plugins/customer-support/dist
COPY --from=builder /app/packages/plugins/customer-support/package.json ./packages/plugins/customer-support/package.json
COPY --from=builder /app/packages/plugins/data/dist ./packages/plugins/data/dist
COPY --from=builder /app/packages/plugins/data/package.json ./packages/plugins/data/package.json
COPY --from=builder /app/packages/plugins/document-gen/dist ./packages/plugins/document-gen/dist
COPY --from=builder /app/packages/plugins/document-gen/package.json ./packages/plugins/document-gen/package.json
COPY --from=builder /app/packages/plugins/file-manager/dist ./packages/plugins/file-manager/dist
COPY --from=builder /app/packages/plugins/file-manager/package.json ./packages/plugins/file-manager/package.json
COPY --from=builder /app/packages/plugins/productivity/dist ./packages/plugins/productivity/dist
COPY --from=builder /app/packages/plugins/productivity/package.json ./packages/plugins/productivity/package.json
COPY --from=builder /app/packages/plugins/research/dist ./packages/plugins/research/dist
COPY --from=builder /app/packages/plugins/research/package.json ./packages/plugins/research/package.json
COPY --from=builder /app/packages/plugins/sales/dist ./packages/plugins/sales/dist
COPY --from=builder /app/packages/plugins/sales/package.json ./packages/plugins/sales/package.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

RUN mkdir -p /root/.octopus/data /root/.octopus/skills /root/.octopus/plugins

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:18789/api/health || exit 1

CMD ["sh", "-c", "node packages/cli/dist/index.js config set server.host '0.0.0.0' && node packages/cli/dist/index.js start"]
