import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import type { Pool, PoolClient } from 'pg';
import { createDbPool } from '@market-monitor/db';

import { getAppConfig } from '../config/env.js';
import { createLogger } from '../logging/logger.js';

type MergeArgs = {
  dryRun: boolean;
  limit: number;
  noReview: boolean;
  market?: string;
  normalizedName?: string;
};

type DuplicateGroup = {
  normalized_name: string;
  normalized_brand: string | null;
  product_count: number;
  market_count: number;
  listing_count: number;
};

type ProductCandidate = {
  id: string;
  canonical_name: string;
  brand: string | null;
  listing_count: number;
  market_count: number;
  markets: string[];
  updated_at: string;
};

type MergeCounts = {
  listingsRelinked: number;
  identifiersRelinked: number;
  productsDeleted: number;
};

type MergeSummaryRow = {
  group: number;
  normalized_name: string;
  normalized_brand: string;
  candidates: number;
  mode: 'manual' | 'no-review';
  action: 'merged' | 'skipped' | 'quit';
  target_product_id: string;
  source_count: number;
  listings_relinked: number;
  identifiers_relinked: number;
  products_deleted: number;
  details: string;
};

function parseArgs(argv: string[]): MergeArgs {
  let dryRun = false;
  let noReview = false;
  let market: string | undefined;
  let normalizedName: string | undefined;
  let limit = 50;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run' || arg === '--dry_run') {
      dryRun = true;
      continue;
    }

    if (arg === '--no-review' || arg === '--no_review' || arg === '--auto-merge' || arg === '--auto_merge') {
      noReview = true;
      continue;
    }

    if (arg === '--market' && index + 1 < argv.length) {
      market = argv[index + 1]?.trim() || undefined;
      index += 1;
      continue;
    }

    if (arg.startsWith('--market=')) {
      market = arg.slice('--market='.length).trim() || undefined;
      continue;
    }

    if (arg === '--normalized-name' && index + 1 < argv.length) {
      normalizedName = argv[index + 1]?.trim() || undefined;
      index += 1;
      continue;
    }

    if (arg.startsWith('--normalized-name=')) {
      normalizedName = arg.slice('--normalized-name='.length).trim() || undefined;
      continue;
    }

    if (arg === '--limit' && index + 1 < argv.length) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      index += 1;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      continue;
    }
  }

  return {
    dryRun,
    noReview,
    market,
    normalizedName,
    limit,
  };
}

function validateArgs(args: MergeArgs) {
  const errors: string[] = [];

  if (!Number.isInteger(args.limit) || args.limit <= 0) {
    errors.push('--limit must be a positive integer.');
  }

  if (args.market !== undefined && args.market.length === 0) {
    errors.push('--market cannot be empty.');
  }

  if (args.normalizedName !== undefined && args.normalizedName.length === 0) {
    errors.push('--normalized-name cannot be empty.');
  }

  return errors;
}

async function fetchDuplicateGroups(db: Pool, args: MergeArgs) {
  const params: Array<string | number> = [];
  const where: string[] = [];

  if (args.normalizedName) {
    params.push(args.normalizedName);
    where.push(`p.normalized_name = $${params.length}`);
  }

  if (args.market) {
    params.push(args.market);
    where.push(
      `EXISTS (
        SELECT 1
        FROM market_listings ml_filter
        JOIN markets m_filter ON m_filter.id = ml_filter.market_id
        WHERE ml_filter.product_id = p.id AND m_filter.code = $${params.length}
      )`,
    );
  }

  params.push(args.limit);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const result = await db.query<DuplicateGroup>(
    `
      SELECT
        p.normalized_name,
        p.normalized_brand,
        COUNT(DISTINCT p.id)::int AS product_count,
        COUNT(DISTINCT ml.market_id)::int AS market_count,
        COUNT(ml.id)::int AS listing_count
      FROM products p
      JOIN market_listings ml ON ml.product_id = p.id
      ${whereClause}
      GROUP BY p.normalized_name, p.normalized_brand
      HAVING COUNT(DISTINCT p.id) > 1
      ORDER BY market_count DESC, listing_count DESC, p.normalized_name ASC
      LIMIT $${params.length}
    `,
    params,
  );

  return result.rows;
}

async function fetchGroupCandidates(db: Pool, group: DuplicateGroup) {
  const result = await db.query<ProductCandidate>(
    `
      SELECT
        p.id,
        p.canonical_name,
        p.brand,
        COUNT(ml.id)::int AS listing_count,
        COUNT(DISTINCT ml.market_id)::int AS market_count,
        ARRAY_AGG(DISTINCT m.code ORDER BY m.code)::text[] AS markets,
        p.updated_at::text AS updated_at
      FROM products p
      JOIN market_listings ml ON ml.product_id = p.id
      JOIN markets m ON m.id = ml.market_id
      WHERE
        p.normalized_name = $1
        AND (($2::text IS NULL AND p.normalized_brand IS NULL) OR p.normalized_brand = $2)
      GROUP BY p.id, p.canonical_name, p.brand, p.updated_at
      ORDER BY listing_count DESC, market_count DESC, p.updated_at DESC
    `,
    [group.normalized_name, group.normalized_brand],
  );

  return result.rows;
}

function parseIndexSelection(value: string, max: number) {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
    return undefined;
  }

  return parsed - 1;
}

function parseSourceSelection(value: string, max: number, targetIndex: number) {
  const normalized = value.trim().toLowerCase();

  if (normalized.length === 0 || normalized === 'all') {
    return Array.from({ length: max }, (_, index) => index).filter((index) => index !== targetIndex);
  }

  const parts = normalized
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const indices = new Set<number>();

  for (const part of parts) {
    const parsed = Number.parseInt(part, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
      return undefined;
    }

    const index = parsed - 1;
    if (index === targetIndex) {
      continue;
    }

    indices.add(index);
  }

  return [...indices.values()];
}

async function runMerge(client: PoolClient, targetProductId: string, sourceProductIds: string[], dryRun: boolean): Promise<MergeCounts> {
  if (sourceProductIds.length === 0) {
    return {
      listingsRelinked: 0,
      identifiersRelinked: 0,
      productsDeleted: 0,
    };
  }

  const listingCountResult = await client.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM market_listings
      WHERE product_id = ANY($1::uuid[])
    `,
    [sourceProductIds],
  );

  const identifierCountResult = await client.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM product_identifiers
      WHERE product_id = ANY($1::uuid[])
    `,
    [sourceProductIds],
  );

  const listingsRelinked = Number.parseInt(listingCountResult.rows[0]?.count ?? '0', 10);
  const identifiersRelinked = Number.parseInt(identifierCountResult.rows[0]?.count ?? '0', 10);

  if (dryRun) {
    return {
      listingsRelinked,
      identifiersRelinked,
      productsDeleted: sourceProductIds.length,
    };
  }

  await client.query('BEGIN');

  try {
    await client.query(
      `
        UPDATE market_listings
        SET
          product_id = $1,
          match_status = 'matched',
          match_method = 'manual_product_merge',
          updated_at = NOW()
        WHERE product_id = ANY($2::uuid[])
      `,
      [targetProductId, sourceProductIds],
    );

    await client.query(
      `
        UPDATE product_identifiers
        SET
          product_id = $1,
          source_note = 'manual-product-merge',
          updated_at = NOW()
        WHERE product_id = ANY($2::uuid[])
      `,
      [targetProductId, sourceProductIds],
    );

    const deleteResult = await client.query(
      `
        DELETE FROM products
        WHERE id = ANY($1::uuid[])
      `,
      [sourceProductIds],
    );

    await client.query('COMMIT');

    return {
      listingsRelinked,
      identifiersRelinked,
      productsDeleted: deleteResult.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function withGlobalMergeLock<T>(db: Pool, callback: () => Promise<T>) {
  await db.query('SELECT pg_advisory_lock(hashtext($1))', ['manual-product-merge']);

  try {
    return await callback();
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtext($1))', ['manual-product-merge']);
  }
}

function createSkipSummaryRow(groupIndex: number, group: DuplicateGroup, candidatesCount: number, noReview: boolean, details: string): MergeSummaryRow {
  return {
    group: groupIndex + 1,
    normalized_name: group.normalized_name,
    normalized_brand: group.normalized_brand ?? '(null)',
    candidates: candidatesCount,
    mode: noReview ? 'no-review' : 'manual',
    action: 'skipped',
    target_product_id: '-',
    source_count: 0,
    listings_relinked: 0,
    identifiers_relinked: 0,
    products_deleted: 0,
    details,
  };
}

const args = parseArgs(process.argv.slice(2));
const config = getAppConfig();
const logger = createLogger(config.logLevel, config.scrapingEnabled ? 'writer' : 'readonly', config.appEnv);
const db = createDbPool(config.databaseUrl);
const rl = createInterface({ input, output });

try {
  const argErrors = validateArgs(args);
  if (argErrors.length > 0) {
    throw new Error(`Invalid arguments:\n- ${argErrors.join('\n- ')}`);
  }

  await withGlobalMergeLock(db, async () => {
    const groups = await fetchDuplicateGroups(db, args);

    if (groups.length === 0) {
      console.log('No duplicate groups found for the selected filters.');
      return;
    }

    logger.info(
      {
        dryRun: args.dryRun,
        noReview: args.noReview,
        market: args.market ?? null,
        normalizedName: args.normalizedName ?? null,
        limit: args.limit,
        groupsFound: groups.length,
      },
      'Starting manual duplicate review.',
    );

    let mergedGroups = 0;
    let skippedGroups = 0;
    let relinkedListingsTotal = 0;
    let relinkedIdentifiersTotal = 0;
    let deletedProductsTotal = 0;
    const summaryRows: MergeSummaryRow[] = [];

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const candidates = await fetchGroupCandidates(db, group);

      if (candidates.length < 2) {
        skippedGroups += 1;
        summaryRows.push(createSkipSummaryRow(groupIndex, group, candidates.length, args.noReview, 'not_enough_candidates'));
        continue;
      }

      console.log('\n------------------------------------------------------------');
      console.log(`Group ${groupIndex + 1}/${groups.length}`);
      console.log(`normalized_name: ${group.normalized_name}`);
      console.log(`normalized_brand: ${group.normalized_brand ?? '(null)'}`);
      console.log(`products: ${group.product_count}, listings: ${group.listing_count}, markets: ${group.market_count}`);

      candidates.forEach((candidate, index) => {
        console.log(
          `[${index + 1}] id=${candidate.id} | listings=${candidate.listing_count} | markets=${candidate.market_count} | markets=[${candidate.markets.join(', ')}] | name="${candidate.canonical_name}" | brand="${candidate.brand ?? ''}" | updated_at=${candidate.updated_at}`,
        );
      });

      let action = 'm';
      let targetIndex = 0;
      let sourceIndices: number[] | undefined = Array.from({ length: candidates.length }, (_, index) => index).filter((index) => index !== targetIndex);

      if (!args.noReview) {
        action = (await rl.question('Action? [m=merge, s=skip, q=quit] ')).trim().toLowerCase();

        if (action === 'q') {
          summaryRows.push({
            group: groupIndex + 1,
            normalized_name: group.normalized_name,
            normalized_brand: group.normalized_brand ?? '(null)',
            candidates: candidates.length,
            mode: 'manual',
            action: 'quit',
            target_product_id: '-',
            source_count: 0,
            listings_relinked: 0,
            identifiers_relinked: 0,
            products_deleted: 0,
            details: 'user_quit',
          });
          break;
        }

        if (action !== 'm') {
          skippedGroups += 1;
          summaryRows.push(createSkipSummaryRow(groupIndex, group, candidates.length, args.noReview, 'user_skip'));
          continue;
        }

        const targetRaw = await rl.question(`Target index [1-${candidates.length}] (default 1): `);
        targetIndex = targetRaw.trim().length === 0 ? 0 : (parseIndexSelection(targetRaw, candidates.length) ?? -1);

        if (targetIndex < 0) {
          console.log('Invalid target index. Group skipped.');
          skippedGroups += 1;
          summaryRows.push(createSkipSummaryRow(groupIndex, group, candidates.length, args.noReview, 'invalid_target_index'));
          continue;
        }

        const sourceRaw = await rl.question('Source indices to merge (comma-separated or "all", default all): ');
        sourceIndices = parseSourceSelection(sourceRaw, candidates.length, targetIndex);

        if (!sourceIndices || sourceIndices.length === 0) {
          console.log('No valid source indices selected. Group skipped.');
          skippedGroups += 1;
          summaryRows.push(createSkipSummaryRow(groupIndex, group, candidates.length, args.noReview, 'invalid_source_selection'));
          continue;
        }
      }

      const target = candidates[targetIndex];
      const sources = sourceIndices.map((index) => candidates[index]);

      console.log(`Target: ${target.id}`);
      console.log(`Sources: ${sources.map((source) => source.id).join(', ')}`);

      if (!args.noReview) {
        const confirmation = (await rl.question('Confirm merge? [y/N] ')).trim().toLowerCase();
        if (confirmation !== 'y' && confirmation !== 'yes') {
          skippedGroups += 1;
          summaryRows.push(createSkipSummaryRow(groupIndex, group, candidates.length, args.noReview, 'merge_not_confirmed'));
          continue;
        }
      }

      const client = await db.connect();

      try {
        const counts = await runMerge(
          client,
          target.id,
          sources.map((source) => source.id),
          args.dryRun,
        );

        mergedGroups += 1;
        relinkedListingsTotal += counts.listingsRelinked;
        relinkedIdentifiersTotal += counts.identifiersRelinked;
        deletedProductsTotal += counts.productsDeleted;
        summaryRows.push({
          group: groupIndex + 1,
          normalized_name: group.normalized_name,
          normalized_brand: group.normalized_brand ?? '(null)',
          candidates: candidates.length,
          mode: args.noReview ? 'no-review' : 'manual',
          action: 'merged',
          target_product_id: target.id,
          source_count: sources.length,
          listings_relinked: counts.listingsRelinked,
          identifiers_relinked: counts.identifiersRelinked,
          products_deleted: counts.productsDeleted,
          details: args.dryRun ? 'dry_run' : 'applied',
        });

        console.log(`${args.dryRun ? '[dry-run] ' : ''}Merged group: listings=${counts.listingsRelinked}, identifiers=${counts.identifiersRelinked}, products_deleted=${counts.productsDeleted}`);
      } finally {
        client.release();
      }
    }

    console.log('\nSummary by group:');
    console.table(summaryRows);

    logger.info(
      {
        dryRun: args.dryRun,
        noReview: args.noReview,
        mergedGroups,
        skippedGroups,
        relinkedListingsTotal,
        relinkedIdentifiersTotal,
        deletedProductsTotal,
      },
      args.dryRun ? 'Manual duplicate review completed (dry-run).' : 'Manual duplicate review completed.',
    );
  });
} finally {
  rl.close();
  await db.end();
}
