import { z } from 'zod';

export const NormalizedIdentifierSchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
  scope: z.enum(['global', 'market']).default('market'),
  isPrimary: z.boolean().default(false),
  isVerified: z.boolean().default(false),
});

export const NormalizedListingSchema = z.object({
  marketCode: z.string().min(1),
  sourceKey: z.string().min(1),
  sourceProductId: z.string().min(1).optional(),
  sourceItemId: z.string().min(1).optional(),
  sourceSku: z.string().min(1).optional(),
  sourceName: z.string().min(1),
  normalizedName: z.string().min(1),
  brand: z.string().min(1).optional(),
  normalizedBrand: z.string().min(1).optional(),
  identifiers: z.array(NormalizedIdentifierSchema),
  categorySourceKeys: z.array(z.string().min(1)).default([]),
  categoryPath: z.array(z.string().min(1)).default([]),
  measurementUnit: z.string().min(1).optional(),
  unitValue: z.number().positive().optional(),
  packQuantity: z.number().int().positive().optional(),
  priceCents: z.number().int().nonnegative(),
  listPriceCents: z.number().int().nonnegative().optional(),
  spotPriceCents: z.number().int().nonnegative().optional(),
  priceWithoutDiscountCents: z.number().int().nonnegative().optional(),
  unitPriceCents: z.number().int().nonnegative().optional(),
  currencyCode: z.string().length(3).default('BRL'),
  availabilityStatus: z.enum(['in_stock', 'out_of_stock', 'unknown']),
  availableQuantity: z.number().int().nonnegative().optional(),
  capturedAt: z.string().min(1),
  priceValidUntil: z.string().min(1).optional(),
  productUrl: z.string().url().optional(),
  imageUrl: z.string().url().optional(),
  fetchUrl: z.string().url(),
  parserVersion: z.string().min(1),
  rawPayload: z.unknown(),
});

export type NormalizedListing = z.infer<typeof NormalizedListingSchema>;
export type NormalizedIdentifier = z.infer<typeof NormalizedIdentifierSchema>;
