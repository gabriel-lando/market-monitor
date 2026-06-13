# Market Monitor

Monorepo scaffold for a supermarket price monitoring platform.

## Workspaces

- `apps/backend`: Fastify backend, internal scheduler, API routes, and scrape orchestration scaffold
- `apps/frontend`: Vite + React UI scaffold for search and product history
- `packages/shared`: shared contracts and runtime constants
- `packages/db`: SQL migrations, seed logic, and Postgres bootstrap helpers
- `infra`: Docker Compose and Docker image build files

## Development

Install dependencies:

```bash
corepack pnpm install
```

Run the frontend locally against a real backend:

```bash
pnpm --filter @market-monitor/frontend dev
```

Set `VITE_API_BASE_URL` in `apps/frontend/.env` or `apps/frontend/.env.local` when the backend is not served from the same origin.

## Docker

The project publishes a single runtime image where the backend serves the built frontend assets for non-`/api` routes.

Compose is image-only and should point at Docker Hub images, not local Compose builds.
