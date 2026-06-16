# One-Page Product Data Fix Runbook

This runbook is the recommended order to fix product matching, relinking, and duplicate products in the database with low risk.

## Scope

Use this when you want to clean product issues across markets (for example: `carrefour`, `atacadao`, `zaffari`).

## Safety Rules

1. Always start with a DB backup.
2. Always run `--dry-run` before applying.
3. Process one market at a time.
4. Use small merge batches first.
5. If metrics look suspicious, stop and switch to manual review.

## 1) Backup Database

```bash
pg_dump "$DATABASE_URL" > backup_before_product_fixes_$(date +%F_%H%M%S).sql
```

## 2) Load Environment (WSL)

```bash
set -a
source .env
set +a
```

## 3) Reclassify Listings (Dry-Run, Market by Market)

```bash
pnpm --filter @market-monitor/backend reclassify-listings carrefour --only-source-seed --dry-run
pnpm --filter @market-monitor/backend reclassify-listings atacadao --only-source-seed --dry-run
pnpm --filter @market-monitor/backend reclassify-listings zaffari --only-source-seed --dry-run
```

Check each result before moving on:

- `skippedNoMatch` should be small.
- `relinkedProduct` can be non-zero.
- Very large unexpected jumps are a warning sign.

## 4) Reclassify Listings (Apply, Market by Market)

```bash
pnpm --filter @market-monitor/backend reclassify-listings carrefour --only-source-seed
pnpm --filter @market-monitor/backend reclassify-listings atacadao --only-source-seed
pnpm --filter @market-monitor/backend reclassify-listings zaffari --only-source-seed
```

## 5) Duplicate Merge (No-Review Dry-Run)

Default behavior in no-review mode:

- target index = 1
- source indices = all remaining

```bash
pnpm --filter @market-monitor/backend merge-products-manual --no-review --dry-run --market carrefour --limit 100
pnpm --filter @market-monitor/backend merge-products-manual --no-review --dry-run --market atacadao --limit 100
pnpm --filter @market-monitor/backend merge-products-manual --no-review --dry-run --market zaffari --limit 100
```

Review the end summary table before applying.

## 6) Duplicate Merge (No-Review Apply in Small Batches)

Start small and repeat until clean enough:

```bash
pnpm --filter @market-monitor/backend merge-products-manual --no-review --market carrefour --limit 30
pnpm --filter @market-monitor/backend merge-products-manual --no-review --market atacadao --limit 30
pnpm --filter @market-monitor/backend merge-products-manual --no-review --market zaffari --limit 30
```

## 7) Manual Review for Edge Cases

Use manual mode for ambiguous groups:

```bash
pnpm --filter @market-monitor/backend merge-products-manual --market carrefour --limit 50
pnpm --filter @market-monitor/backend merge-products-manual --market atacadao --limit 50
pnpm --filter @market-monitor/backend merge-products-manual --market zaffari --limit 50
```

## 8) Final Verification

Run full reclassification dry-run to confirm residual issues are low:

```bash
pnpm --filter @market-monitor/backend reclassify-listings carrefour --dry-run
pnpm --filter @market-monitor/backend reclassify-listings atacadao --dry-run
pnpm --filter @market-monitor/backend reclassify-listings zaffari --dry-run
```

Optional quick check for cross-market matches:

```sql
SELECT m.code AS market_code, ml.match_method, COUNT(*) AS total
FROM market_listings ml
JOIN markets m ON m.id = ml.market_id
GROUP BY m.code, ml.match_method
ORDER BY m.code, total DESC;
```

## Rollback

If needed, restore from backup created in step 1.

Example:

```bash
psql "$DATABASE_URL" < backup_before_product_fixes_YYYY-MM-DD_HHMMSS.sql
```
