CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  brand TEXT,
  normalized_brand TEXT,
  measurement_unit TEXT,
  unit_value NUMERIC(12, 3),
  pack_quantity INTEGER,
  image_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  market_id UUID REFERENCES markets(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  source_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,
  source_product_id TEXT,
  source_item_id TEXT,
  source_sku TEXT,
  source_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  brand TEXT,
  normalized_brand TEXT,
  measurement_unit TEXT,
  unit_value NUMERIC(12, 3),
  pack_quantity INTEGER,
  product_url TEXT,
  image_url TEXT,
  match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'unmatched', 'suggested', 'ignored')),
  match_method TEXT,
  match_confidence NUMERIC(5, 2),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (market_id, source_key)
);

CREATE TABLE IF NOT EXISTS market_listing_categories (
  market_listing_id UUID NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  market_category_id UUID NOT NULL REFERENCES market_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (market_listing_id, market_category_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_market_scoped
  ON product_identifiers (market_id, identifier_type, identifier_value)
  WHERE market_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identifiers_global
  ON product_identifiers (identifier_type, identifier_value)
  WHERE market_id IS NULL;