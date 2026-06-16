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

### Run Backend + Frontend Locally (WSL)

From the repository root in WSL, install dependencies and load env vars:

```bash
corepack pnpm install
set -a
source .env
set +a
```

Start the backend in one terminal:

```bash
pnpm dev:backend
```

Start the frontend in another terminal:

```bash
pnpm dev:frontend
```

Equivalent direct workspace commands are:

```bash
pnpm --filter @market-monitor/backend dev
pnpm --filter @market-monitor/frontend dev
```

### Run Backend Jobs Directly (WSL)

From the repository root in WSL, load environment variables from `.env`:

```bash
set -a
source .env
set +a
```

Run a one-off scrape directly:

```bash
pnpm --filter @market-monitor/backend scrape-once carrefour --reason "manual run"
```

Run listings reclassification in dry-run mode:

```bash
pnpm --filter @market-monitor/backend reclassify-listings carrefour --only-source-seed --dry-run
```

Apply listings reclassification:

```bash
pnpm --filter @market-monitor/backend reclassify-listings carrefour --only-source-seed
```

Run interactive manual duplicate review and merge:

```bash
pnpm --filter @market-monitor/backend merge-products-manual --dry-run --limit 30
```

Run without manual review (defaults: target index 1, source indices all others):

```bash
pnpm --filter @market-monitor/backend merge-products-manual --no-review --dry-run --limit 30
```

Single-request validation of all merge options without prompts:

```bash
pnpm --filter @market-monitor/backend merge-products-manual --no-review --dry-run --market carrefour --limit 100
```

Optional filters:

```bash
pnpm --filter @market-monitor/backend merge-products-manual --market carrefour --limit 30
pnpm --filter @market-monitor/backend merge-products-manual --normalized-name "leite em po ninho integral 380g" --dry-run
```

## Docker

The project publishes a single runtime image where the backend serves the built frontend assets for non-`/api` routes.

Compose is image-only and should point at Docker Hub images, not local Compose builds.

## Internal API

All routes under `/api/v1/internal` require the `INTERNAL_API_KEY` environment variable to be configured on the backend and sent in the `x-internal-api-key` header.

Example scrape request:

```bash
curl -i -X POST "http://localhost:3000/api/v1/internal/jobs/scrape" \
	-H "Content-Type: application/json" \
	-H "x-internal-api-key: your-internal-api-key" \
	--data '{"market":"atacadao","reason":"manual run"}'
```

Example reclassification request:

```bash
curl -i -X POST "http://localhost:3000/api/v1/internal/jobs/reclassify-listings" \
	-H "Content-Type: application/json" \
	-H "x-internal-api-key: your-internal-api-key" \
	--data '{"market":"carrefour","only_source_seed":true,"dry_run":true,"limit":1000}'
```
