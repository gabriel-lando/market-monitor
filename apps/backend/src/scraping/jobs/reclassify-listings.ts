import type { Pool, PoolClient } from 'pg';

import { acquireMarketLock, releaseMarketLock, resolveMarketContext } from '../pipeline/persist-run.js';

type IdentifierInput = {
  type: 'product_id' | 'item_id' | 'sku';
  value: string;
  isPrimary: boolean;
  isVerified: boolean;
};

type ListingRow = {
  id: string;
  source_product_id: string | null;
  source_item_id: string | null;
  source_sku: string | null;
  normalized_name: string;
  normalized_brand: string | null;
  product_id: string | null;
  match_method: string | null;
  match_status: 'matched' | 'unmatched' | 'suggested' | 'ignored';
  match_confidence: string | null;
};

type MatchDecision = {
  productId: string;
  matchMethod: string;
};

export type ReclassifyListingsRequest = {
  market: string;
  dry_run?: boolean;
  only_source_seed?: boolean;
  limit?: number;
};

export type ReclassifyListingsStats = {
  totalSelected: number;
  processed: number;
  skippedNoMatch: number;
  unchanged: number;
  updated: number;
  relinkedProduct: number;
  methodOnlyUpdates: number;
  identifiersRebound: number;
};

export type ReclassifyListingsResult = {
  market: string;
  dry_run: boolean;
  started_at: string;
  finished_at: string;
  counts: ReclassifyListingsStats;
  message: string;
};

interface JobLogger {
  info(payload: unknown, message?: string): void;
  error?(payload: unknown, message?: string): void;
}

interface ReclassifyListingsDependencies {
  logger: JobLogger;
  db: Pool;
}

function toOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildListingIdentifiers(listing: ListingRow): IdentifierInput[] {
  const sourceSku = toOptionalText(listing.source_sku);

  return [
    listing.source_product_id
      ? {
          type: 'product_id' as const,
          value: listing.source_product_id,
          isPrimary: false,
          isVerified: true,
        }
      : null,
    listing.source_item_id
      ? {
          type: 'item_id' as const,
          value: listing.source_item_id,
          isPrimary: true,
          isVerified: true,
        }
      : null,
    sourceSku
      ? {
          type: 'sku' as const,
          value: sourceSku,
          isPrimary: false,
          isVerified: true,
        }
      : null,
  ].filter((identifier): identifier is NonNullable<typeof identifier> => Boolean(identifier));
}

async function resolveExactNameMatch(client: PoolClient, marketId: string, listing: ListingRow): Promise<MatchDecision | null> {
  const marketScoped = await client.query<{ product_id: string }>(
    `
      SELECT ml.product_id
      FROM market_listings ml
      WHERE
        ml.market_id = $1
        AND ml.product_id IS NOT NULL
        AND ml.id <> $2
        AND ml.normalized_name = $3
        AND ($4::text IS NULL OR ml.normalized_brand = $4)
      GROUP BY ml.product_id
      ORDER BY MAX(ml.last_seen_at) DESC
      LIMIT 2
    `,
    [marketId, listing.id, listing.normalized_name, listing.normalized_brand],
  );

  if (marketScoped.rows.length === 1) {
    return {
      productId: marketScoped.rows[0].product_id,
      matchMethod: listing.normalized_brand ? 'market_exact_name_brand' : 'market_exact_name',
    };
  }

  const globalScoped = await client.query<{ id: string }>(
    `
      SELECT p.id
      FROM products p
      WHERE
        p.normalized_name = $1
        AND ($2::text IS NULL OR p.normalized_brand = $2)
      ORDER BY p.updated_at DESC
      LIMIT 2
    `,
    [listing.normalized_name, listing.normalized_brand],
  );

  if (globalScoped.rows.length === 1) {
    return {
      productId: globalScoped.rows[0].id,
      matchMethod: listing.normalized_brand ? 'global_exact_name_brand' : 'global_exact_name',
    };
  }

  const crossMarketScoped = await client.query<{ product_id: string }>(
    `
      SELECT ml.product_id
      FROM market_listings ml
      JOIN products p ON p.id = ml.product_id
      WHERE
        ml.product_id IS NOT NULL
        AND ml.market_id <> $1
        AND p.normalized_name = $2
      GROUP BY ml.product_id
      ORDER BY MAX(ml.last_seen_at) DESC
      LIMIT 2
    `,
    [marketId, listing.normalized_name],
  );

  if (crossMarketScoped.rows.length === 1) {
    return {
      productId: crossMarketScoped.rows[0].product_id,
      matchMethod: 'cross_market_exact_name',
    };
  }

  return null;
}

async function resolveReclassificationMatch(client: PoolClient, marketId: string, listing: ListingRow): Promise<MatchDecision | null> {
  const identifiers = buildListingIdentifiers(listing);

  for (const identifier of identifiers) {
    const result = await client.query<{ product_id: string }>(
      `
        SELECT product_id
        FROM product_identifiers
        WHERE market_id = $1 AND identifier_type = $2 AND identifier_value = $3
        LIMIT 1
      `,
      [marketId, identifier.type, identifier.value],
    );

    const candidateProductId = result.rows[0]?.product_id;
    if (candidateProductId && candidateProductId !== listing.product_id) {
      return {
        productId: candidateProductId,
        matchMethod: 'market_identifier',
      };
    }
  }

  return resolveExactNameMatch(client, marketId, listing);
}

async function rebindIdentifiers(client: PoolClient, marketId: string, listing: ListingRow, productId: string) {
  const identifiers = buildListingIdentifiers(listing);

  for (const identifier of identifiers) {
    await client.query(
      `
        INSERT INTO product_identifiers (
          product_id,
          market_id,
          identifier_type,
          identifier_value,
          is_primary,
          is_verified,
          source_note,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'db-reclassify', NOW(), NOW())
        ON CONFLICT (market_id, identifier_type, identifier_value) WHERE market_id IS NOT NULL
        DO UPDATE SET
          product_id = EXCLUDED.product_id,
          is_primary = EXCLUDED.is_primary,
          is_verified = EXCLUDED.is_verified,
          source_note = EXCLUDED.source_note,
          updated_at = NOW()
      `,
      [productId, marketId, identifier.type, identifier.value, identifier.isPrimary, identifier.isVerified],
    );
  }

  return identifiers.length;
}

function needsUpdate(listing: ListingRow, decision: MatchDecision) {
  const confidence = listing.match_confidence ? Number.parseFloat(listing.match_confidence) : Number.NaN;

  return listing.product_id !== decision.productId || listing.match_method !== decision.matchMethod || listing.match_status !== 'matched' || !Number.isFinite(confidence) || confidence !== 100;
}

async function fetchListings(pool: Pool, marketId: string, onlySourceSeed: boolean, limit?: number) {
  const params: Array<string | number> = [marketId];
  const where: string[] = ['market_id = $1'];

  if (onlySourceSeed) {
    params.push('source_seed');
    where.push(`COALESCE(match_method, '') = $${params.length}`);
  }

  const limitClause = typeof limit === 'number' ? `LIMIT ${limit}` : '';

  const result = await pool.query<ListingRow>(
    `
      SELECT
        id,
        source_product_id,
        source_item_id,
        source_sku,
        normalized_name,
        normalized_brand,
        product_id,
        match_method,
        match_status,
        match_confidence::text
      FROM market_listings
      WHERE ${where.join(' AND ')}
      ORDER BY last_seen_at DESC
      ${limitClause}
    `,
    params,
  );

  return result.rows;
}

function createEmptyReclassifyStats(totalSelected: number): ReclassifyListingsStats {
  return {
    totalSelected,
    processed: 0,
    skippedNoMatch: 0,
    unchanged: 0,
    updated: 0,
    relinkedProduct: 0,
    methodOnlyUpdates: 0,
    identifiersRebound: 0,
  };
}

export async function runReclassifyListings(dependencies: ReclassifyListingsDependencies, request: ReclassifyListingsRequest): Promise<ReclassifyListingsResult> {
  const { logger, db } = dependencies;
  const dryRun = request.dry_run ?? false;
  const onlySourceSeed = request.only_source_seed ?? false;

  const lockAcquired = await acquireMarketLock(db, request.market);

  if (!lockAcquired) {
    throw new Error(`Could not acquire market lock for ${request.market}. Another scrape or reclassification may be running.`);
  }

  const startedAt = new Date().toISOString();

  try {
    const marketContext = await resolveMarketContext(db, request.market);
    const listings = await fetchListings(db, marketContext.marketId, onlySourceSeed, request.limit);
    const stats = createEmptyReclassifyStats(listings.length);

    logger.info(
      {
        market: request.market,
        dryRun,
        onlySourceSeed,
        limit: request.limit ?? null,
        selectedListings: listings.length,
      },
      'Starting market listings reclassification.',
    );

    for (const listing of listings) {
      stats.processed += 1;
      const client = await db.connect();
      let transactionStarted = false;

      try {
        const decision = await resolveReclassificationMatch(client, marketContext.marketId, listing);

        if (!decision) {
          stats.skippedNoMatch += 1;
          continue;
        }

        if (!needsUpdate(listing, decision)) {
          stats.unchanged += 1;
          continue;
        }

        if (dryRun) {
          stats.updated += 1;
          if (listing.product_id !== decision.productId) {
            stats.relinkedProduct += 1;
          } else {
            stats.methodOnlyUpdates += 1;
          }
          continue;
        }

        await client.query('BEGIN');
        transactionStarted = true;

        await client.query(
          `
            UPDATE market_listings
            SET
              product_id = $2,
              match_status = 'matched',
              match_method = $3,
              match_confidence = 100,
              updated_at = NOW()
            WHERE id = $1
          `,
          [listing.id, decision.productId, decision.matchMethod],
        );

        if (listing.product_id !== decision.productId) {
          stats.identifiersRebound += await rebindIdentifiers(client, marketContext.marketId, listing, decision.productId);
          stats.relinkedProduct += 1;
        } else {
          stats.methodOnlyUpdates += 1;
        }

        await client.query('COMMIT');
        transactionStarted = false;
        stats.updated += 1;
      } catch (error) {
        if (transactionStarted) {
          await client.query('ROLLBACK');
        }
        throw error;
      } finally {
        client.release();
      }
    }

    const finishedAt = new Date().toISOString();

    return {
      market: request.market,
      dry_run: dryRun,
      started_at: startedAt,
      finished_at: finishedAt,
      counts: stats,
      message: dryRun ? 'Reclassification dry-run completed.' : 'Reclassification completed and persisted successfully.',
    };
  } finally {
    await releaseMarketLock(db, request.market);
  }
}
