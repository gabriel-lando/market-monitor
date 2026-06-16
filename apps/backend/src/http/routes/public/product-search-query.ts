export const PRODUCT_SEARCH_QUERY = `
  WITH latest_product_market_prices AS (
    SELECT
      ml.product_id,
      m.code AS market_code,
      m.name AS market_name,
      latest_snapshot.price_cents AS latest_price_cents
    FROM market_listings ml
    JOIN markets m ON m.id = ml.market_id
    LEFT JOIN LATERAL (
      SELECT ps.price_cents
      FROM price_snapshots ps
      WHERE ps.market_listing_id = ml.id
      ORDER BY ps.snapshot_date DESC, ps.captured_at DESC
      LIMIT 1
    ) AS latest_snapshot ON TRUE
  ), canonical_market_prices AS (
    SELECT
      product_id,
      jsonb_agg(
        jsonb_build_object(
          'market_code', market_code,
          'market_name', market_name,
          'latest_price_cents', latest_price_cents
        )
        ORDER BY market_name
      ) AS market_prices
    FROM latest_product_market_prices
    GROUP BY product_id
  ), candidates AS (
    SELECT
      p.id,
      'canonical_product'::TEXT AS result_type,
      p.canonical_name AS name,
      NULL::TEXT AS market_code,
      latest_snapshot.price_cents AS latest_price_cents,
      COALESCE(canonical_market_prices.market_prices, '[]'::jsonb) AS market_prices,
      CASE
        WHEN $1 = '' THEN TRUE
        ELSE p.normalized_name LIKE '%' || $1 || '%'
          OR ($2 <> '' AND REPLACE(p.normalized_name, ' ', '') LIKE '%' || $2 || '%')
      END AS is_direct_match,
      CASE
        WHEN $1 = '' THEN FALSE
        ELSE p.normalized_name LIKE $1 || '%'
          OR ($2 <> '' AND REPLACE(p.normalized_name, ' ', '') LIKE $2 || '%')
      END AS is_prefix_match,
      CASE
        WHEN $1 = '' THEN 0::REAL
        ELSE GREATEST(
          similarity(p.normalized_name, $1),
          word_similarity($1, p.normalized_name),
          strict_word_similarity($1, p.normalized_name),
          CASE
            WHEN $2 = '' THEN 0::REAL
            ELSE GREATEST(
              similarity(REPLACE(p.normalized_name, ' ', ''), $2),
              word_similarity($2, REPLACE(p.normalized_name, ' ', '')),
              strict_word_similarity($2, REPLACE(p.normalized_name, ' ', ''))
            )
          END
        )
      END AS match_score,
      0 AS result_type_rank
    FROM products p
    LEFT JOIN LATERAL (
      SELECT ps.price_cents
      FROM market_listings ml
      JOIN price_snapshots ps ON ps.market_listing_id = ml.id
      WHERE ml.product_id = p.id
      ORDER BY ps.snapshot_date DESC, ps.captured_at DESC
      LIMIT 1
    ) AS latest_snapshot ON TRUE
    LEFT JOIN canonical_market_prices ON canonical_market_prices.product_id = p.id
    WHERE $1 = ''
      OR p.normalized_name LIKE '%' || $1 || '%'
      OR ($2 <> '' AND REPLACE(p.normalized_name, ' ', '') LIKE '%' || $2 || '%')
      OR similarity(p.normalized_name, $1) >= $3
      OR word_similarity($1, p.normalized_name) >= $3
      OR strict_word_similarity($1, p.normalized_name) >= $3
      OR (
        $2 <> ''
        AND (
          similarity(REPLACE(p.normalized_name, ' ', ''), $2) >= $3
          OR word_similarity($2, REPLACE(p.normalized_name, ' ', '')) >= $3
          OR strict_word_similarity($2, REPLACE(p.normalized_name, ' ', '')) >= $3
        )
      )

    UNION ALL

    SELECT
      ml.id,
      'unmatched_listing'::TEXT AS result_type,
      ml.source_name AS name,
      m.code AS market_code,
      latest_snapshot.price_cents AS latest_price_cents,
      jsonb_build_array(
        jsonb_build_object(
          'market_code', m.code,
          'market_name', m.name,
          'latest_price_cents', latest_snapshot.price_cents
        )
      ) AS market_prices,
      CASE
        WHEN $1 = '' THEN TRUE
        ELSE ml.normalized_name LIKE '%' || $1 || '%'
          OR ($2 <> '' AND REPLACE(ml.normalized_name, ' ', '') LIKE '%' || $2 || '%')
      END AS is_direct_match,
      CASE
        WHEN $1 = '' THEN FALSE
        ELSE ml.normalized_name LIKE $1 || '%'
          OR ($2 <> '' AND REPLACE(ml.normalized_name, ' ', '') LIKE $2 || '%')
      END AS is_prefix_match,
      CASE
        WHEN $1 = '' THEN 0::REAL
        ELSE GREATEST(
          similarity(ml.normalized_name, $1),
          word_similarity($1, ml.normalized_name),
          strict_word_similarity($1, ml.normalized_name),
          CASE
            WHEN $2 = '' THEN 0::REAL
            ELSE GREATEST(
              similarity(REPLACE(ml.normalized_name, ' ', ''), $2),
              word_similarity($2, REPLACE(ml.normalized_name, ' ', '')),
              strict_word_similarity($2, REPLACE(ml.normalized_name, ' ', ''))
            )
          END
        )
      END AS match_score,
      1 AS result_type_rank
    FROM market_listings ml
    JOIN markets m ON m.id = ml.market_id
    LEFT JOIN LATERAL (
      SELECT ps.price_cents
      FROM price_snapshots ps
      WHERE ps.market_listing_id = ml.id
      ORDER BY ps.snapshot_date DESC, ps.captured_at DESC
      LIMIT 1
    ) AS latest_snapshot ON TRUE
    WHERE ml.product_id IS NULL
      AND ($4::TEXT IS NULL OR m.code = $4)
      AND (
        $1 = ''
        OR ml.normalized_name LIKE '%' || $1 || '%'
        OR ($2 <> '' AND REPLACE(ml.normalized_name, ' ', '') LIKE '%' || $2 || '%')
        OR similarity(ml.normalized_name, $1) >= $3
        OR word_similarity($1, ml.normalized_name) >= $3
        OR strict_word_similarity($1, ml.normalized_name) >= $3
        OR (
          $2 <> ''
          AND (
            similarity(REPLACE(ml.normalized_name, ' ', ''), $2) >= $3
            OR word_similarity($2, REPLACE(ml.normalized_name, ' ', '')) >= $3
            OR strict_word_similarity($2, REPLACE(ml.normalized_name, ' ', '')) >= $3
          )
        )
      )
  ), ranked AS (
    SELECT
      id,
      result_type,
      name,
      market_code,
      latest_price_cents,
      market_prices,
      COUNT(*) OVER ()::INTEGER AS total_count,
      CASE WHEN is_direct_match THEN 0 ELSE 1 END AS direct_match_rank,
      CASE WHEN is_prefix_match THEN 0 ELSE 1 END AS prefix_match_rank,
      match_score,
      result_type_rank
    FROM candidates
  )
  SELECT
    id,
    result_type,
    name,
    market_code,
    latest_price_cents,
    market_prices,
    total_count
  FROM ranked
  ORDER BY direct_match_rank ASC, prefix_match_rank ASC, match_score DESC, result_type_rank ASC, name ASC
  LIMIT $5 OFFSET $6
`;

const DEFAULT_PRODUCT_SEARCH_FUZZY_MATCH_THRESHOLD = 0.45;

function resolveProductSearchFuzzyMatchThreshold(searchTerm: string) {
  const compactLength = searchTerm.replace(/\s+/g, '').length;

  if (compactLength <= 3) {
    return 0.7;
  }

  if (compactLength <= 5) {
    return 0.6;
  }

  return DEFAULT_PRODUCT_SEARCH_FUZZY_MATCH_THRESHOLD;
}

export function buildProductSearchParams(args: { searchTerm: string; market: string | null; limit: number; offset: number }) {
  return [args.searchTerm, args.searchTerm.replace(/\s+/g, ''), resolveProductSearchFuzzyMatchThreshold(args.searchTerm), args.market, args.limit, args.offset];
}
