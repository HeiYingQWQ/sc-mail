FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY apps ./apps
RUN pnpm prisma:generate && pnpm build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/main.js"]
