export const PRODUCT_SEARCH_QUERY = `
  WITH candidates AS (
    SELECT
      p.id,
      'canonical_product'::TEXT AS result_type,
      p.canonical_name AS name,
      NULL::TEXT AS market_code,
      latest_snapshot.price_cents AS latest_price_cents,
      CASE
        WHEN $1 = '' THEN TRUE
        ELSE p.normalized_name LIKE '%' || $1 || '%'
          OR ($2 <> '' AND REPLACE(p.normalized_name, ' ', '') LIKE '%' || $2 || '%')
      END AS is_direct_match,
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
      CASE
        WHEN $1 = '' THEN TRUE
        ELSE ml.normalized_name LIKE '%' || $1 || '%'
          OR ($2 <> '' AND REPLACE(ml.normalized_name, ' ', '') LIKE '%' || $2 || '%')
      END AS is_direct_match,
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
      COUNT(*) OVER ()::INTEGER AS total_count,
      CASE WHEN is_direct_match THEN 0 ELSE 1 END AS direct_match_rank,
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
    total_count
  FROM ranked
  ORDER BY direct_match_rank ASC, match_score DESC, result_type_rank ASC, name ASC
  LIMIT $5 OFFSET $6
`;

const PRODUCT_SEARCH_FUZZY_MATCH_THRESHOLD = 0.45;

export function buildProductSearchParams(args: { searchTerm: string; market: string | null; limit: number; offset: number }) {
  return [args.searchTerm, args.searchTerm.replace(/\s+/g, ''), PRODUCT_SEARCH_FUZZY_MATCH_THRESHOLD, args.market, args.limit, args.offset];
}
