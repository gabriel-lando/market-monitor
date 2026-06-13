# Market Monitor Agent Guide

This file is the project operating guide for future coding tasks and for anyone else working in this repository. It documents the current architecture, commands, deployment model, and the important implementation details that are easy to miss.

## Overview

Market Monitor is a monorepo for a supermarket price-monitoring platform.

Current stack:

- Node.js LTS
- `pnpm` installed globally
- Fastify backend
- React + Vite frontend
- PostgreSQL
- Docker Compose using published Docker Hub images only
- Gitea workflow for building and publishing one runtime image

Current implementation scope:

- One backend service that also serves built frontend assets in runtime images
- One frontend app for search and product detail/history validation
- One shared contracts package
- One database package with SQL-first migrations and seed logic
- One real market adapter implemented: `zaffari`

## Monorepo Layout

- `apps/backend`
  - Fastify API
  - internal scrape job execution
  - scheduler scaffold
  - Zaffari scraper adapter and persistence pipeline
- `apps/frontend`
  - Vite + React UI
  - lightweight search/detail/history interface
  - local hot reload support
- `packages/shared`
  - shared runtime constants
  - API and job contracts
  - normalized listing validation schema
- `packages/db`
  - SQL migrations
  - seed logic
  - Postgres client helpers
- `infra`
  - `docker-compose.yml`
  - `Dockerfile.app`
  - env examples
  - `init-db.sh`
- `.gitea/workflows`
  - Docker build and publish workflow
- `docs`
  - deployment notes

## Required Tooling

Current local development environment assumptions:

- running on WSL
- Node.js installed through `nvm`
- `pnpm` installed globally with `npm install -g pnpm`

Verified working pattern:

```bash
pnpm install
```

Important:

- Prefer running commands inside WSL, not PowerShell, for the normal local workflow.
- When validation is needed during an agent task, do not run it on the user's behalf unless they explicitly ask for that. Provide the exact WSL command in a copyable code block first, then ask the user to run it and share the output.
- The repository scripts currently use plain `pnpm` and do not require `corepack` for the intended local setup.
- Docker and Postgres may still be hosted elsewhere, but command examples in this repo should assume a WSL shell unless there is a reason not to.

## Root Commands

Run from repo root:

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm dev:backend
pnpm dev:frontend
```

Useful targeted commands:

```bash
pnpm --filter @market-monitor/backend dev
pnpm --filter @market-monitor/backend build
pnpm --filter @market-monitor/backend scrape-once zaffari
pnpm --filter @market-monitor/frontend dev
pnpm --filter @market-monitor/db migrate
pnpm --filter @market-monitor/db seed
```

## Runtime Configuration

Main env vars used by the backend:

- `DATABASE_URL`
- `APP_ENV`
- `SCRAPING_ENABLED`
- `MIGRATIONS_ENABLED`
- `LOG_LEVEL`
- `HOST`
- `PORT`
- `INTERNAL_API_KEY`
- `VITE_API_BASE_URL` for local frontend usage

`APP_ENV` values currently supported:

- `prod`
- `dev-ui-validation`
- `dev-scrape-sandbox`
- `local`

Behavior rules:

- `SCRAPING_ENABLED=false`
  - do not run background scraping
  - do not allow internal scrape execution
  - use read-only credentials in UI validation mode
- `MIGRATIONS_ENABLED=false`
  - skip startup migrations
- `LOG_LEVEL`
  - default `info`
  - expected `debug` for `dev-*` deployments

## Deployment Modes

### Production

- `SCRAPING_ENABLED=true`
- `MIGRATIONS_ENABLED=true` or according to deployment policy
- writer database credentials
- `LOG_LEVEL=info`

### Dev UI Validation

- `SCRAPING_ENABLED=false`
- `MIGRATIONS_ENABLED=false`
- read-only database credentials
- typically `LOG_LEVEL=debug`

Use this mode to validate the UI against real data without mutating the production database.

### Dev Scrape Sandbox

- `SCRAPING_ENABLED=true`
- writer credentials
- cloned or temporary database only
- typically `LOG_LEVEL=debug`

Never point a writable dev deployment at the production database.

## Docker and Publish Model

The project uses one runtime Docker image.

Current model:

- frontend builds into static assets
- backend serves those assets for non-`/api` requests
- Compose uses `image:` only
- deployment does not rely on Compose `build:`

Relevant files:

- `infra/Dockerfile.app`
- `infra/docker-compose.yml`
- `.gitea/workflows/docker-build-and-publish.yml`

Tag behavior in the Gitea workflow:

- Git tag push -> publish that tag
- `main` -> `latest`
- non-main branches -> `dev-<branch>` style tags

## Database Bootstrap

Use:

```bash
bash infra/init-db.sh --host localhost --admin-user postgres
```

The script creates:

- database: `market_monitor` by default
- writer role: `market_monitor_rw`
- reader role: `market_monitor_ro`

It supports:

- `--admin-password`
- `--rw-password`
- `--ro-password`
- `MARKET_MONITOR_ADMIN_PASSWORD`
- `MARKET_MONITOR_RW_PASSWORD`
- `MARKET_MONITOR_RO_PASSWORD`

Important limitation:

- The script grants privileges only on the target database.
- Fully preventing those roles from connecting to other databases may still require server-level ACL changes.

## Database Model

Current migrations create the main model for:

- `markets`
- `stores`
- `market_categories`
- `products`
- `product_identifiers`
- `market_listings`
- `market_listing_categories`
- `collection_runs`
- `price_snapshots`
- `raw_listing_payloads`

Seed logic currently inserts:

- market `zaffari`
- default store scope for `zaffari`

Migration notes:

- `packages/db/migrations/003_products_and_listings.sql` had previously become malformed during iterative edits; treat it as a sensitive file and avoid duplicating blocks when editing migrations.

## API Surface

Public routes live under `/api/v1`.

Current public routes:

- `GET /api/v1/health`
- `GET /api/v1/markets`
- `GET /api/v1/products`
- `GET /api/v1/products/:productId`
- `GET /api/v1/products/:productId/history`
- `GET /api/v1/products/:productId/compare`
- `GET /api/v1/listings/:listingId`
- `GET /api/v1/listings/:listingId/history`

Internal routes live under `/api/v1/internal`.

Current internal routes:

- `POST /api/v1/internal/jobs/scrape`
- `GET /api/v1/internal/jobs/runs`
- `GET /api/v1/internal/jobs/runs/:runId`

Behavior rules worth preserving:

- Search responses stay lightweight.
- Search does not return full history series.
- History is fetched only after selecting a product or listing.
- Default history interval is `6m`.
- Supported intervals are shared in `packages/shared`.
- `from` / `to` overrides take precedence over interval presets.

## Frontend Notes

The frontend is intentionally lightweight and currently focused on:

- search
- product selection
- interval selection
- on-demand history loading

Use `VITE_API_BASE_URL` when running the frontend against a separate backend origin.

When `VITE_API_BASE_URL` is unset, the frontend defaults API requests to `window.location.origin`.

Local UI development therefore needs the Vite `/api` proxy to `http://localhost:3000` to avoid HTML fallback responses from the dev server.

The frontend should continue consuming shared contracts from `packages/shared` instead of redefining API shapes locally.

## Scraper Architecture

Current adapter boundary:

- adapters emit normalized listings validated by `NormalizedListingSchema`
- persistence is handled separately in the pipeline
- job execution is orchestrated by `runScrapeOnce`

Key files:

- `apps/backend/src/scraping/adapters/base/types.ts`
- `apps/backend/src/scraping/adapters/index.ts`
- `apps/backend/src/scraping/adapters/zaffari/zaffari-adapter.ts`
- `apps/backend/src/scraping/pipeline/persist-run.ts`
- `apps/backend/src/scraping/pipeline/utils.ts`
- `apps/backend/src/scraping/jobs/run-scrape-once.ts`

### Zaffari-Specific Behavior

The current Zaffari implementation is based on VTEX endpoints.

Discovery endpoint:

- `https://www.zaffari.com.br/api/catalog_system/pub/category/tree/3`

Product search endpoint:

- `https://www.zaffari.com.br/api/catalog_system/pub/products/search?fq=C:<categoryId>&_from=<n>&_to=<m>`

Important runtime findings already verified:

- Tree leaf categories are not reliable scrape targets for product collection.
- The adapter currently scrapes top-level categories (`depth === 1`) instead.
- Category membership is still preserved from the product payload via `categoriesIds`.
- VTEX may return `400` once pagination moves beyond the available range for a broad category.
- The adapter treats `400` on later pages as an end-of-pagination stop, not a hard failure.
- Some product fields like `Cont_liq` and `UM_Cont` can appear as arrays.
- The adapter normalizes those fields by selecting the first scalar value.

Live validation already observed:

- category tree discovery returned `362` categories
- top-level category `1001` (`Mercearia`) returned `2550` normalized listings
- a known normalized sample was `Lentilha Premium Fritz & Frida 400g` with price `599`

## Scrape Job Flow

`runScrapeOnce` currently does the following:

1. validates runtime mode
2. resolves market adapter by market code
3. acquires a PostgreSQL advisory lock per market
4. resolves market/store ids
5. discovers categories
6. upserts category tree
7. scrapes target categories
8. persists products, identifiers, listings, listing-category links, daily snapshots, and raw payloads
9. updates `collection_runs`
10. releases the advisory lock

Persistence behavior worth preserving:

- product matching tries existing listing match first, then identifier-based reuse
- snapshots are idempotent on `(market_listing_id, store_id, snapshot_date)`
- raw payloads are stored with a SHA-256 hash

## Logging

The backend uses structured logging with `pino`.

Current expectations:

- production defaults to `info`
- `dev-*` deployments use `debug`
- logs should keep enough context for request ids, market code, and scrape job information

## Validation Commands

Baseline validation commands that should keep working:

```bash
pnpm -r typecheck
pnpm --filter @market-monitor/backend build
pnpm --filter @market-monitor/frontend build
```

Agent workflow for validation:

- Assume the user will run validation commands manually inside WSL.
- Show the command in a fenced `bash` block so it can be copied directly.
- After presenting the command, use a Q&A prompt to collect the resulting output before concluding whether the change is validated.

Useful live adapter probe pattern:

```bash
cd apps/backend
pnpm exec tsx -e "..."
```

Use an async IIFE with `.catch(...)`; do not rely on top-level await in `tsx -e` snippets because that can fail depending on output mode.

## Contributor Rules

- Use `pnpm` directly in normal local development.
- Assume WSL as the default shell environment for local commands.
- Keep command examples WSL-friendly unless a Windows-specific command is necessary.
- If an agent needs validation output, the agent should ask first, provide the exact WSL command, and collect the result from the user via a Q&A prompt instead of running it locally.
- Preserve the local frontend dev proxy behavior for `/api` requests unless the frontend API base resolution changes.
- Keep contracts centralized in `packages/shared`.
- Keep schema changes in `packages/db/migrations`.
- Keep adapter parsing separate from DB persistence.
- When changing history interval behavior, update both the shared constants and the consumers.
- Preserve the image-only Docker/Compose deployment model.
- Do not reintroduce local Compose `build:` as the default deployment path.
- Do not point writable dev deployments at the production database.

## Known Gaps / Next Likely Work

- The Zaffari scrape path is implemented and validated against live endpoints, but a full end-to-end run against a real Postgres sandbox should still be executed regularly.
- Matching is still exact-identifier oriented; richer cross-market fuzzy matching is future work.
- Scheduler behavior is scaffolded but not yet a full production scheduler implementation.
- Search and comparison queries are still straightforward SQL and may need refinement once real data volume grows.
