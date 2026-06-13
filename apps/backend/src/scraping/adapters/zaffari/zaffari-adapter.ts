import { NormalizedListingSchema, type NormalizedListing } from '@market-monitor/shared';
import { z } from 'zod';

import type { MarketAdapter, ScrapeLogger, ScrapedCategory, ScrapedCategoryPage } from '../base/types.js';
import { normalizeText, slugify, toMoneyCents, toPositiveNumber } from '../../pipeline/utils.js';

const CATEGORY_TREE_DEPTH = 3;
const PAGE_SIZE = 50;
const PARSER_VERSION = 'zaffari-v1';

class ZaffariRequestError extends Error {
  readonly statusCode: number;
  readonly url: string;

  constructor(url: string, statusCode: number) {
    super(`Failed request to ${url} with status ${statusCode}`);
    this.name = 'ZaffariRequestError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

const CategoryTreeNodeSchema: z.ZodType<ZaffariCategoryTreeNode> = z.lazy(() =>
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

type ZaffariCategoryTreeNode = {
  id: number;
  name: string;
  hasChildren: boolean;
  url: string;
  children: ZaffariCategoryTreeNode[];
};

type ZaffariProduct = z.infer<typeof ProductSchema>;
type ZaffariItem = z.infer<typeof ItemSchema>;
type ZaffariSeller = z.infer<typeof SellerSchema>;

function toCategorySourceKeys(categoriesIds: string[]) {
  const keys = new Set<string>();

  for (const path of categoriesIds) {
    for (const segment of path.split('/').filter(Boolean)) {
      keys.add(segment);
    }
  }

  return [...keys];
}

function selectSeller(item: ZaffariItem) {
  return item.sellers.find((seller) => seller.sellerDefault) ?? item.sellers[0] ?? null;
}

function resolveAvailabilityStatus(seller: ZaffariSeller | null) {
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

function resolveMeasurement(product: ZaffariProduct, item: ZaffariItem) {
  const productUnitValue = toPositiveNumber(firstScalar(product.Cont_liq));
  const itemUnitValue = toPositiveNumber(item.unitMultiplier);
  const productMeasurementUnit = firstScalar(product.UM_Cont);

  return {
    measurementUnit: typeof productMeasurementUnit === 'string' ? productMeasurementUnit : item.measurementUnit,
    unitValue: productUnitValue ?? itemUnitValue,
    packQuantity: itemUnitValue && Number.isInteger(itemUnitValue) ? itemUnitValue : undefined,
  };
}

function normalizeListing(product: ZaffariProduct, item: ZaffariItem, seller: ZaffariSeller, fetchUrl: string): NormalizedListing | null {
  const commercialOffer = seller.commertialOffer;
  const priceCents = toMoneyCents(commercialOffer.Price);

  if (priceCents === undefined) {
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
    marketCode: 'zaffari',
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
    availabilityStatus: resolveAvailabilityStatus(seller),
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

function flattenCategories(nodes: ZaffariCategoryTreeNode[], parentSourceKey: string | null, path: string[], depth: number): ScrapedCategory[] {
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
    throw new ZaffariRequestError(url, response.status);
  }

  const payload = await response.json();
  return schema.parse(payload) as z.infer<TSchema>;
}

export class ZaffariAdapter implements MarketAdapter {
  readonly marketCode = 'zaffari';

  async discoverCategories(logger: ScrapeLogger) {
    const url = `https://www.zaffari.com.br/api/catalog_system/pub/category/tree/${CATEGORY_TREE_DEPTH}`;
    const categoryTree = await fetchJson(url, z.array(CategoryTreeNodeSchema));
    const categories = flattenCategories(categoryTree, null, [], 1);

    logger.info({ market: this.marketCode, categories: categories.length }, 'Discovered Zaffari categories.');

    return categories;
  }

  async scrapeCategory(category: ScrapedCategory, logger: ScrapeLogger): Promise<ScrapedCategoryPage> {
    const listings: NormalizedListing[] = [];

    for (let pageIndex = 0; ; pageIndex += 1) {
      const from = pageIndex * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const fetchUrl = `https://www.zaffari.com.br/api/catalog_system/pub/products/search?fq=C:${category.sourceId}&_from=${from}&_to=${to}`;
      let pageProducts: ZaffariProduct[];

      try {
        pageProducts = await fetchJson(fetchUrl, z.array(ProductSchema));
      } catch (error) {
        if (error instanceof ZaffariRequestError && error.statusCode === 400 && pageIndex > 0) {
          logger.debug?.({ market: this.marketCode, category: category.sourceKey, pageIndex, from, to }, 'Stopping pagination after VTEX returned 400 beyond the available range.');
          break;
        }

        throw error;
      }

      logger.debug?.({ market: this.marketCode, category: category.sourceKey, pageIndex, products: pageProducts.length }, 'Fetched Zaffari category page.');

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
    }

    return {
      category,
      listings,
    };
  }
}
