import { NormalizedListingSchema, type NormalizedListing } from '@market-monitor/shared';
import { z } from 'zod';

import type { MarketAdapter, ScrapeLogger, ScrapedCategory, ScrapedCategoryPage } from '../base/types.js';
import { normalizeText, slugify, toMoneyCents, toPositiveNumber } from '../../pipeline/utils.js';

const CATEGORY_TREE_DEPTH = 3;
const PAGE_SIZE = 50;
const PAGE_DELAY_MS = 150;
const MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 1200;
const PARSER_VERSION = 'atacadao-v1';
const ATACADAO_SALES_CHANNEL = '2';

class AtacadaoRequestError extends Error {
  readonly statusCode: number;
  readonly url: string;

  constructor(url: string, statusCode: number) {
    super(`Failed request to ${url} with status ${statusCode}`);
    this.name = 'AtacadaoRequestError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

const CategoryTreeNodeSchema: z.ZodType<AtacadaoCategoryTreeNode> = z.lazy(() =>
  z.object({
    id: z.coerce.number(),
    name: z.string().min(1),
    hasChildren: z.boolean(),
    url: z.string().url(),
    children: z.array(CategoryTreeNodeSchema),
  }),
);

const CommercialOfferSchema = z
  .object({
    Price: z.number().optional(),
    ListPrice: z.number().optional(),
    PriceWithoutDiscount: z.number().optional(),
    SpotPrice: z.number().optional(),
    AvailableQuantity: z.number().optional(),
    IsAvailable: z.boolean().optional(),
    PriceValidUntil: z.string().nullable().optional(),
  })
  .passthrough();

const SellerSchema = z
  .object({
    sellerId: z.string().min(1),
    sellerName: z.string().min(1),
    sellerDefault: z.boolean().optional(),
    commertialOffer: CommercialOfferSchema,
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
    productName: z.string().min(1),
    brand: z.string().optional(),
    link: z.string().url().optional(),
    productReference: z.string().optional(),
    productReferenceCode: z.string().optional(),
    categories: z.array(z.string()).default([]),
    categoriesIds: z.array(z.string()).default([]),
    Cont_liq: z.unknown().optional(),
    UM_Cont: z.unknown().optional(),
    items: z.array(ItemSchema).default([]),
  })
  .passthrough();

type AtacadaoCategoryTreeNode = {
  id: number;
  name: string;
  hasChildren: boolean;
  url: string;
  children: AtacadaoCategoryTreeNode[];
};

type AtacadaoProduct = z.infer<typeof ProductSchema>;
type AtacadaoItem = z.infer<typeof ItemSchema>;
type AtacadaoSeller = z.infer<typeof SellerSchema>;

function toCategorySourceKeys(categoriesIds: string[]) {
  const keys = new Set<string>();

  for (const path of categoriesIds) {
    for (const segment of path.split('/').filter(Boolean)) {
      keys.add(segment);
    }
  }

  return [...keys];
}

function selectSeller(item: AtacadaoItem) {
  return item.sellers.find((seller) => seller.sellerDefault) ?? item.sellers[0] ?? null;
}

function resolveAvailabilityStatus(seller: AtacadaoSeller | null) {
  if (!seller?.commertialOffer) {
    return 'unknown' as const;
  }

  return seller.commertialOffer.IsAvailable === false ? 'out_of_stock' : 'in_stock';
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

function resolveMeasurement(product: AtacadaoProduct, item: AtacadaoItem) {
  const productUnitValue = toPositiveNumber(firstScalar(product.Cont_liq));
  const itemUnitValue = toPositiveNumber(item.unitMultiplier);
  const productMeasurementUnit = firstScalar(product.UM_Cont);

  return {
    measurementUnit: typeof productMeasurementUnit === 'string' ? productMeasurementUnit : item.measurementUnit,
    unitValue: productUnitValue ?? itemUnitValue,
    packQuantity: itemUnitValue && Number.isInteger(itemUnitValue) ? itemUnitValue : undefined,
  };
}

function normalizeListing(product: AtacadaoProduct, item: AtacadaoItem, seller: AtacadaoSeller, fetchUrl: string): NormalizedListing | null {
  const commercialOffer = seller.commertialOffer;
  const priceCents = toMoneyCents(commercialOffer.Price);
  const availabilityStatus = resolveAvailabilityStatus(seller);

  if (priceCents === undefined || priceCents <= 0 || availabilityStatus === 'out_of_stock') {
    return null;
  }

  const { measurementUnit, unitValue, packQuantity } = resolveMeasurement(product, item);
  const sourceName = item.name ?? product.productName;
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
    marketCode: 'atacadao',
    sourceKey: item.itemId || product.productId,
    sourceProductId: product.productId,
    sourceItemId: item.itemId,
    sourceSku: product.productReferenceCode ?? product.productReference,
    sourceName,
    normalizedName,
    brand,
    normalizedBrand,
    identifiers,
    categorySourceKeys: toCategorySourceKeys(product.categoriesIds),
    categoryPath: product.categories.map((categoryPath) => categoryPath.split('/').filter(Boolean).join(' > ')),
    measurementUnit,
    unitValue,
    packQuantity,
    priceCents,
    listPriceCents: toMoneyCents(commercialOffer.ListPrice),
    spotPriceCents: toMoneyCents(commercialOffer.SpotPrice),
    priceWithoutDiscountCents: toMoneyCents(commercialOffer.PriceWithoutDiscount),
    currencyCode: 'BRL',
    availabilityStatus,
    availableQuantity: commercialOffer.AvailableQuantity,
    capturedAt: new Date().toISOString(),
    priceValidUntil: commercialOffer.PriceValidUntil ?? undefined,
    productUrl: product.link,
    imageUrl: item.images[0]?.imageUrl,
    fetchUrl,
    parserVersion: PARSER_VERSION,
    rawPayload: {
      product,
      item,
      seller,
    },
  });
}

function flattenCategories(nodes: AtacadaoCategoryTreeNode[], parentSourceKey: string | null, path: string[], depth: number): ScrapedCategory[] {
  return nodes.flatMap((node) => {
    const categoryPath = [...path, node.name];
    const category: ScrapedCategory = {
      sourceKey: String(node.id),
      sourceId: String(node.id),
      name: node.name,
      slug: slugify(node.name),
      url: node.url,
      depth,
      path: categoryPath,
      parentSourceKey,
      isLeaf: !node.hasChildren || node.children.length === 0,
    };

    return [category, ...flattenCategories(node.children, category.sourceKey, categoryPath, depth + 1)];
  });
}

async function fetchJson<TSchema extends z.ZodTypeAny>(url: string, schema: TSchema): Promise<z.infer<TSchema>> {
  const response = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'user-agent': 'market-monitor/0.1.0',
    },
  });

  if (!response.ok) {
    throw new AtacadaoRequestError(url, response.status);
  }

  const payload = await response.json();
  return schema.parse(payload) as z.infer<TSchema>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCategoryPageWithRetries(fetchUrl: string, logger: ScrapeLogger, category: ScrapedCategory, pageIndex: number, from: number, to: number) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await fetchJson(fetchUrl, z.array(ProductSchema));
    } catch (error) {
      if (!(error instanceof AtacadaoRequestError)) {
        throw error;
      }

      const isRetryable = error.statusCode === 429 || error.statusCode >= 500;
      if (!isRetryable) {
        throw error;
      }

      const exhausted = attempt === MAX_RATE_LIMIT_RETRIES;
      if (exhausted) {
        logger.warn?.(
          {
            market: 'atacadao',
            category: category.sourceKey,
            pageIndex,
            from,
            to,
            statusCode: error.statusCode,
            attempts: attempt + 1,
          },
          'Endpoint error persisted after retries; skipping the remaining pages of this category.',
        );
        return null;
      }

      const delayMs = RATE_LIMIT_BACKOFF_MS * (attempt + 1);
      logger.warn?.(
        {
          market: 'atacadao',
          category: category.sourceKey,
          pageIndex,
          from,
          to,
          statusCode: error.statusCode,
          attempt: attempt + 1,
          retry_delay_ms: delayMs,
        },
        'Transient VTEX endpoint error; retrying category page.',
      );
      await sleep(delayMs);
    }
  }

  return null;
}

export class AtacadaoAdapter implements MarketAdapter {
  readonly marketCode = 'atacadao';

  async discoverCategories(logger: ScrapeLogger) {
    const url = `https://www.atacadao.com.br/api/catalog_system/pub/category/tree/${CATEGORY_TREE_DEPTH}`;
    const categoryTree = await fetchJson(url, z.array(CategoryTreeNodeSchema));
    const categories = flattenCategories(categoryTree, null, [], 1);

    logger.info({ market: this.marketCode, categories: categories.length }, 'Discovered Atacadao categories.');

    return categories;
  }

  async scrapeCategory(category: ScrapedCategory, logger: ScrapeLogger): Promise<ScrapedCategoryPage> {
    const listings: NormalizedListing[] = [];

    for (let pageIndex = 0; ; pageIndex += 1) {
      const from = pageIndex * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const fetchUrl = `https://www.atacadao.com.br/api/catalog_system/pub/products/search?fq=C:${category.sourceId}&_from=${from}&_to=${to}&sc=${ATACADAO_SALES_CHANNEL}`;
      let pageProducts: AtacadaoProduct[] | null;

      try {
        pageProducts = await fetchCategoryPageWithRetries(fetchUrl, logger, category, pageIndex, from, to);
      } catch (error) {
        if (error instanceof AtacadaoRequestError && error.statusCode === 400 && pageIndex > 0) {
          logger.debug?.({ market: this.marketCode, category: category.sourceKey, pageIndex, from, to }, 'Stopping pagination after VTEX returned 400 beyond the available range.');
          break;
        }

        throw error;
      }

      if (!pageProducts) {
        break;
      }

      logger.debug?.({ market: this.marketCode, category: category.sourceKey, pageIndex, products: pageProducts.length }, 'Fetched Atacadao category page.');

      for (const product of pageProducts) {
        for (const item of product.items) {
          const seller = selectSeller(item);

          if (!seller) {
            logger.warn?.({ market: this.marketCode, category: category.sourceKey, productId: product.productId, itemId: item.itemId }, 'Skipping item without seller data.');
            continue;
          }

          const listing = normalizeListing(product, item, seller, fetchUrl);
          if (listing) {
            listings.push(listing);
          }
        }
      }

      if (pageProducts.length < PAGE_SIZE) {
        break;
      }

      await sleep(PAGE_DELAY_MS);
    }

    return {
      category,
      listings,
    };
  }
}
