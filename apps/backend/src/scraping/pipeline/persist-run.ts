import type { Pool, PoolClient } from 'pg';

import type { NormalizedIdentifier, NormalizedListing } from '@market-monitor/shared';

import type { ScrapedCategory } from '../adapters/base/types.js';
import { hashPayload } from './utils.js';

export interface ScrapePersistenceStats {
  categoriesDiscovered: number;
  categoriesScraped: number;
  listingsSeen: number;
  listingsIngested: number;
  productsCreated: number;
  matchedProducts: number;
  snapshotsUpserted: number;
  rawPayloadsStored: number;
  skippedListings: number;
}

export interface MarketContext {
  marketId: string;
  storeId: string;
}

export type CollectionRunTriggerSource = 'manual' | 'scheduler' | 'dry-run';

export function createEmptyStats(): ScrapePersistenceStats {
  return {
    categoriesDiscovered: 0,
    categoriesScraped: 0,
    listingsSeen: 0,
    listingsIngested: 0,
    productsCreated: 0,
    matchedProducts: 0,
    snapshotsUpserted: 0,
    rawPayloadsStored: 0,
    skippedListings: 0,
  };
}

export function mergeStats(target: ScrapePersistenceStats, delta: Partial<ScrapePersistenceStats>) {
  for (const [key, value] of Object.entries(delta)) {
    const typedKey = key as keyof ScrapePersistenceStats;
    target[typedKey] += value ?? 0;
  }
}

export async function resolveMarketContext(pool: Pool, marketCode: string): Promise<MarketContext> {
  const result = await pool.query<{ market_id: string; store_id: string }>(
    `
      SELECT m.id AS market_id, s.id AS store_id
      FROM markets m
      JOIN stores s ON s.market_id = m.id
      WHERE m.code = $1 AND s.code = 'default'
      LIMIT 1
    `,
    [marketCode],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Market context for ${marketCode} was not found. Seed the base data first.`);
  }

  return {
    marketId: row.market_id,
    storeId: row.store_id,
  };
}

export async function acquireMarketLock(pool: Pool, marketCode: string) {
  const result = await pool.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [`scrape:${marketCode}`]);

  return result.rows[0]?.acquired ?? false;
}

export async function releaseMarketLock(pool: Pool, marketCode: string) {
  await pool.query('SELECT pg_advisory_unlock(hashtext($1))', [`scrape:${marketCode}`]);
}

export async function createCollectionRun(pool: Pool, marketContext: MarketContext, marketCode: string, triggerSource: CollectionRunTriggerSource, dryRun: boolean, reason?: string) {
  const result = await pool.query<{ id: string; started_at: string }>(
    `
      INSERT INTO collection_runs (market_id, store_id, job_name, trigger_source, status, metadata)
      VALUES ($1, $2, 'scrape-once', $3, 'running', $4::jsonb)
      RETURNING id, started_at::text
    `,
    [marketContext.marketId, marketContext.storeId, triggerSource, JSON.stringify({ marketCode, dryRun, reason: reason ?? null })],
  );

  return result.rows[0];
}

export async function updateCollectionRun(pool: Pool, runId: string, status: 'completed' | 'failed' | 'skipped', stats: ScrapePersistenceStats, errorSummary?: string) {
  await pool.query(
    `
      UPDATE collection_runs
      SET
        status = $2,
        finished_at = NOW(),
        discovered_count = $3,
        ingested_count = $4,
        matched_count = $5,
        unmatched_count = $6,
        error_count = $7,
        error_summary = $8,
        updated_at = NOW()
      WHERE id = $1
    `,
    [runId, status, stats.listingsSeen, stats.listingsIngested, stats.matchedProducts, stats.skippedListings, status === 'failed' ? 1 : 0, errorSummary ?? null],
  );
}

export async function upsertCategories(pool: Pool, marketId: string, categories: ScrapedCategory[]) {
  const categoryIdBySourceKey = new Map<string, string>();

  for (const category of categories) {
    const parentId = category.parentSourceKey ? (categoryIdBySourceKey.get(category.parentSourceKey) ?? null) : null;
    const result = await pool.query<{ id: string }>(
      `
        INSERT INTO market_categories (
          market_id,
          source_key,
          parent_id,
          depth,
          slug,
          name,
          path_text,
          is_active,
          first_seen_at,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (market_id, source_key)
        DO UPDATE SET
          parent_id = EXCLUDED.parent_id,
          depth = EXCLUDED.depth,
          slug = EXCLUDED.slug,
          name = EXCLUDED.name,
          path_text = EXCLUDED.path_text,
          is_active = TRUE,
          last_seen_at = NOW(),
          updated_at = NOW()
        RETURNING id
      `,
      [marketId, category.sourceKey, parentId, category.depth, category.slug, category.name, category.path.join(' > ')],
    );

    categoryIdBySourceKey.set(category.sourceKey, result.rows[0].id);
  }

  return categoryIdBySourceKey;
}

type ProductMatch = {
  productId: string;
  matched: boolean;
  matchMethod: string;
};

async function resolveExactNameMatch(client: PoolClient, marketId: string, listing: NormalizedListing): Promise<ProductMatch | null> {
  const marketScoped = await client.query<{ product_id: string }>(
    `
      SELECT ml.product_id
      FROM market_listings ml
      WHERE
        ml.market_id = $1
        AND ml.product_id IS NOT NULL
        AND ml.normalized_name = $2
        AND ($3::text IS NULL OR ml.normalized_brand = $3)
      GROUP BY ml.product_id
      ORDER BY MAX(ml.last_seen_at) DESC
      LIMIT 2
    `,
    [marketId, listing.normalizedName, listing.normalizedBrand ?? null],
  );

  if (marketScoped.rows.length === 1) {
    return {
      productId: marketScoped.rows[0].product_id,
      matched: true,
      matchMethod: listing.normalizedBrand ? 'market_exact_name_brand' : 'market_exact_name',
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
    [listing.normalizedName, listing.normalizedBrand ?? null],
  );

  if (globalScoped.rows.length === 1) {
    return {
      productId: globalScoped.rows[0].id,
      matched: true,
      matchMethod: listing.normalizedBrand ? 'global_exact_name_brand' : 'global_exact_name',
    };
  }

  return null;
}

async function resolveProductMatch(client: PoolClient, marketId: string, listing: NormalizedListing): Promise<ProductMatch | null> {
  const existingListing = await client.query<{ product_id: string | null }>(
    `
      SELECT product_id
      FROM market_listings
      WHERE market_id = $1 AND source_key = $2
      LIMIT 1
    `,
    [marketId, listing.sourceKey],
  );

  const existingProductId = existingListing.rows[0]?.product_id;
  if (existingProductId) {
    return {
      productId: existingProductId,
      matched: true,
      matchMethod: 'listing_reuse',
    };
  }

  const exactIdentifiers = [...listing.identifiers].sort((left, right) => (left.scope === 'global' ? -1 : 1) - (right.scope === 'global' ? -1 : 1));

  for (const identifier of exactIdentifiers) {
    const query =
      identifier.scope === 'global'
        ? {
            sql: `
            SELECT product_id
            FROM product_identifiers
            WHERE market_id IS NULL AND identifier_type = $1 AND identifier_value = $2
            LIMIT 1
          `,
            params: [identifier.type, identifier.value],
          }
        : {
            sql: `
            SELECT product_id
            FROM product_identifiers
            WHERE market_id = $1 AND identifier_type = $2 AND identifier_value = $3
            LIMIT 1
          `,
            params: [marketId, identifier.type, identifier.value],
          };

    const result = await client.query<{ product_id: string }>(query.sql, query.params);
    if (result.rows[0]?.product_id) {
      return {
        productId: result.rows[0].product_id,
        matched: true,
        matchMethod: identifier.scope === 'global' ? 'exact_identifier' : 'market_identifier',
      };
    }
  }

  const exactNameMatch = await resolveExactNameMatch(client, marketId, listing);
  if (exactNameMatch) {
    return exactNameMatch;
  }

  return null;
}

async function createProduct(client: PoolClient, listing: NormalizedListing) {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO products (
        canonical_name,
        normalized_name,
        brand,
        normalized_brand,
        measurement_unit,
        unit_value,
        pack_quantity,
        image_url,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), NOW())
      RETURNING id
    `,
    [listing.sourceName, listing.normalizedName, listing.brand ?? null, listing.normalizedBrand ?? null, listing.measurementUnit ?? null, listing.unitValue ?? null, listing.packQuantity ?? null, listing.imageUrl ?? null],
  );

  return result.rows[0].id;
}

async function upsertIdentifier(client: PoolClient, productId: string, marketId: string, identifier: NormalizedIdentifier, sourceNote: string) {
  if (identifier.scope === 'global') {
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
        VALUES ($1, NULL, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (identifier_type, identifier_value) WHERE market_id IS NULL
        DO UPDATE SET
          product_id = EXCLUDED.product_id,
          is_primary = EXCLUDED.is_primary,
          is_verified = EXCLUDED.is_verified,
          updated_at = NOW()
      `,
      [productId, identifier.type, identifier.value, identifier.isPrimary, identifier.isVerified, sourceNote],
    );
    return;
  }

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
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      ON CONFLICT (market_id, identifier_type, identifier_value) WHERE market_id IS NOT NULL
      DO UPDATE SET
        product_id = EXCLUDED.product_id,
        is_primary = EXCLUDED.is_primary,
        is_verified = EXCLUDED.is_verified,
        updated_at = NOW()
    `,
    [productId, marketId, identifier.type, identifier.value, identifier.isPrimary, identifier.isVerified, sourceNote],
  );
}

async function upsertMarketListing(client: PoolClient, marketId: string, productId: string, listing: NormalizedListing, matchMethod: string) {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO market_listings (
        market_id,
        product_id,
        source_key,
        source_product_id,
        source_item_id,
        source_sku,
        source_name,
        normalized_name,
        brand,
        normalized_brand,
        measurement_unit,
        unit_value,
        pack_quantity,
        product_url,
        image_url,
        match_status,
        match_method,
        match_confidence,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        'matched', $16, 100, NOW(), NOW(), NOW(), NOW()
      )
      ON CONFLICT (market_id, source_key)
      DO UPDATE SET
        product_id = EXCLUDED.product_id,
        source_product_id = EXCLUDED.source_product_id,
        source_item_id = EXCLUDED.source_item_id,
        source_sku = EXCLUDED.source_sku,
        source_name = EXCLUDED.source_name,
        normalized_name = EXCLUDED.normalized_name,
        brand = EXCLUDED.brand,
        normalized_brand = EXCLUDED.normalized_brand,
        measurement_unit = EXCLUDED.measurement_unit,
        unit_value = EXCLUDED.unit_value,
        pack_quantity = EXCLUDED.pack_quantity,
        product_url = EXCLUDED.product_url,
        image_url = EXCLUDED.image_url,
        match_status = 'matched',
        match_method = EXCLUDED.match_method,
        match_confidence = EXCLUDED.match_confidence,
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING id
    `,
    [
      marketId,
      productId,
      listing.sourceKey,
      listing.sourceProductId ?? null,
      listing.sourceItemId ?? null,
      listing.sourceSku ?? null,
      listing.sourceName,
      listing.normalizedName,
      listing.brand ?? null,
      listing.normalizedBrand ?? null,
      listing.measurementUnit ?? null,
      listing.unitValue ?? null,
      listing.packQuantity ?? null,
      listing.productUrl ?? null,
      listing.imageUrl ?? null,
      matchMethod,
    ],
  );

  return result.rows[0].id;
}

async function replaceListingCategories(client: PoolClient, listingId: string, categorySourceKeys: string[], categoryIdBySourceKey: Map<string, string>) {
  await client.query('DELETE FROM market_listing_categories WHERE market_listing_id = $1', [listingId]);

  for (const sourceKey of new Set(categorySourceKeys)) {
    const categoryId = categoryIdBySourceKey.get(sourceKey);
    if (!categoryId) {
      continue;
    }

    await client.query(
      `
        INSERT INTO market_listing_categories (market_listing_id, market_category_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [listingId, categoryId],
    );
  }
}

async function upsertSnapshot(client: PoolClient, listingId: string, storeId: string, runId: string, listing: NormalizedListing) {
  await client.query(
    `
      INSERT INTO price_snapshots (
        market_listing_id,
        store_id,
        run_id,
        snapshot_date,
        captured_at,
        currency_code,
        price_cents,
        list_price_cents,
        spot_price_cents,
        price_without_discount_cents,
        unit_price_cents,
        available_quantity,
        availability_status,
        promotion_text,
        price_valid_until,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $14, NOW()
      )
      ON CONFLICT (market_listing_id, store_id, snapshot_date)
      DO UPDATE SET
        run_id = EXCLUDED.run_id,
        captured_at = EXCLUDED.captured_at,
        currency_code = EXCLUDED.currency_code,
        price_cents = EXCLUDED.price_cents,
        list_price_cents = EXCLUDED.list_price_cents,
        spot_price_cents = EXCLUDED.spot_price_cents,
        price_without_discount_cents = EXCLUDED.price_without_discount_cents,
        unit_price_cents = EXCLUDED.unit_price_cents,
        available_quantity = EXCLUDED.available_quantity,
        availability_status = EXCLUDED.availability_status,
        price_valid_until = EXCLUDED.price_valid_until
    `,
    [
      listingId,
      storeId,
      runId,
      listing.capturedAt.slice(0, 10),
      listing.capturedAt,
      listing.currencyCode,
      listing.priceCents,
      listing.listPriceCents ?? null,
      listing.spotPriceCents ?? null,
      listing.priceWithoutDiscountCents ?? null,
      listing.unitPriceCents ?? null,
      listing.availableQuantity ?? null,
      listing.availabilityStatus,
      listing.priceValidUntil ?? null,
    ],
  );
}

async function insertRawPayload(client: PoolClient, marketId: string, storeId: string, runId: string, listing: NormalizedListing) {
  await client.query(
    `
      INSERT INTO raw_listing_payloads (
        run_id,
        market_id,
        store_id,
        source_key,
        fetch_url,
        payload,
        payload_hash,
        parser_version,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())
    `,
    [runId, marketId, storeId, listing.sourceKey, listing.fetchUrl, JSON.stringify(listing.rawPayload), hashPayload(listing.rawPayload), listing.parserVersion],
  );
}

export async function persistListing(pool: Pool, marketContext: MarketContext, runId: string, categoryIdBySourceKey: Map<string, string>, listing: NormalizedListing) {
  const client = await pool.connect();
  const sourceNote = `${listing.marketCode}-adapter`;

  try {
    await client.query('BEGIN');

    const match = await resolveProductMatch(client, marketContext.marketId, listing);
    const productId = match?.productId ?? (await createProduct(client, listing));

    for (const identifier of listing.identifiers) {
      await upsertIdentifier(client, productId, marketContext.marketId, identifier, sourceNote);
    }

    const listingId = await upsertMarketListing(client, marketContext.marketId, productId, listing, match?.matchMethod ?? 'source_seed');
    await replaceListingCategories(client, listingId, listing.categorySourceKeys, categoryIdBySourceKey);
    await upsertSnapshot(client, listingId, marketContext.storeId, runId, listing);
    await insertRawPayload(client, marketContext.marketId, marketContext.storeId, runId, listing);

    await client.query('COMMIT');

    return {
      listingsIngested: 1,
      productsCreated: match ? 0 : 1,
      matchedProducts: match ? 1 : 0,
      snapshotsUpserted: 1,
      rawPayloadsStored: 1,
    } satisfies Partial<ScrapePersistenceStats>;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
