const PRODUCT_SEARCH_BASE_CTE = `
  WITH candidates AS (
    SELECT
      p.id,
      'canonical_product'::TEXT AS result_type,
      p.canonical_name AS name,
      NULL::TEXT AS market_code,
      NULL::TEXT AS market_name,
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
      m.name AS market_name,
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
      market_name,
      CASE WHEN is_direct_match THEN 0 ELSE 1 END AS direct_match_rank,
      CASE WHEN is_prefix_match THEN 0 ELSE 1 END AS prefix_match_rank,
      match_score,
      result_type_rank
    FROM candidates
  )
`;

export const PRODUCT_SEARCH_QUERY = `
  ${PRODUCT_SEARCH_BASE_CTE}
  , paged AS (
    SELECT
      id,
      result_type,
      name,
      market_code,
      market_name,
      direct_match_rank,
      prefix_match_rank,
      match_score,
      result_type_rank
    FROM ranked
    ORDER BY direct_match_rank ASC, prefix_match_rank ASC, match_score DESC, result_type_rank ASC, name ASC
    LIMIT $5 OFFSET $6
  ), paged_canonical_ids AS (
    SELECT DISTINCT id
    FROM paged
    WHERE result_type = 'canonical_product'
  ), paged_unmatched_ids AS (
    SELECT DISTINCT id
    FROM paged
    WHERE result_type = 'unmatched_listing'
  ), relevant_listing_ids AS (
    SELECT ml.id AS market_listing_id
    FROM market_listings ml
    JOIN paged_canonical_ids pci ON pci.id = ml.product_id

    UNION

    SELECT pui.id AS market_listing_id
    FROM paged_unmatched_ids pui
  ), latest_snapshots AS (
    SELECT DISTINCT ON (ps.market_listing_id)
      ps.market_listing_id,
      ps.price_cents,
      ps.snapshot_date,
      ps.captured_at
    FROM price_snapshots ps
    JOIN relevant_listing_ids rli ON rli.market_listing_id = ps.market_listing_id
    ORDER BY ps.market_listing_id, ps.snapshot_date DESC, ps.captured_at DESC
  ), canonical_latest_market_prices AS (
    SELECT DISTINCT ON (ml.product_id, m.id)
      ml.product_id,
      m.code AS market_code,
      m.name AS market_name,
      ls.price_cents AS latest_price_cents,
      ls.snapshot_date,
      ls.captured_at,
      ml.id AS market_listing_id
    FROM market_listings ml
    JOIN paged_canonical_ids pci ON pci.id = ml.product_id
    JOIN markets m ON m.id = ml.market_id
    LEFT JOIN latest_snapshots ls ON ls.market_listing_id = ml.id
    ORDER BY ml.product_id, m.id, ls.snapshot_date DESC NULLS LAST, ls.captured_at DESC NULLS LAST, ml.id DESC
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
    FROM canonical_latest_market_prices
    GROUP BY product_id
  ), canonical_latest_prices AS (
    SELECT DISTINCT ON (product_id)
      product_id,
      latest_price_cents
    FROM canonical_latest_market_prices
    ORDER BY product_id, snapshot_date DESC NULLS LAST, captured_at DESC NULLS LAST, market_listing_id DESC
  ), unmatched_latest_prices AS (
    SELECT
      pui.id AS market_listing_id,
      ls.price_cents AS latest_price_cents
    FROM paged_unmatched_ids pui
    LEFT JOIN latest_snapshots ls ON ls.market_listing_id = pui.id
  )
  SELECT
    p.id,
    p.result_type,
    p.name,
    p.market_code,
    CASE
      WHEN p.result_type = 'canonical_product' THEN clp.latest_price_cents
      ELSE ulp.latest_price_cents
    END AS latest_price_cents,
    CASE
      WHEN p.result_type = 'canonical_product' THEN COALESCE(cmp.market_prices, '[]'::jsonb)
      ELSE jsonb_build_array(
        jsonb_build_object(
          'market_code', p.market_code,
          'market_name', p.market_name,
          'latest_price_cents', ulp.latest_price_cents
        )
      )
    END AS market_prices
  FROM paged p
  LEFT JOIN canonical_latest_prices clp ON clp.product_id = p.id AND p.result_type = 'canonical_product'
  LEFT JOIN canonical_market_prices cmp ON cmp.product_id = p.id AND p.result_type = 'canonical_product'
  LEFT JOIN unmatched_latest_prices ulp ON ulp.market_listing_id = p.id AND p.result_type = 'unmatched_listing'
  ORDER BY p.direct_match_rank ASC, p.prefix_match_rank ASC, p.match_score DESC, p.result_type_rank ASC, p.name ASC
`;

export const PRODUCT_SEARCH_COUNT_QUERY = `
  SELECT
    (
      SELECT COUNT(*)::INTEGER
      FROM products p
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
    ) + (
      SELECT COUNT(*)::INTEGER
      FROM market_listings ml
      JOIN markets m ON m.id = ml.market_id
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
    ) AS total_count
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

function buildProductSearchBaseParams(args: { searchTerm: string; market: string | null }) {
  return [args.searchTerm, args.searchTerm.replace(/\s+/g, ''), resolveProductSearchFuzzyMatchThreshold(args.searchTerm), args.market];
}

export function buildProductSearchParams(args: { searchTerm: string; market: string | null; limit: number; offset: number }) {
  return [...buildProductSearchBaseParams(args), args.limit, args.offset];
}

export function buildProductSearchCountParams(args: { searchTerm: string; market: string | null }) {
  return buildProductSearchBaseParams(args);
}
