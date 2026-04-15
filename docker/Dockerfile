FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

RUN apk add --no-cache python3 make g++

COPY . .

RUN pnpm install

RUN cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run build-release || cd /app && pnpm rebuild better-sqlite3

RUN pnpm build

RUN mkdir -p /root/.octopus/data /root/.octopus/skills /root/.octopus/plugins

EXPOSE 18789

CMD ["sh", "-c", "node packages/cli/dist/index.js config set server.host '0.0.0.0' && node packages/cli/dist/index.js start"]
