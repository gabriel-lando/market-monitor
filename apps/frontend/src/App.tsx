import { startTransition, useDeferredValue, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';

import { DEFAULT_HISTORY_INTERVAL, type HistoryInterval, type HistoryPoint, type ProductDetail, type ProductSearchResult } from '@market-monitor/shared';

import { getProduct, getProductHistory, listHistoryIntervals, searchProducts } from './api/client.js';
import { PriceHistoryChart, type PriceHistorySeries } from './components/PriceHistoryChart.js';
import { formatCompactDate, formatCurrency } from './lib/format.js';

const intervals = listHistoryIntervals();
const chartPalette = ['#f07f2f', '#3aa886', '#5f70ff', '#d65082', '#c49a16', '#0f9fd4'];
const searchPresets = ['Arroz', 'Cafe', 'Leite', 'Feijao'];
const SUGGESTION_LIMIT = 20;
const SEARCH_RESULTS_LIMIT = 50;

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function sortSearchResults(results: ProductSearchResult[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  return [...results].sort((left, right) => {
    const leftTypeWeight = left.result_type === 'canonical_product' ? 0 : 1;
    const rightTypeWeight = right.result_type === 'canonical_product' ? 0 : 1;
    if (leftTypeWeight !== rightTypeWeight) {
      return leftTypeWeight - rightTypeWeight;
    }

    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    const leftStartsWith = leftName.startsWith(normalizedQuery) ? 0 : 1;
    const rightStartsWith = rightName.startsWith(normalizedQuery) ? 0 : 1;
    if (leftStartsWith !== rightStartsWith) {
      return leftStartsWith - rightStartsWith;
    }

    const leftIndex = leftName.indexOf(normalizedQuery);
    const rightIndex = rightName.indexOf(normalizedQuery);
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return leftName.localeCompare(rightName, 'pt-BR');
  });
}

function getLatestTimestamp(points: HistoryPoint[]) {
  const latest = [...points].sort((left, right) => Date.parse(right.captured_at) - Date.parse(left.captured_at))[0];
  return latest?.captured_at ?? latest?.snapshot_date ?? null;
}

export function App() {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [searchState, setSearchState] = useState<LoadState>('idle');
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suppressSuggestionsUntilFocus, setSuppressSuggestionsUntilFocus] = useState(false);
  const [searchResultsQuery, setSearchResultsQuery] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<ProductSearchResult[]>([]);
  const [searchResultsState, setSearchResultsState] = useState<LoadState>('idle');
  const [searchResultsMessage, setSearchResultsMessage] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedInterval, setSelectedInterval] = useState<HistoryInterval>(DEFAULT_HISTORY_INTERVAL);
  const [productDetail, setProductDetail] = useState<ProductDetail | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [detailState, setDetailState] = useState<LoadState>('idle');
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [hiddenMarkets, setHiddenMarkets] = useState<string[]>([]);

  const listboxId = useId();

  const canonicalSuggestions = useMemo(() => results.slice(0, SUGGESTION_LIMIT), [results]);
  const showSearchResults = selectedProductId === null && searchResultsQuery !== null;
  const hasSearchValue = query.trim().length > 0 || selectedProductId !== null;

  const latestUpdate = history.length > 0 ? getLatestTimestamp(history) : (productDetail?.linked_markets.find((market) => market.captured_at)?.captured_at ?? null);

  const chartSeries = useMemo<PriceHistorySeries[]>(() => {
    const grouped = new Map<string, PriceHistorySeries>();

    history.forEach((point) => {
      const existing = grouped.get(point.market_code);
      if (existing) {
        existing.points.push(point);
        return;
      }

      grouped.set(point.market_code, {
        marketCode: point.market_code,
        marketName: point.market_name,
        color: chartPalette[grouped.size % chartPalette.length],
        points: [point],
      });
    });

    return Array.from(grouped.values()).sort((left, right) => left.marketName.localeCompare(right.marketName, 'pt-BR'));
  }, [history]);

  const visibleSeries = useMemo(() => chartSeries.filter((series) => !hiddenMarkets.includes(series.marketCode)), [chartSeries, hiddenMarkets]);

  const priceStats = useMemo(() => {
    const allPoints = visibleSeries.flatMap((s) => s.points);
    if (allPoints.length === 0) return null;

    const sorted = [...allPoints].sort((a, b) => Date.parse(b.snapshot_date || b.captured_at) - Date.parse(a.snapshot_date || a.captured_at));
    const current = sorted[0]?.price_cents ?? null;
    const prices = allPoints.map((p) => p.price_cents);
    const high = Math.max(...prices);
    const low = Math.min(...prices);

    return { current, high, low };
  }, [visibleSeries]);

  const selectedMeta = useMemo(() => {
    if (!productDetail) {
      return null;
    }

    const parts = [productDetail.brand, `${productDetail.linked_markets.length} market${productDetail.linked_markets.length === 1 ? '' : 's'}`].filter(Boolean);
    if (latestUpdate) {
      parts.push(`updated ${formatCompactDate(latestUpdate)}`);
    }

    return parts.join(' · ');
  }, [latestUpdate, productDetail]);

  useEffect(() => {
    setHiddenMarkets([]);
  }, [selectedProductId]);

  useEffect(() => {
    const trimmedQuery = deferredQuery.trim();

    if (trimmedQuery.length < 2) {
      setResults([]);
      setActiveIndex(-1);
      setSearchState('idle');
      setSuggestionsOpen(false);
      setSearchMessage(trimmedQuery.length === 0 ? null : 'Type at least 2 characters.');
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setSearchState('loading');
      setSearchMessage(null);

      try {
        const response = await searchProducts(trimmedQuery, { limit: SUGGESTION_LIMIT, signal: controller.signal });
        const sortedResults = sortSearchResults(response.data, trimmedQuery)
          .filter((result) => result.result_type === 'canonical_product')
          .slice(0, SUGGESTION_LIMIT);

        startTransition(() => {
          setResults(sortedResults);
          setSuggestionsOpen(!suppressSuggestionsUntilFocus);
          setActiveIndex(-1);
          setSearchState('ready');
          setSearchMessage(sortedResults.length === 0 ? 'No matching products found.' : null);
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setSearchState('error');
        setSearchMessage(error instanceof Error ? error.message : 'Failed to search products.');
        setSuggestionsOpen(!suppressSuggestionsUntilFocus);
      }
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [deferredQuery, suppressSuggestionsUntilFocus]);

  useEffect(() => {
    if (searchResultsQuery === null) {
      setSearchResults([]);
      setSearchResultsState('idle');
      setSearchResultsMessage(null);
      return;
    }

    const trimmedSearchResultsQuery = searchResultsQuery.trim();

    if (trimmedSearchResultsQuery.length < 2) {
      setSearchResults([]);
      setSearchResultsState('idle');
      setSearchResultsMessage('Type at least 2 characters.');
      return;
    }

    const controller = new AbortController();

    async function loadSearchResults(submittedQuery: string) {
      setSearchResultsState('loading');
      setSearchResultsMessage(null);

      try {
        const response = await searchProducts(submittedQuery, { limit: SEARCH_RESULTS_LIMIT, signal: controller.signal });
        const canonicalResults = sortSearchResults(response.data, submittedQuery)
          .filter((result) => result.result_type === 'canonical_product')
          .slice(0, SEARCH_RESULTS_LIMIT);

        startTransition(() => {
          setSearchResults(canonicalResults);
          setSearchResultsState('ready');
          setSearchResultsMessage(canonicalResults.length === 0 ? 'No matching products found.' : null);
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setSearchResultsState('error');
        setSearchResultsMessage(error instanceof Error ? error.message : 'Failed to load search results.');
      }
    }

    void loadSearchResults(trimmedSearchResultsQuery);

    return () => {
      controller.abort();
    };
  }, [searchResultsQuery]);

  useEffect(() => {
    if (!selectedProductId) {
      setProductDetail(null);
      setHistory([]);
      setDetailState('idle');
      setDetailMessage(null);
      return;
    }

    const controller = new AbortController();

    async function loadProduct(productId: string, interval: HistoryInterval) {
      setDetailState('loading');
      setDetailMessage(null);

      try {
        const [detailResponse, historyResponse] = await Promise.all([getProduct(productId, controller.signal), getProductHistory(productId, interval, controller.signal)]);

        startTransition(() => {
          setProductDetail(detailResponse.data);
          setHistory(historyResponse.data.history);
          setDetailState('ready');
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setDetailState('error');
        setDetailMessage(error instanceof Error ? error.message : 'Failed to load product history.');
      }
    }

    void loadProduct(selectedProductId, selectedInterval);

    return () => {
      controller.abort();
    };
  }, [selectedInterval, selectedProductId]);

  function selectProduct(result: ProductSearchResult) {
    if (result.result_type !== 'canonical_product') {
      return;
    }

    startTransition(() => {
      setSuppressSuggestionsUntilFocus(true);
      setSearchResultsQuery(null);
      setSearchResults([]);
      setSearchResultsState('idle');
      setSearchResultsMessage(null);
      setSelectedProductId(result.id);
      setQuery(result.name);
      setSuggestionsOpen(false);
      setActiveIndex(-1);
    });
  }

  function resetSearchResultsView() {
    setSearchResultsQuery(null);
    setSearchResults([]);
    setSearchResultsState('idle');
    setSearchResultsMessage(null);
  }

  function handleQueryChange(nextQuery: string) {
    if (showSearchResults) {
      setQuery(nextQuery);
      setSuppressSuggestionsUntilFocus(true);
      setSuggestionsOpen(false);
      setActiveIndex(-1);
      setSearchResultsQuery(nextQuery);
      return;
    }

    setSuppressSuggestionsUntilFocus(false);
    setQuery(nextQuery);
    resetSearchResultsView();
  }

  function openSearchResults() {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) {
      return;
    }

    setSuppressSuggestionsUntilFocus(true);
    setSuggestionsOpen(false);
    setActiveIndex(-1);
    setSelectedProductId(null);
    setSearchResultsQuery(trimmedQuery);
  }

  function reopenSuggestionsFromInput() {
    if (showSearchResults) {
      setSuggestionsOpen(false);
      return;
    }

    setSuppressSuggestionsUntilFocus(false);

    if (results.length > 0 || searchMessage || searchState === 'loading') {
      setSuggestionsOpen(true);
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      if (canonicalSuggestions.length === 0) {
        return;
      }

      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveIndex((current) => (current < canonicalSuggestions.length - 1 ? current + 1 : 0));
    }

    if (event.key === 'ArrowUp') {
      if (canonicalSuggestions.length === 0) {
        return;
      }

      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveIndex((current) => (current > 0 ? current - 1 : canonicalSuggestions.length - 1));
    }

    if (event.key === 'Enter') {
      if (suggestionsOpen && activeIndex >= 0) {
        event.preventDefault();
        const nextResult = canonicalSuggestions[activeIndex];
        if (nextResult) {
          selectProduct(nextResult);
        }
        return;
      }

      if (query.trim().length >= 2) {
        event.preventDefault();
        openSearchResults();
      }
    }

    if (event.key === 'Escape') {
      setSuggestionsOpen(false);
    }
  }

  function clearSelection() {
    setSuppressSuggestionsUntilFocus(false);
    setQuery('');
    setResults([]);
    setSearchState('idle');
    setSearchMessage(null);
    resetSearchResultsView();
    setSuggestionsOpen(false);
    setActiveIndex(-1);
    setSelectedProductId(null);
    setProductDetail(null);
    setHistory([]);
    setDetailState('idle');
    setDetailMessage(null);
  }

  function applySearchPreset(preset: string) {
    setSuppressSuggestionsUntilFocus(false);
    resetSearchResultsView();
    setSelectedProductId(null);
    setQuery(preset);
    setSuggestionsOpen(false);
    setActiveIndex(-1);
  }

  function toggleMarketVisibility(marketCode: string) {
    setHiddenMarkets((current) => (current.includes(marketCode) ? current.filter((entry) => entry !== marketCode) : [...current, marketCode]));
  }

  return (
    <div className="app-shell">
      <header
        className="app-topbar"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setSuggestionsOpen(false);
          }
        }}
      >
        <button type="button" className="brand-mark brand-home-button" aria-label="Go to home" onClick={clearSelection}>
          <span className="brand-dot" aria-hidden="true">
            🛒
          </span>
          <span className="brand-name">Market Monitor</span>
        </button>

        <div className="search-anchor">
          <label className="sr-only" htmlFor="product-search">
            Search product
          </label>

          <div className="search-input-shell">
            <span className="search-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              id="product-search"
              type="search"
              value={query}
              placeholder="Search products..."
              autoComplete="off"
              role="combobox"
              aria-expanded={suggestionsOpen}
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
              onChange={(event) => handleQueryChange(event.target.value)}
              onPointerDown={reopenSuggestionsFromInput}
              onFocus={reopenSuggestionsFromInput}
              onKeyDown={handleSearchKeyDown}
            />

            <button type="button" className={`search-clear ${hasSearchValue ? '' : 'is-idle'}`.trim()} onClick={clearSelection} disabled={!hasSearchValue}>
              Clear
            </button>
          </div>

          {suggestionsOpen ? (
            <div className="suggestions-popover">
              {canonicalSuggestions.length > 0 ? (
                <ul id={listboxId} className="suggestion-list" role="listbox">
                  {canonicalSuggestions.map((result, index) => (
                    <li key={result.id}>
                      <button
                        id={`${listboxId}-${index}`}
                        type="button"
                        role="option"
                        aria-selected={activeIndex === index}
                        className={`suggestion-card ${activeIndex === index ? 'is-active' : ''} ${selectedProductId === result.id ? 'is-selected' : ''}`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          selectProduct(result);
                        }}
                      >
                        <strong>{result.name}</strong>
                        {result.latest_price_cents !== null ? <span>{formatCurrency(result.latest_price_cents)}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {searchMessage ? <p className={`feedback-message ${searchState === 'error' ? 'is-error' : ''}`}>{searchMessage}</p> : null}
            </div>
          ) : null}
        </div>
      </header>

      <main className="chart-stage">
        <section className="chart-panel panel">
          {selectedProductId && productDetail ? (
            <div className="chart-header">
              <div className="selected-product-copy">
                <p className="eyebrow">Selected product</p>
                <h1>{productDetail.canonical_name}</h1>
                {selectedMeta ? <p className="selected-meta">{selectedMeta}</p> : null}
              </div>

              <div className="interval-chip-row" role="toolbar" aria-label="History interval selector">
                {intervals.map((interval) => (
                  <button key={interval} type="button" className={`interval-chip ${selectedInterval === interval ? 'is-active' : ''}`} onClick={() => setSelectedInterval(interval)} aria-pressed={selectedInterval === interval}>
                    {interval}
                  </button>
                ))}
              </div>
            </div>
          ) : showSearchResults ? (
            <div className="search-results-head">
              <p className="eyebrow">Search Results</p>
            </div>
          ) : (
            <div className="empty-state-head">
              <p className="eyebrow">Market Monitor</p>
              <h1>Track grocery prices with one quick search.</h1>
              <p>Search for a product above to reveal its price history and compare markets on a single clean chart.</p>

              <div className="preset-row" aria-label="Suggested searches">
                {searchPresets.map((preset) => (
                  <button key={preset} type="button" className="preset-chip" onClick={() => applySearchPreset(preset)}>
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          )}

          {detailState === 'loading' ? (
            <div className="chart-loading-state" aria-live="polite">
              <div className="skeleton-line skeleton-title" />
              <div className="skeleton-chart" />
            </div>
          ) : null}

          {detailState === 'error' ? <p className="feedback-message is-error">{detailMessage}</p> : null}

          {showSearchResults ? (
            <>
              {searchResultsState === 'loading' ? (
                <div className="chart-loading-state" aria-live="polite">
                  <div className="skeleton-line skeleton-title" />
                  <div className="skeleton-chart" />
                </div>
              ) : null}

              {searchResultsState === 'error' ? <p className="feedback-message is-error">{searchResultsMessage}</p> : null}

              {searchResultsState !== 'loading' && searchResultsState !== 'error' ? (
                searchResults.length > 0 ? (
                  <div className="search-results-list" role="list" aria-label="Search results list">
                    {searchResults.map((result) => (
                      <button key={result.id} type="button" className="search-result-card" onClick={() => selectProduct(result)}>
                        <span className="search-result-price">{result.latest_price_cents !== null ? formatCurrency(result.latest_price_cents) : '—'}</span>
                        <span className="search-result-copy">
                          <strong>{result.name}</strong>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="chart-empty">{searchResultsMessage ?? 'No matching products found.'}</div>
                )
              ) : null}
            </>
          ) : null}

          {detailState !== 'loading' && detailState !== 'error' && selectedProductId && productDetail ? (
            history.length > 0 ? (
              visibleSeries.length > 0 ? (
                <>
                  {priceStats ? (
                    <div className="price-stats-row" aria-label="Price summary">
                      <div className="price-stat">
                        <span className="price-stat-label">Current</span>
                        <span className="price-stat-value">{priceStats.current !== null ? formatCurrency(priceStats.current) : '—'}</span>
                      </div>
                      <div className="price-stat price-stat--high">
                        <span className="price-stat-label">Highest</span>
                        <span className="price-stat-value">{formatCurrency(priceStats.high)}</span>
                      </div>
                      <div className="price-stat price-stat--low">
                        <span className="price-stat-label">Lowest</span>
                        <span className="price-stat-value">{formatCurrency(priceStats.low)}</span>
                      </div>
                    </div>
                  ) : null}

                  <PriceHistoryChart ariaLabel={`Price history for ${productDetail.canonical_name}`} series={visibleSeries} />

                  {chartSeries.length > 1 ? (
                    <div className="legend-row" aria-label="Toggle market series visibility">
                      {chartSeries.map((series) => {
                        const isHidden = hiddenMarkets.includes(series.marketCode);

                        return (
                          <button key={series.marketCode} type="button" className={`legend-chip ${isHidden ? 'is-muted' : ''}`} onClick={() => toggleMarketVisibility(series.marketCode)} aria-pressed={!isHidden}>
                            <span className="legend-swatch" style={{ backgroundColor: series.color }} aria-hidden="true" />
                            <span>{series.marketName}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="chart-empty">Enable at least one market to render the chart.</div>
              )
            ) : (
              <div className="chart-empty">History is not available for this product yet.</div>
            )
          ) : null}

          {!selectedProductId && !showSearchResults && detailState === 'idle' ? (
            <div className="home-preview" aria-hidden="true">
              <div className="home-preview-chart">
                <span className="preview-grid preview-grid-top" />
                <span className="preview-grid preview-grid-middle" />
                <span className="preview-grid preview-grid-bottom" />
                <span className="preview-line" />
                <span className="preview-dot preview-dot-a" />
                <span className="preview-dot preview-dot-b" />
                <span className="preview-dot preview-dot-c" />
                <span className="preview-dot preview-dot-d" />
              </div>

              <div className="home-preview-caption">
                <span>Start with a product name above.</span>
                <span>The chart here will switch from preview to real price history.</span>
              </div>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
