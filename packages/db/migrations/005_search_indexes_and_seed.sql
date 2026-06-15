CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_market_scoped
  ON product_identifiers (market_id, identifier_type, identifier_value)
  WHERE market_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_global
  ON product_identifiers (identifier_type, identifier_value)
  WHERE market_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_snapshots_unique_day
  ON price_snapshots (market_listing_id, store_id, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_store_date
  ON price_snapshots (store_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_listing_date
  ON price_snapshots (market_listing_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_market_listings_product_id
  ON market_listings (product_id);

CREATE INDEX IF NOT EXISTS idx_collection_runs_market_started_at
  ON collection_runs (market_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_listing_payloads_run_id
  ON raw_listing_payloads (run_id);

CREATE INDEX IF NOT EXISTS idx_products_normalized_name_trgm
  ON products USING GIN (normalized_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_market_listings_normalized_name_trgm
  ON market_listings USING GIN (normalized_name gin_trgm_ops);

INSERT INTO markets (code, name, base_url, country_code, region, is_enabled)
VALUES ('zaffari', 'Zaffari', 'https://www.zaffari.com.br', 'BR', 'RS', TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  base_url = EXCLUDED.base_url,
  country_code = EXCLUDED.country_code,
  region = EXCLUDED.region,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = NOW();

INSERT INTO stores (market_id, code, name, scope_type, city, state, country_code, is_enabled)
SELECT id, 'default', 'Default Market Scope', 'market', NULL, 'RS', 'BR', TRUE
FROM markets
WHERE code = 'zaffari'
ON CONFLICT (market_id, code) DO UPDATE SET
  name = EXCLUDED.name,
  scope_type = EXCLUDED.scope_type,
  state = EXCLUDED.state,
  country_code = EXCLUDED.country_code,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = NOW();

INSERT INTO markets (code, name, base_url, country_code, region, is_enabled)
VALUES ('atacadao', 'Atacadao', 'https://www.atacadao.com.br', 'BR', 'BR', TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  base_url = EXCLUDED.base_url,
  country_code = EXCLUDED.country_code,
  region = EXCLUDED.region,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = NOW();

INSERT INTO stores (market_id, code, name, scope_type, city, state, country_code, is_enabled)
SELECT id, 'default', 'Default Market Scope', 'market', NULL, NULL, 'BR', TRUE
FROM markets
WHERE code = 'atacadao'
ON CONFLICT (market_id, code) DO UPDATE SET
  name = EXCLUDED.name,
  scope_type = EXCLUDED.scope_type,
  state = EXCLUDED.state,
  country_code = EXCLUDED.country_code,
  is_enabled = EXCLUDED.is_enabled,
  updated_at = NOW();