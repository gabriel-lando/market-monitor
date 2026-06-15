FROM node:lts-alpine AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm -r typecheck
RUN pnpm --filter @market-monitor/shared build
RUN pnpm --filter @market-monitor/db build
RUN pnpm --filter @market-monitor/frontend build
RUN pnpm --filter @market-monitor/backend build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tzdata

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/packages/db/migrations ./apps/backend/migrations
COPY --from=build /app/apps/frontend/dist ./apps/frontend/dist
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json

EXPOSE 3000

CMD ["node", "apps/backend/dist/index.js"]