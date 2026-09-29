FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

COPY .env ./

RUN pnpm build

RUN mkdir -p /app/data /app/logs

CMD ["pnpm", "start"]