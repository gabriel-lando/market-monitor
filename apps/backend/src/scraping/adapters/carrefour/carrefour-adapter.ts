import { NormalizedListingSchema, type NormalizedListing } from '@market-monitor/shared';
import { z } from 'zod';

import type { MarketAdapter, ScrapeLogger, ScrapedCategory, ScrapedCategoryPage } from '../base/types.js';
import { normalizeText, slugify, toMoneyCents, toPositiveNumber } from '../../pipeline/utils.js';

const CARREFOUR_BASE_URL = 'https://mercado.carrefour.com.br';
const CARREFOUR_CATEGORY_ROUTE = 'layout/default,routes/category-search';
const SITEMAP_INDEX_URL = `${CARREFOUR_BASE_URL}/sitemap.xml`;
const CATEGORY_SITEMAP_SEGMENT = '/sitemap/category-';
const PAGE_DELAY_MS = 150;
const MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 1200;
const PARSER_VERSION = 'carrefour-v2-data';
const START_PAGE_INDEX = 1;
const CARREFOUR_PRODUCTS_PER_PAGE = 100;

const TARGET_STORE_CITY = 'Porto Alegre';
const TARGET_STORE_NAME = 'Hiper Passo d Areia';
const TARGET_STORE_POSTAL_CODE = '91130-450';
const CARREFOUR_REGION_ID_FOOD = '';

const USER_AGENT = 'market-monitor/0.1.0 (+https://mercado.carrefour.com.br)';
const STORE_LOOKUP_URL = `${CARREFOUR_BASE_URL}/action/stores-from-pickups.data`;

class CarrefourRequestError extends Error {
  readonly statusCode: number;
  readonly url: string;

  constructor(url: string, statusCode: number) {
    super(`Failed request to ${url} with status ${statusCode}`);
    this.name = 'CarrefourRequestError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

const CommercialOfferSchema = z
  .object({
    Price: z.number().optional(),
    ListPrice: z.number().optional(),
    PriceWithoutDiscount: z.number().optional(),
    SpotPrice: z.number().optional(),
    spotPrice: z.number().optional(),
    listPrice: z.number().optional(),
    price: z.number().optional(),
    calculatedSpotPrice: z.number().optional(),
    AvailableQuantity: z.number().optional(),
    availableQuantity: z.number().optional(),
    IsAvailable: z.boolean().optional(),
    isAvailable: z.boolean().optional(),
    PriceValidUntil: z.string().nullable().optional(),
    priceValidUntil: z.string().nullable().optional(),
  })
  .passthrough();

const SellerSchema = z
  .object({
    sellerId: z.string().min(1).optional(),
    sellerName: z.string().min(1).optional(),
    sellerDefault: z.boolean().optional(),
    commertialOffer: CommercialOfferSchema.optional(),
    commercialOffer: CommercialOfferSchema.optional(),
  })
  .passthrough();

const ItemSchema = z
  .object({
    itemId: z.string().min(1),
    name: z.string().optional(),
    ean: z.string().optional(),
    measurementUnit: z.string().optional(),
    unitMultiplier: z.number().optional(),
    referenceId: z.array(z.object({ Key: z.string(), Value: z.string() })).optional(),
    images: z.array(z.object({ imageUrl: z.string().url() }).passthrough()).default([]),
    sellers: z.array(SellerSchema).default([]),
  })
  .passthrough();

const ProductSchema = z
  .object({
    productId: z.string().min(1),
    productName: z.string().min(1).optional(),
    brand: z.string().optional(),
    link: z.string().min(1).optional(),
    productReference: z.string().optional(),
    productReferenceCode: z.string().optional(),
    categories: z.array(z.string()).default([]),
    categoriesIds: z.array(z.string()).default([]),
    Cont_liq: z.unknown().optional(),
    UM_Cont: z.unknown().optional(),
    items: z.array(ItemSchema).default([]),
  })
  .passthrough();

type CarrefourProduct = z.infer<typeof ProductSchema>;
type CarrefourItem = z.infer<typeof ItemSchema>;
type CarrefourSeller = z.infer<typeof SellerSchema>;

type CarrefourStoreContext = {
  city: string;
  storeName: string;
  postalCode: string;
  cookieHeader: string;
};

type CarrefourPagination = {
  next?: {
    index?: number;
  } | null;
  current?: {
    index?: number;
  } | null;
  last?: {
    index?: number;
  } | null;
  count?: number;
  perPage?: number;
};

type CarrefourDecodedCategoryData = {
  products: CarrefourProduct[];
  pagination?: CarrefourPagination;
  totalCount?: number;
};

const STORE_STRING_PATTERN = /"((?:[^"\\]|\\.)*)"/g;
const POSTAL_CODE_PATTERN = /^\d{5}-\d{3}$/;
const XML_LOC_PATTERN = /<loc>([^<]+)<\/loc>/g;
const SERIALIZED_REF_KEY_PATTERN = /^_\d+$/;

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSerializedRecord(value: unknown): value is Record<string, number> {
  if (!isObjectLike(value)) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }

  return keys.every((key) => SERIALIZED_REF_KEY_PATTERN.test(key) && typeof value[key] === 'number');
}

function isSerializedGraph(payload: unknown): payload is unknown[] {
  if (!Array.isArray(payload) || payload.length === 0) {
    return false;
  }

  return payload.some((entry) => isSerializedRecord(entry));
}

function decodeSerializedGraph(payload: unknown[]) {
  const memo = new Map<number, unknown>();

  const decodeValue = (value: unknown): unknown => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < payload.length) {
      return decodeRef(value);
    }

    return value;
  };

  const decodeRef = (index: number): unknown => {
    if (memo.has(index)) {
      return memo.get(index);
    }

    const source = payload[index];

    if (!isObjectLike(source)) {
      memo.set(index, source);
      return source;
    }

    if (Array.isArray(source)) {
      const decoded: unknown[] = [];
      memo.set(index, decoded);

      for (const entry of source) {
        decoded.push(decodeValue(entry));
      }

      return decoded;
    }

    const decoded: Record<string, unknown> = {};
    memo.set(index, decoded);

    for (const [rawKey, rawValue] of Object.entries(source)) {
      if (SERIALIZED_REF_KEY_PATTERN.test(rawKey)) {
        const keyIndex = Number(rawKey.slice(1));
        const decodedKey = decodeRef(keyIndex);

        if (typeof decodedKey === 'string') {
          decoded[decodedKey] = decodeValue(rawValue);
        }

        continue;
      }

      decoded[rawKey] = decodeValue(rawValue);
    }

    return decoded;
  };

  return {
    decodeRef,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCategorySourceKeys(category: ScrapedCategory, categoriesIds: string[]) {
  const keys = new Set<string>();
  keys.add(category.sourceKey);

  for (const path of categoriesIds) {
    for (const segment of path.split('/').filter(Boolean)) {
      keys.add(segment);
    }
  }

  return [...keys];
}

function selectSeller(item: CarrefourItem) {
  return item.sellers.find((seller) => seller.sellerDefault) ?? item.sellers[0] ?? null;
}

function getCommercialOffer(seller: CarrefourSeller | null) {
  return seller?.commertialOffer ?? seller?.commercialOffer ?? null;
}

function resolveAvailabilityStatus(seller: CarrefourSeller | null) {
  const offer = getCommercialOffer(seller);

  if (!offer) {
    return 'unknown' as const;
  }

  if (offer.IsAvailable === false || offer.isAvailable === false) {
    return 'out_of_stock';
  }

  const availableQuantity = toNonNegativeInteger(offer.AvailableQuantity ?? offer.availableQuantity);
  if (availableQuantity !== undefined && availableQuantity === 0) {
    return 'out_of_stock';
  }

  if (offer.IsAvailable === true || offer.isAvailable === true || (availableQuantity !== undefined && availableQuantity > 0)) {
    return 'in_stock';
  }

  return 'unknown';
}

function firstScalar(value: unknown): string | number | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const scalar = firstScalar(entry);
      if (scalar !== undefined) {
        return scalar;
      }
    }

    return undefined;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }

  return undefined;
}

function resolveMeasurement(product: CarrefourProduct, item: CarrefourItem) {
  const productUnitValue = toPositiveNumber(firstScalar(product.Cont_liq));
  const itemUnitValue = toPositiveNumber(item.unitMultiplier);
  const productMeasurementUnit = firstScalar(product.UM_Cont);

  return {
    measurementUnit: typeof productMeasurementUnit === 'string' ? productMeasurementUnit : item.measurementUnit,
    unitValue: productUnitValue ?? itemUnitValue,
    packQuantity: itemUnitValue && Number.isInteger(itemUnitValue) ? itemUnitValue : undefined,
  };
}

function humanizeCategorySegment(segment: string) {
  return segment
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeCategoryPath(urlValue: string) {
  let parsed: URL;

  try {
    parsed = new URL(urlValue);
  } catch {
    return null;
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    return null;
  }

  const rawPath = decodeURIComponent(parsed.pathname.replace(/\/+$/, ''));
  const withoutPrefix = rawPath.startsWith('/categoria/') ? rawPath.slice('/categoria/'.length) : rawPath.slice(1);
  const normalizedPath = withoutPrefix
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');

  if (!normalizedPath || normalizedPath.startsWith('produto/')) {
    return null;
  }

  return normalizedPath;
}

function buildCategoryFromPath(categoryPath: string): ScrapedCategory {
  const segments = categoryPath.split('/');
  const lastSegment = segments[segments.length - 1] ?? categoryPath;
  const displayPath = segments.map(humanizeCategorySegment);
  const depth = segments.length;

  return {
    sourceKey: categoryPath,
    sourceId: categoryPath,
    name: humanizeCategorySegment(lastSegment),
    slug: slugify(lastSegment),
    url: `${CARREFOUR_BASE_URL}/categoria/${categoryPath}`,
    depth,
    path: displayPath,
    parentSourceKey: segments.length > 1 ? segments.slice(0, -1).join('/') : null,
    isLeaf: true,
  };
}

function extractXmlLocs(xmlPayload: string) {
  return [...xmlPayload.matchAll(XML_LOC_PATTERN)].map((match) => match[1]);
}

function getPaginationIndex(entry: unknown) {
  if (!isObjectLike(entry)) {
    return undefined;
  }

  const rawIndex = (entry as { index?: unknown }).index;
  const numericIndex = typeof rawIndex === 'number' ? rawIndex : typeof rawIndex === 'string' ? Number(rawIndex) : Number.NaN;

  if (!Number.isFinite(numericIndex) || numericIndex < 0) {
    return undefined;
  }

  return numericIndex;
}

function createCategoryFetchUrl(category: ScrapedCategory, pageIndex: number) {
  const params = new URLSearchParams({
    _routes: CARREFOUR_CATEGORY_ROUTE,
    page: String(pageIndex),
    count: String(CARREFOUR_PRODUCTS_PER_PAGE),
  });

  return `${CARREFOUR_BASE_URL}/categoria/${category.sourceId}.data?${params.toString()}`;
}

function toAbsoluteUrl(rawUrl?: string) {
  if (!rawUrl) {
    return undefined;
  }

  try {
    return new URL(rawUrl, CARREFOUR_BASE_URL).toString();
  } catch {
    return undefined;
  }
}

function toOptionalNonEmptyString(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toCategoryPath(category: ScrapedCategory, product: CarrefourProduct) {
  const normalizedPaths = product.categories.map((categoryPath) => categoryPath.split('/').filter(Boolean).join(' > ')).filter((path) => path.length > 0);

  if (normalizedPaths.length > 0) {
    return normalizedPaths;
  }

  return [category.path.join(' > ')];
}

function readOfferPrice(offer: Record<string, unknown>) {
  const candidates = [offer.Price, offer.price, offer.spotPrice, offer.calculatedSpotPrice, offer.ListPrice, offer.listPrice];

  for (const candidate of candidates) {
    const cents = toMoneyCents(candidate);
    if (cents !== undefined && cents > 0) {
      return cents;
    }
  }

  return undefined;
}

function toNonNegativeInteger(value: unknown) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;

  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }

  return Math.trunc(numeric);
}

function normalizeListing(category: ScrapedCategory, product: CarrefourProduct, item: CarrefourItem, seller: CarrefourSeller, fetchUrl: string): NormalizedListing | null {
  const commercialOffer = getCommercialOffer(seller);
  if (!commercialOffer) {
    return null;
  }

  const priceCents = readOfferPrice(commercialOffer);
  const availabilityStatus = resolveAvailabilityStatus(seller);

  if (priceCents === undefined || priceCents <= 0 || availabilityStatus === 'out_of_stock') {
    return null;
  }

  const { measurementUnit, unitValue, packQuantity } = resolveMeasurement(product, item);
  const sourceName = item.name ?? product.productName;
  if (!sourceName) {
    return null;
  }

  const normalizedName = normalizeText(sourceName);
  const brand = product.brand?.trim() || undefined;
  const normalizedBrand = brand ? normalizeText(brand) : undefined;
  const identifiers = [
    item.ean
      ? {
          type: 'ean',
          value: item.ean,
          scope: 'global' as const,
          isPrimary: true,
          isVerified: true,
        }
      : null,
    product.productId
      ? {
          type: 'product_id',
          value: product.productId,
          scope: 'market' as const,
          isPrimary: false,
          isVerified: true,
        }
      : null,
    item.itemId
      ? {
          type: 'item_id',
          value: item.itemId,
          scope: 'market' as const,
          isPrimary: true,
          isVerified: true,
        }
      : null,
    product.productReferenceCode
      ? {
          type: 'sku',
          value: product.productReferenceCode,
          scope: 'market' as const,
          isPrimary: false,
          isVerified: true,
        }
      : null,
  ].filter((identifier): identifier is NonNullable<typeof identifier> => Boolean(identifier));

  return NormalizedListingSchema.parse({
    marketCode: 'carrefour',
    sourceKey: item.itemId || product.productId,
    sourceProductId: product.productId,
    sourceItemId: item.itemId,
    sourceSku: toOptionalNonEmptyString(product.productReferenceCode) ?? toOptionalNonEmptyString(product.productReference),
    sourceName,
    normalizedName,
    brand,
    normalizedBrand,
    identifiers,
    categorySourceKeys: toCategorySourceKeys(category, product.categoriesIds),
    categoryPath: toCategoryPath(category, product),
    measurementUnit,
    unitValue,
    packQuantity,
    priceCents,
    listPriceCents: toMoneyCents(commercialOffer.ListPrice ?? commercialOffer.listPrice),
    spotPriceCents: toMoneyCents(commercialOffer.SpotPrice ?? commercialOffer.spotPrice ?? commercialOffer.calculatedSpotPrice),
    priceWithoutDiscountCents: toMoneyCents(commercialOffer.PriceWithoutDiscount),
    currencyCode: 'BRL',
    availabilityStatus,
    availableQuantity: toNonNegativeInteger(commercialOffer.AvailableQuantity ?? commercialOffer.availableQuantity),
    capturedAt: new Date().toISOString(),
    priceValidUntil: commercialOffer.PriceValidUntil ?? commercialOffer.priceValidUntil ?? undefined,
    productUrl: toAbsoluteUrl(product.link),
    imageUrl: toAbsoluteUrl(item.images[0]?.imageUrl),
    fetchUrl,
    parserVersion: PARSER_VERSION,
    rawPayload: {
      product,
      item,
      seller,
    },
  });
}

function normalizePostalCode(postalCode: string) {
  const digits = postalCode.replace(/\D/g, '');

  if (digits.length !== 8) {
    return postalCode;
  }

  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

function encodePostalCodeCookie(postalCode: string) {
  return Buffer.from(JSON.stringify(postalCode)).toString('base64');
}

function extractStoreStrings(payload: string) {
  return [...payload.matchAll(STORE_STRING_PATTERN)].map((match) => match[1].replace(/\\"/g, '"'));
}

function findPostalCodeNearStore(storeStrings: string[], storeIndex: number) {
  const MAX_LOOKAHEAD = 8;

  for (let index = storeIndex + 1; index <= storeIndex + MAX_LOOKAHEAD && index < storeStrings.length; index += 1) {
    const candidate = normalizePostalCode(storeStrings[index]);
    if (POSTAL_CODE_PATTERN.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function resolveStoreContext(logger: ScrapeLogger): Promise<CarrefourStoreContext> {
  const lookupBody = new URLSearchParams({ city: TARGET_STORE_CITY });
  const response = await fetch(STORE_LOOKUP_URL, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'user-agent': USER_AGENT,
      'origin': CARREFOUR_BASE_URL,
      'referer': `${CARREFOUR_BASE_URL}/`,
    },
    body: lookupBody.toString(),
  });

  if (!response.ok) {
    throw new CarrefourRequestError(STORE_LOOKUP_URL, response.status);
  }

  const payload = await response.text();
  const storeStrings = extractStoreStrings(payload);
  const targetStoreNormalizedName = normalizeText(TARGET_STORE_NAME);
  const targetStoreIndex = storeStrings.findIndex((value) => normalizeText(value) === targetStoreNormalizedName);

  if (targetStoreIndex < 0) {
    throw new Error(`The target Carrefour store \"${TARGET_STORE_NAME}\" was not returned for city ${TARGET_STORE_CITY}.`);
  }

  const discoveredPostalCode = findPostalCodeNearStore(storeStrings, targetStoreIndex) ?? normalizePostalCode(TARGET_STORE_POSTAL_CODE);
  const encodedPostalCodeCookie = encodePostalCodeCookie(discoveredPostalCode);
  const cookieParts = [`cep_carrefour_ja=${discoveredPostalCode}`, `cep=${encodeURIComponent(encodedPostalCodeCookie)}`];

  if (CARREFOUR_REGION_ID_FOOD) {
    cookieParts.push(`region-id-food=${CARREFOUR_REGION_ID_FOOD}`);
  }

  logger.info(
    {
      market: 'carrefour',
      city: TARGET_STORE_CITY,
      targetStoreName: TARGET_STORE_NAME,
      targetStorePostalCode: discoveredPostalCode,
      regionCookieConfigured: Boolean(CARREFOUR_REGION_ID_FOOD),
    },
    'Resolved Carrefour target store context.',
  );

  return {
    city: TARGET_STORE_CITY,
    storeName: TARGET_STORE_NAME,
    postalCode: discoveredPostalCode,
    cookieHeader: cookieParts.join('; '),
  };
}

function createRequestHeaders(storeContext: CarrefourStoreContext): HeadersInit {
  return {
    'accept': 'application/json',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'user-agent': USER_AGENT,
    'cookie': storeContext.cookieHeader,
    'origin': CARREFOUR_BASE_URL,
    'referer': `${CARREFOUR_BASE_URL}/`,
  };
}

async function fetchJson<TSchema extends z.ZodTypeAny>(url: string, schema: TSchema, storeContext: CarrefourStoreContext): Promise<z.infer<TSchema>> {
  const response = await fetch(url, {
    headers: createRequestHeaders(storeContext),
  });

  if (!response.ok) {
    throw new CarrefourRequestError(url, response.status);
  }

  const payload = await response.json();
  return schema.parse(payload) as z.infer<TSchema>;
}

async function fetchText(url: string, storeContext: CarrefourStoreContext | null) {
  const response = await fetch(url, {
    headers: {
      ...(storeContext ? createRequestHeaders(storeContext) : { 'user-agent': USER_AGENT }),
      accept: 'application/json, text/xml, application/xml;q=0.9, */*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new CarrefourRequestError(url, response.status);
  }

  return response.text();
}

async function fetchTextWithRetries(url: string, storeContext: CarrefourStoreContext | null, logger: ScrapeLogger, context: Record<string, unknown>) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await fetchText(url, storeContext);
    } catch (error) {
      if (!(error instanceof CarrefourRequestError)) {
        throw error;
      }

      const isRetryable = error.statusCode === 429 || error.statusCode >= 500;
      if (!isRetryable) {
        throw error;
      }

      const exhausted = attempt === MAX_RATE_LIMIT_RETRIES;
      if (exhausted) {
        throw error;
      }

      const delayMs = RATE_LIMIT_BACKOFF_MS * (attempt + 1);
      logger.warn?.(
        {
          market: 'carrefour',
          ...context,
          statusCode: error.statusCode,
          attempt: attempt + 1,
          retryDelayMs: delayMs,
        },
        'Transient Carrefour endpoint error; retrying text request.',
      );
      await sleep(delayMs);
    }
  }

  throw new Error('Unexpected retry loop exit while requesting Carrefour endpoint text payload.');
}

function decodeCategoryDataFromPayload(payload: unknown): CarrefourDecodedCategoryData | null {
  if (!isSerializedGraph(payload)) {
    return null;
  }

  const graph = decodeSerializedGraph(payload);
  const rootCandidate = graph.decodeRef(6);

  if (isObjectLike(rootCandidate) && Array.isArray(rootCandidate.products) && isObjectLike(rootCandidate.pagination)) {
    const products: CarrefourProduct[] = [];

    for (const rawProduct of rootCandidate.products) {
      const parsedProduct = ProductSchema.safeParse(rawProduct);
      if (parsedProduct.success) {
        products.push(parsedProduct.data);
      }
    }

    return {
      products,
      pagination: rootCandidate.pagination as CarrefourPagination,
      totalCount: toPositiveNumber(rootCandidate.totalCount),
    };
  }

  const candidateIndexes: number[] = [];

  for (let index = 0; index < payload.length; index += 1) {
    const source = payload[index];
    if (isSerializedRecord(source)) {
      candidateIndexes.push(index);
    }
  }

  let bestCandidate: Record<string, unknown> | null = null;
  let bestProducts = -1;

  for (const index of candidateIndexes) {
    const decoded = graph.decodeRef(index);
    if (!isObjectLike(decoded)) {
      continue;
    }

    const products = decoded.products;
    const pagination = decoded.pagination;
    if (!Array.isArray(products) || !isObjectLike(pagination)) {
      continue;
    }

    if (products.length > bestProducts) {
      bestCandidate = decoded;
      bestProducts = products.length;
    }
  }

  if (!bestCandidate) {
    return null;
  }

  const rawProducts = Array.isArray(bestCandidate.products) ? bestCandidate.products : [];
  const products: CarrefourProduct[] = [];

  for (const rawProduct of rawProducts) {
    const parsedProduct = ProductSchema.safeParse(rawProduct);
    if (parsedProduct.success) {
      products.push(parsedProduct.data);
    }
  }

  const pagination = isObjectLike(bestCandidate.pagination) ? (bestCandidate.pagination as CarrefourPagination) : undefined;
  const totalCount = toPositiveNumber(bestCandidate.totalCount);

  return {
    products,
    pagination,
    totalCount,
  };
}

async function fetchCategoryPageWithRetries(fetchUrl: string, storeContext: CarrefourStoreContext, logger: ScrapeLogger, category: ScrapedCategory, pageIndex: number) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      const payload = await fetchJson(fetchUrl, z.unknown(), storeContext);

      if (Array.isArray(payload) && payload.length === 1 && isObjectLike(payload[0]) && Object.keys(payload[0]).length === 0) {
        return null;
      }

      return decodeCategoryDataFromPayload(payload);
    } catch (error) {
      if (!(error instanceof CarrefourRequestError)) {
        throw error;
      }

      const isRetryable = error.statusCode === 404 || error.statusCode === 429 || error.statusCode >= 500;
      if (!isRetryable) {
        throw error;
      }

      const exhausted = attempt === MAX_RATE_LIMIT_RETRIES;
      if (exhausted) {
        if (error.statusCode === 404) {
          logger.warn?.(
            {
              market: 'carrefour',
              category: category.sourceKey,
              categoryName: category.name,
              pageIndex,
              statusCode: error.statusCode,
              attempts: attempt + 1,
            },
            'Carrefour page returned persistent 404; stopping this category pagination without failing the whole job.',
          );
          return null;
        }

        logger.warn?.(
          {
            market: 'carrefour',
            category: category.sourceKey,
            categoryName: category.name,
            pageIndex,
            statusCode: error.statusCode,
            attempts: attempt + 1,
          },
          'Carrefour endpoint error persisted after retries; skipping remaining pages for this category.',
        );
        return null;
      }

      const delayMs = RATE_LIMIT_BACKOFF_MS * (attempt + 1);
      logger.warn?.(
        {
          market: 'carrefour',
          category: category.sourceKey,
          categoryName: category.name,
          pageIndex,
          statusCode: error.statusCode,
          attempt: attempt + 1,
          retryDelayMs: delayMs,
        },
        'Transient Carrefour endpoint error; retrying category page.',
      );
      await sleep(delayMs);
    }
  }

  return null;
}

export class CarrefourAdapter implements MarketAdapter {
  readonly marketCode = 'carrefour';

  private storeContextPromise: Promise<CarrefourStoreContext> | null = null;

  private getStoreContext(logger: ScrapeLogger) {
    if (!this.storeContextPromise) {
      this.storeContextPromise = resolveStoreContext(logger);
    }

    return this.storeContextPromise;
  }

  async discoverCategories(logger: ScrapeLogger) {
    await this.getStoreContext(logger);

    const sitemapIndexXml = await fetchTextWithRetries(SITEMAP_INDEX_URL, null, logger, {
      operation: 'discoverCategories',
      stage: 'sitemap-index',
    });

    const sitemapUrls = extractXmlLocs(sitemapIndexXml).filter((url) => url.includes(CATEGORY_SITEMAP_SEGMENT));
    const categoryMap = new Map<string, ScrapedCategory>();

    for (const sitemapUrl of sitemapUrls) {
      let sitemapPayload: string;

      try {
        sitemapPayload = await fetchTextWithRetries(sitemapUrl, null, logger, {
          operation: 'discoverCategories',
          stage: 'category-sitemap',
          sitemapUrl,
        });
      } catch (error) {
        logger.warn?.(
          {
            market: this.marketCode,
            sitemapUrl,
            error,
          },
          'Failed to fetch a Carrefour category sitemap; continuing with remaining sitemap files.',
        );
        continue;
      }

      for (const categoryUrl of extractXmlLocs(sitemapPayload)) {
        const normalizedPath = normalizeCategoryPath(categoryUrl);
        if (!normalizedPath) {
          continue;
        }

        if (!categoryMap.has(normalizedPath)) {
          categoryMap.set(normalizedPath, buildCategoryFromPath(normalizedPath));
        }
      }
    }

    const categories = [...categoryMap.values()].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));

    logger.info({ market: this.marketCode, categories: categories.length }, 'Discovered Carrefour categories.');

    return categories;
  }

  async scrapeCategory(category: ScrapedCategory, logger: ScrapeLogger): Promise<ScrapedCategoryPage> {
    const storeContext = await this.getStoreContext(logger);
    const listings: NormalizedListing[] = [];
    const seenPageSignatures = new Set<string>();
    let pageIndex = START_PAGE_INDEX;

    for (;;) {
      const fetchUrl = createCategoryFetchUrl(category, pageIndex);
      const pageData = await fetchCategoryPageWithRetries(fetchUrl, storeContext, logger, category, pageIndex);

      if (!pageData || pageData.products.length === 0) {
        logger.debug?.({ market: this.marketCode, category: category.sourceKey, categoryName: category.name, pageIndex }, 'Stopping Carrefour pagination after empty page payload.');
        break;
      }

      const pageSignature = `${pageIndex}:${pageData.products.length}:${pageData.products[0]?.productId ?? 'no-first-product'}`;
      if (seenPageSignatures.has(pageSignature)) {
        logger.warn?.({ market: this.marketCode, category: category.sourceKey, categoryName: category.name, pageIndex }, 'Stopping Carrefour pagination due to repeated page signature.');
        break;
      }
      seenPageSignatures.add(pageSignature);

      logger.debug?.(
        {
          market: this.marketCode,
          category: category.sourceKey,
          categoryName: category.name,
          pageIndex,
          products: pageData.products.length,
          totalCount: pageData.totalCount,
          requestedProductsPerPage: CARREFOUR_PRODUCTS_PER_PAGE,
        },
        'Fetched Carrefour category page.',
      );

      for (const product of pageData.products) {
        for (const item of product.items) {
          const seller = selectSeller(item);

          if (!seller) {
            logger.warn?.({ market: this.marketCode, category: category.sourceKey, productId: product.productId, itemId: item.itemId }, 'Skipping Carrefour item without seller data.');
            continue;
          }

          const listing = normalizeListing(category, product, item, seller, fetchUrl);
          if (listing) {
            listings.push(listing);
          }
        }
      }

      const nextPageIndex = getPaginationIndex(pageData.pagination?.next);
      const currentPageIndex = getPaginationIndex(pageData.pagination?.current);

      if (!nextPageIndex || (currentPageIndex !== undefined && nextPageIndex <= currentPageIndex)) {
        logger.debug?.(
          {
            market: this.marketCode,
            category: category.sourceKey,
            categoryName: category.name,
            pageIndex,
            currentPageIndex,
            nextPageIndex,
          },
          'Stopping Carrefour pagination based on pagination metadata.',
        );
        break;
      }

      pageIndex = nextPageIndex;

      await sleep(PAGE_DELAY_MS);
    }

    return {
      category,
      listings,
    };
  }
}
