FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml package.json ./
COPY packages ./packages

RUN pnpm install

COPY . .

CMD ["pnpm", "start"]
