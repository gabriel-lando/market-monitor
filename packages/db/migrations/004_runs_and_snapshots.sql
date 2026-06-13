CREATE TABLE IF NOT EXISTS collection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
  job_name TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  ingested_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id BIGSERIAL PRIMARY KEY,
  market_listing_id UUID NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  run_id UUID REFERENCES collection_runs(id) ON DELETE SET NULL,
  snapshot_date DATE NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'BRL',
  price_cents INTEGER NOT NULL,
  list_price_cents INTEGER,
  spot_price_cents INTEGER,
  price_without_discount_cents INTEGER,
  unit_price_cents INTEGER,
  available_quantity INTEGER,
  availability_status TEXT NOT NULL CHECK (availability_status IN ('in_stock', 'out_of_stock', 'unknown')),
  promotion_text TEXT,
  price_valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_listing_payloads (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID REFERENCES collection_runs(id) ON DELETE SET NULL,
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
  source_key TEXT NOT NULL,
  fetch_url TEXT,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);