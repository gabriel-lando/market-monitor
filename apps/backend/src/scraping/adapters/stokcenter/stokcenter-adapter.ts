import { randomBytes } from 'node:crypto';

import { NormalizedListingSchema, type NormalizedListing } from '@market-monitor/shared';
import { z } from 'zod';

import type { MarketAdapter, ScrapeLogger, ScrapedCategory, ScrapedCategoryPage } from '../base/types.js';
import { normalizeText, slugify, toMoneyCents, toPositiveNumber } from '../../pipeline/utils.js';

const STOKCENTER_DEFAULT_API_BASE_URL = 'https://services.vipcommerce.com.br/api-admin/v1/org/130/filial/1/centro_distribuicao/3';
const STOKCENTER_DEFAULT_API_ORG_BASE_URL = 'https://services.vipcommerce.com.br/api-admin/v1/org/130';
const STOKCENTER_DEFAULT_STOREFRONT_BASE_URL = 'https://www.stokonline.com.br';
const STOKCENTER_DEFAULT_IMAGE_BASE_URL = 'https://produto-assets-vipcommerce-com-br.br-se1.magaluobjects.com/250x250';
const STOKCENTER_DEFAULT_DOMAIN_KEY = 'stokonline.com.br';
const STOKCENTER_DEFAULT_ORGANIZATION_ID = '130';
const STOKCENTER_DEFAULT_LOGIN_USERNAME = 'loja';
const STOKCENTER_DEFAULT_LOGIN_KEY = 'df072f85df9bf7dd71b6811c34bdbaa4f219d98775b56cff9dfa5f8ca1bf8469';
const STOKCENTER_DEFAULT_PAGE_SIZE = 20;
const PAGE_DELAY_MS = 150;
const MAX_REQUEST_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;
const PARSER_VERSION = 'stokcenter-v1';

type StokCenterRequestContext = {
  apiBaseUrl: string;
  apiOrgBaseUrl: string;
  storefrontBaseUrl: string;
  imageBaseUrl: string;
  domainKey: string;
  organizationId: string;
  userAgent: string;
  loginDomain: string;
  loginUsername: string;
  loginKey: string;
  fallbackDepartmentIds: number[];
};

type StokCenterAuthState = {
  authToken: string;
  sessionId: string;
};

type StokCenterDepartment = {
  id: number;
  name: string;
  slug?: string;
};

class StokCenterRequestError extends Error {
  readonly statusCode: number;
  readonly url: string;

  constructor(url: string, statusCode: number) {
    super(`Failed request to ${url} with status ${statusCode}`);
    this.name = 'StokCenterRequestError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

const DepartmentRowSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    departamento_id: z.union([z.number(), z.string()]).optional(),
    classificacao_mercadologica_id: z.union([z.number(), z.string()]).optional(),
    nivel: z.string().optional(),
    parent_id: z.union([z.number(), z.string(), z.null()]).optional(),
    nome: z.string().optional(),
    name: z.string().optional(),
    descricao: z.string().optional(),
    label: z.string().optional(),
    slug: z.string().optional(),
    link: z.string().optional(),
  })
  .passthrough();

const FilterOptionSchema = z
  .object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    label: z.string().optional(),
    count: z.union([z.number(), z.null()]).optional(),
    checked: z.boolean().optional(),
  })
  .passthrough();

const FilterSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().optional(),
    options: z.array(FilterOptionSchema).default([]),
  })
  .passthrough();

const FiltersResponseSchema = z
  .object({
    success: z.boolean(),
    data: z.array(FilterSchema).default([]),
  })
  .passthrough();

const OfferSchema = z
  .object({
    preco_antigo: z.union([z.string(), z.number()]).optional().nullable(),
    preco_oferta: z.union([z.string(), z.number()]).optional().nullable(),
  })
  .passthrough();

const ProductSchema = z
  .object({
    produto_id: z.coerce.number().int().positive(),
    id: z.union([z.string(), z.number()]).optional().nullable(),
    classificacao_mercadologica_id: z.union([z.number(), z.string()]).optional().nullable(),
    descricao: z.string().min(1),
    imagem: z.string().optional().nullable(),
    disponivel: z.boolean().optional(),
    preco: z.union([z.string(), z.number()]).optional().nullable(),
    quantidade_maxima: z.union([z.string(), z.number()]).optional().nullable(),
    em_oferta: z.boolean().optional(),
    oferta: OfferSchema.optional().nullable(),
    preco_original: z.union([z.string(), z.number()]).optional().nullable(),
    unidade_sigla: z.string().optional().nullable(),
    quantidade_unidade_diferente: z.union([z.string(), z.number()]).optional().nullable(),
    possui_unidade_diferente: z.boolean().optional(),
    marca: z.string().optional().nullable(),
    secao_id: z.union([z.number(), z.string()]).optional().nullable(),
    link: z.string().optional().nullable(),
    codigo_barras: z.string().optional().nullable(),
    sku: z.string().optional().nullable(),
    codigo_erp: z.union([z.number(), z.string()]).optional().nullable(),
  })
  .passthrough();

type StokCenterProduct = z.infer<typeof ProductSchema>;

const PaginatorSchema = z
  .object({
    page: z.coerce.number().int().positive(),
    items_per_page: z.coerce.number().int().positive().optional(),
    total_pages: z.coerce.number().int().positive().optional(),
    total_items: z.coerce.number().int().nonnegative().optional(),
  })
  .passthrough();

const ProductsResponseSchema = z
  .object({
    success: z.boolean(),
    data: z.array(ProductSchema).default([]),
    paginator: PaginatorSchema.optional(),
    isRedirect: z.boolean().optional(),
  })
  .passthrough();

const LoginResponseSchema = z
  .object({
    success: z.boolean(),
    data: z.string().min(1),
  })
  .passthrough();

function sanitizeString(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, '');
}

function toNonNegativeNumber(value: unknown) {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }

    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(',', '.');
    if (normalized.length === 0) {
      return undefined;
    }

    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return undefined;
    }

    return parsed;
  }

  return undefined;
}

function toNonNegativeInt(value: unknown) {
  const numeric = toNonNegativeNumber(value);

  if (numeric === undefined) {
    return undefined;
  }

  return Math.floor(numeric);
}

function toPositiveInt(value: unknown) {
  const numeric = toNonNegativeInt(value);

  if (numeric === undefined || numeric <= 0) {
    return undefined;
  }

  return numeric;
}

function getRequestContext(): StokCenterRequestContext {
  return {
    apiBaseUrl: normalizeBaseUrl(STOKCENTER_DEFAULT_API_BASE_URL),
    apiOrgBaseUrl: normalizeBaseUrl(STOKCENTER_DEFAULT_API_ORG_BASE_URL),
    storefrontBaseUrl: normalizeBaseUrl(STOKCENTER_DEFAULT_STOREFRONT_BASE_URL),
    imageBaseUrl: normalizeBaseUrl(STOKCENTER_DEFAULT_IMAGE_BASE_URL),
    domainKey: STOKCENTER_DEFAULT_DOMAIN_KEY,
    organizationId: STOKCENTER_DEFAULT_ORGANIZATION_ID,
    userAgent: 'market-monitor/0.1.0 (+https://www.stokonline.com.br)',
    loginDomain: STOKCENTER_DEFAULT_DOMAIN_KEY,
    loginUsername: STOKCENTER_DEFAULT_LOGIN_USERNAME,
    loginKey: STOKCENTER_DEFAULT_LOGIN_KEY,
    fallbackDepartmentIds: [11],
  };
}

function buildBaseHeaders(context: StokCenterRequestContext) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    domainkey: context.domainKey,
    organizationid: context.organizationId,
    origin: context.storefrontBaseUrl,
    referer: `${context.storefrontBaseUrl}/`,
    'user-agent': context.userAgent,
  };
}

function buildLoginHeaders(context: StokCenterRequestContext) {
  return {
    ...buildBaseHeaders(context),
    authorization: 'Bearer',
    'sessao-id': '',
  };
}

function buildAuthHeaders(context: StokCenterRequestContext, authState: StokCenterAuthState) {
  return {
    ...buildBaseHeaders(context),
    authorization: `Bearer ${authState.authToken}`,
    'sessao-id': authState.sessionId,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(statusCode: number) {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

async function fetchJson<TSchema extends z.ZodTypeAny>(url: string, schema: TSchema, headers: Record<string, string>): Promise<z.infer<TSchema>> {
  const response = await fetch(url, {
    headers,
  });

  if (!response.ok) {
    throw new StokCenterRequestError(url, response.status);
  }

  const payload = await response.json();
  return schema.parse(payload) as z.infer<TSchema>;
}

async function fetchJsonWithRetries<TSchema extends z.ZodTypeAny>(
  url: string,
  schema: TSchema,
  headers: Record<string, string>,
  logger: ScrapeLogger,
  logContext: Record<string, unknown>,
): Promise<z.infer<TSchema>> {
  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    try {
      return await fetchJson(url, schema, headers);
    } catch (error) {
      if (!(error instanceof StokCenterRequestError)) {
        throw error;
      }

      if (!isRetryableStatus(error.statusCode)) {
        throw error;
      }

      const exhausted = attempt === MAX_REQUEST_RETRIES;
      if (exhausted) {
        throw error;
      }

      const delayMs = RETRY_BACKOFF_MS * (attempt + 1);
      logger.warn?.(
        {
          ...logContext,
          statusCode: error.statusCode,
          attempt: attempt + 1,
          retry_delay_ms: delayMs,
        },
        'Transient Stok Center endpoint error; retrying request.',
      );
      await sleep(delayMs);
    }
  }

  throw new Error('Unexpected Stok Center retry loop termination.');
}

function createSessionId() {
  return randomBytes(16).toString('hex');
}

async function bootstrapAnonymousAuth(context: StokCenterRequestContext, logger: ScrapeLogger): Promise<StokCenterAuthState> {
  const loginUrl = `${context.apiOrgBaseUrl}/auth/loja/login`;
  const loginBody = JSON.stringify({
    domain: context.loginDomain,
    username: context.loginUsername,
    key: context.loginKey,
  });

  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(loginUrl, {
        method: 'POST',
        headers: buildLoginHeaders(context),
        body: loginBody,
      });

      if (!response.ok) {
        throw new StokCenterRequestError(loginUrl, response.status);
      }

      const payload = LoginResponseSchema.parse(await response.json());

      if (!payload.success) {
        throw new Error('Stok Center login bootstrap returned success=false.');
      }

      const token = sanitizeString(payload.data);
      if (!token) {
        throw new Error('Stok Center login bootstrap did not return a token.');
      }

      const authState = {
        authToken: token,
        sessionId: createSessionId(),
      };

      logger.info({ market: 'stokcenter' }, 'Bootstrapped Stok Center anonymous auth token.');
      return authState;
    } catch (error) {
      if (!(error instanceof StokCenterRequestError) || !isRetryableStatus(error.statusCode) || attempt === MAX_REQUEST_RETRIES) {
        throw error;
      }

      const delayMs = RETRY_BACKOFF_MS * (attempt + 1);
      logger.warn?.(
        {
          market: 'stokcenter',
          operation: 'auth_bootstrap',
          statusCode: error.statusCode,
          attempt: attempt + 1,
          retry_delay_ms: delayMs,
        },
        'Transient Stok Center auth bootstrap error; retrying login request.',
      );
      await sleep(delayMs);
    }
  }

  throw new Error('Unexpected Stok Center auth bootstrap retry loop termination.');
}

function extractDepartmentRows(payload: unknown) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const payloadRecord = payload as Record<string, unknown>;

  if (Array.isArray(payloadRecord.data)) {
    return payloadRecord.data;
  }

  if (Array.isArray(payloadRecord.departamentos)) {
    return payloadRecord.departamentos;
  }

  return [];
}

function deriveDepartmentSlug(candidate: unknown) {
  const directSlug = sanitizeString(candidate);
  if (!directSlug) {
    return undefined;
  }

  if (!directSlug.includes('/')) {
    return slugify(directSlug);
  }

  const parts = directSlug.split('/').filter(Boolean);
  return parts.length > 0 ? slugify(parts[parts.length - 1]) : undefined;
}

function mapDepartments(rows: unknown[]) {
  const byId = new Map<number, StokCenterDepartment>();

  for (const row of rows) {
    const parsed = DepartmentRowSchema.safeParse(row);
    if (!parsed.success) {
      continue;
    }

    const id = toPositiveInt(parsed.data.departamento_id ?? parsed.data.id ?? parsed.data.classificacao_mercadologica_id);
    if (!id) {
      continue;
    }

    const level = sanitizeString(parsed.data.nivel);
    const parentId = toPositiveInt(parsed.data.parent_id);
    const isTopLevelDepartment = level ? normalizeText(level) === 'departamento' : parentId === undefined;
    if (!isTopLevelDepartment) {
      continue;
    }

    const name =
      sanitizeString(parsed.data.nome) ??
      sanitizeString(parsed.data.name) ??
      sanitizeString(parsed.data.descricao) ??
      sanitizeString(parsed.data.label) ??
      `Departamento ${id}`;

    const slug = deriveDepartmentSlug(parsed.data.slug ?? parsed.data.link);

    byId.set(id, {
      id,
      name,
      slug,
    });
  }

  return [...byId.values()].sort((left, right) => left.id - right.id);
}

async function discoverDepartments(
  context: StokCenterRequestContext,
  authState: StokCenterAuthState,
  logger: ScrapeLogger,
): Promise<StokCenterDepartment[]> {
  const headers = buildAuthHeaders(context, authState);
  const endpoints = [
    `${context.apiBaseUrl}/loja/classificacoes_mercadologicas/departamentos`,
    `${context.apiBaseUrl}/classificacoes_mercadologicas/departamentos`,
    `${context.apiBaseUrl}/loja/classificacoes_mercadologicas/departamentos/arvore`,
  ];

  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJsonWithRetries(endpoint, z.unknown(), headers, logger, {
        market: 'stokcenter',
        operation: 'discover_departments',
      });
      const departments = mapDepartments(extractDepartmentRows(payload));

      if (departments.length > 0) {
        logger.info({ market: 'stokcenter', departments: departments.length, endpoint }, 'Discovered Stok Center departments from API endpoint.');
        return departments;
      }
    } catch (error) {
      logger.warn?.(
        {
          market: 'stokcenter',
          endpoint,
          error,
        },
        'Failed to fetch Stok Center department list endpoint; trying fallback strategy.',
      );
    }
  }

  return context.fallbackDepartmentIds.map((id) => ({
    id,
    name: `Departamento ${id}`,
  }));
}

async function fetchDepartmentFilters(
  departmentId: number,
  context: StokCenterRequestContext,
  authState: StokCenterAuthState,
  logger: ScrapeLogger,
) {
  const url = `${context.apiBaseUrl}/loja/classificacoes_mercadologicas/departamentos/${departmentId}/produtos/filtros`;
  const response = await fetchJsonWithRetries(url, FiltersResponseSchema, buildAuthHeaders(context, authState), logger, {
    market: 'stokcenter',
    operation: 'department_filters',
    departmentId,
  });

  if (!response.success) {
    throw new Error(`Stok Center filtros endpoint returned success=false for department ${departmentId}.`);
  }

  return response.data;
}

function buildProductUrl(product: StokCenterProduct, context: StokCenterRequestContext) {
  const productSlug = sanitizeString(product.link);

  if (!productSlug) {
    return undefined;
  }

  if (productSlug.startsWith('http://') || productSlug.startsWith('https://')) {
    return productSlug;
  }

  return `${context.storefrontBaseUrl}/produto/${product.produto_id}/${productSlug}`;
}

function buildImageUrl(imageName: string | null | undefined, context: StokCenterRequestContext) {
  const normalizedName = sanitizeString(imageName);

  if (!normalizedName) {
    return undefined;
  }

  if (normalizedName.startsWith('http://') || normalizedName.startsWith('https://')) {
    return normalizedName;
  }

  return `${context.imageBaseUrl}/${normalizedName.replace(/^\/+/, '')}`;
}

function buildIdentifiers(product: StokCenterProduct) {
  const identifiers = [
    sanitizeString(product.codigo_barras)
      ? {
          type: 'ean',
          value: sanitizeString(product.codigo_barras) as string,
          scope: 'global' as const,
          isPrimary: true,
          isVerified: true,
        }
      : null,
    sanitizeString(product.sku)
      ? {
          type: 'sku',
          value: sanitizeString(product.sku) as string,
          scope: 'market' as const,
          isPrimary: false,
          isVerified: true,
        }
      : null,
    toPositiveInt(product.codigo_erp)
      ? {
          type: 'erp_id',
          value: String(toPositiveInt(product.codigo_erp)),
          scope: 'market' as const,
          isPrimary: false,
          isVerified: true,
        }
      : null,
    sanitizeString(product.id != null ? String(product.id) : undefined)
      ? {
          type: 'listing_id',
          value: sanitizeString(product.id != null ? String(product.id) : undefined) as string,
          scope: 'market' as const,
          isPrimary: false,
          isVerified: true,
        }
      : null,
    {
      type: 'product_id',
      value: String(product.produto_id),
      scope: 'market' as const,
      isPrimary: false,
      isVerified: true,
    },
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (identifiers.length > 0 && !identifiers.some((identifier) => identifier.isPrimary)) {
    identifiers[0].isPrimary = true;
  }

  return identifiers;
}

function resolveDepartmentNameFromFilters(departmentId: number, filters: z.infer<typeof FilterSchema>[]) {
  const departmentFilter = filters.find((filter) => filter.name === 'departamento');
  if (!departmentFilter) {
    return undefined;
  }

  const selectedOption =
    departmentFilter.options.find((option) => option.checked) ??
    departmentFilter.options.find((option) => toPositiveInt(option.value) === departmentId) ??
    departmentFilter.options[0];

  return sanitizeString(selectedOption?.label);
}

function resolveSectionCategories(filters: z.infer<typeof FilterSchema>[]) {
  const sectionFilter = filters.find((filter) => filter.name === 'secao');
  if (!sectionFilter) {
    return [];
  }

  return sectionFilter.options
    .map((option) => {
      const sectionId = toPositiveInt(option.value);
      const sectionName = sanitizeString(option.label);

      if (!sectionId || !sectionName) {
        return null;
      }

      return {
        id: sectionId,
        name: sectionName,
      };
    })
    .filter((section): section is NonNullable<typeof section> => Boolean(section));
}

export class StokCenterAdapter implements MarketAdapter {
  readonly marketCode = 'stokcenter';

  private context: StokCenterRequestContext | null = null;
  private authStatePromise: Promise<StokCenterAuthState> | null = null;
  private sectionNameById = new Map<number, string>();

  private getContext() {
    if (!this.context) {
      this.context = getRequestContext();
    }

    return this.context;
  }

  private getAuthState(logger: ScrapeLogger) {
    const context = this.getContext();

    if (!this.authStatePromise) {
      this.authStatePromise = bootstrapAnonymousAuth(context, logger);
    }

    return this.authStatePromise;
  }

  private normalizeListing(category: ScrapedCategory, product: StokCenterProduct, fetchUrl: string): NormalizedListing | null {
    const context = this.getContext();
    const availabilityStatus = product.disponivel === false ? ('out_of_stock' as const) : ('in_stock' as const);

    if (availabilityStatus === 'out_of_stock') {
      return null;
    }

    const sourceName = product.descricao.trim();
    const normalizedName = normalizeText(sourceName);

    if (normalizedName.length === 0) {
      return null;
    }

    const basePriceCents = toMoneyCents(toNonNegativeNumber(product.preco));
    const offerPriceCents = toMoneyCents(toNonNegativeNumber(product.oferta?.preco_oferta));
    const effectivePriceCents = offerPriceCents ?? basePriceCents;

    if (effectivePriceCents === undefined || effectivePriceCents <= 0) {
      return null;
    }

    const oldPriceCents = toMoneyCents(toNonNegativeNumber(product.oferta?.preco_antigo ?? product.preco_original));
    const listPriceCents = oldPriceCents && oldPriceCents > effectivePriceCents ? oldPriceCents : undefined;

    const sourceItemId = sanitizeString(product.id != null ? String(product.id) : undefined);
    const sourceProductId = String(product.produto_id);
    const sourceKey = sourceItemId ?? sourceProductId;

    const brand = sanitizeString(product.marca);
    const normalizedBrand = brand ? normalizeText(brand) : undefined;

    const sectionId = toPositiveInt(product.secao_id ?? product.classificacao_mercadologica_id);
    const categorySourceKeys = [category.sourceKey];

    if (sectionId) {
      categorySourceKeys.push(`secao:${sectionId}`);
    }

    const categoryPath = [...category.path];

    const sectionName = sectionId ? this.sectionNameById.get(sectionId) : undefined;
    if (sectionName && !categoryPath.includes(sectionName)) {
      categoryPath.push(sectionName);
    }

    const unitValue = toPositiveNumber(product.quantidade_unidade_diferente);
    const hasDifferentUnit = product.possui_unidade_diferente === true;

    const measurementUnit = sanitizeString(product.unidade_sigla);
    const packQuantity = !hasDifferentUnit && unitValue && Number.isInteger(unitValue) ? unitValue : undefined;

    return NormalizedListingSchema.parse({
      marketCode: this.marketCode,
      sourceKey,
      sourceProductId,
      sourceItemId,
      sourceSku: sanitizeString(product.sku),
      sourceName,
      normalizedName,
      brand,
      normalizedBrand,
      identifiers: buildIdentifiers(product),
      categorySourceKeys,
      categoryPath,
      measurementUnit,
      unitValue,
      packQuantity,
      priceCents: effectivePriceCents,
      listPriceCents,
      spotPriceCents: offerPriceCents,
      priceWithoutDiscountCents: listPriceCents,
      currencyCode: 'BRL',
      availabilityStatus,
      availableQuantity: toNonNegativeInt(product.quantidade_maxima),
      capturedAt: new Date().toISOString(),
      productUrl: buildProductUrl(product, context),
      imageUrl: buildImageUrl(product.imagem, context),
      fetchUrl,
      parserVersion: PARSER_VERSION,
      rawPayload: {
        product,
      },
    });
  }

  async discoverCategories(logger: ScrapeLogger) {
    const context = this.getContext();
    const authState = await this.getAuthState(logger);
    this.sectionNameById = new Map<number, string>();

    const departments = await discoverDepartments(context, authState, logger);
    const categories: ScrapedCategory[] = [];

    for (const department of departments) {
      let departmentName = department.name;
      let departmentSlug = department.slug ? slugify(department.slug) : slugify(departmentName);
      let sections: Array<{ id: number; name: string }> = [];

      try {
        const filters = await fetchDepartmentFilters(department.id, context, authState, logger);
        const nameFromFilters = resolveDepartmentNameFromFilters(department.id, filters);

        if (nameFromFilters) {
          departmentName = nameFromFilters;
          departmentSlug = slugify(departmentName);
        }

        sections = resolveSectionCategories(filters);
      } catch (error) {
        logger.warn?.(
          {
            market: this.marketCode,
            departmentId: department.id,
            error,
          },
          'Failed to fetch Stok Center department filters; category will be scraped without section metadata.',
        );
      }

      const departmentSourceKey = `departamento:${department.id}`;
      const departmentPath = [departmentName];
      const departmentCategory: ScrapedCategory = {
        sourceKey: departmentSourceKey,
        sourceId: String(department.id),
        name: departmentName,
        slug: departmentSlug,
        url: `${context.storefrontBaseUrl}/departamentos/${departmentSlug}`,
        depth: 1,
        path: departmentPath,
        parentSourceKey: null,
        isLeaf: sections.length === 0,
      };

      categories.push(departmentCategory);

      for (const section of sections) {
        this.sectionNameById.set(section.id, section.name);

        categories.push({
          sourceKey: `secao:${section.id}`,
          sourceId: String(section.id),
          name: section.name,
          slug: slugify(section.name),
          url: `${context.storefrontBaseUrl}/departamentos/${departmentSlug}?secao=${section.id}`,
          depth: 2,
          path: [...departmentPath, section.name],
          parentSourceKey: departmentSourceKey,
          isLeaf: true,
        });
      }
    }

    logger.info({ market: this.marketCode, categories: categories.length, departments: departments.length }, 'Discovered Stok Center categories.');

    return categories;
  }

  async scrapeCategory(category: ScrapedCategory, logger: ScrapeLogger): Promise<ScrapedCategoryPage> {
    const context = this.getContext();
    const authState = await this.getAuthState(logger);
    const headers = buildAuthHeaders(context, authState);
    const departmentId = toPositiveInt(category.sourceId);

    if (!departmentId) {
      throw new Error(`Invalid Stok Center department id for category ${category.sourceKey}.`);
    }

    const listings: NormalizedListing[] = [];
    const seenPageSignatures = new Set<string>();

    for (let page = 1; ; page += 1) {
      const fetchUrl = `${context.apiBaseUrl}/loja/classificacoes_mercadologicas/departamentos/${departmentId}/produtos?page=${page}`;
      let response: z.infer<typeof ProductsResponseSchema>;

      try {
        response = await fetchJsonWithRetries(fetchUrl, ProductsResponseSchema, headers, logger, {
          market: this.marketCode,
          operation: 'products_page',
          departmentId,
          page,
        });
      } catch (error) {
        if (error instanceof StokCenterRequestError && (error.statusCode === 400 || error.statusCode === 404) && page > 1) {
          logger.debug?.(
            {
              market: this.marketCode,
              category: category.sourceKey,
              categoryName: category.name,
              departmentId,
              page,
              statusCode: error.statusCode,
            },
            'Stopping Stok Center pagination after boundary response.',
          );
          break;
        }

        throw error;
      }

      if (!response.success) {
        throw new Error(`Stok Center products endpoint returned success=false for department ${departmentId} page ${page}.`);
      }

      if (response.isRedirect) {
        logger.warn?.(
          {
            market: this.marketCode,
            category: category.sourceKey,
            categoryName: category.name,
            departmentId,
            page,
          },
          'Stopping Stok Center pagination because endpoint returned redirect signal.',
        );
        break;
      }

      const products = response.data;

      if (products.length === 0) {
        logger.debug?.(
          {
            market: this.marketCode,
            category: category.sourceKey,
            categoryName: category.name,
            departmentId,
            page,
          },
          'Stopping Stok Center pagination after empty page payload.',
        );
        break;
      }

      const pageSignature = `${page}:${products.length}:${products[0]?.id ?? products[0]?.produto_id ?? 'no-first-product'}`;
      if (seenPageSignatures.has(pageSignature)) {
        logger.warn?.(
          {
            market: this.marketCode,
            category: category.sourceKey,
            categoryName: category.name,
            departmentId,
            page,
          },
          'Stopping Stok Center pagination due to repeated page signature.',
        );
        break;
      }
      seenPageSignatures.add(pageSignature);

      logger.debug?.(
        {
          market: this.marketCode,
          category: category.sourceKey,
          categoryName: category.name,
          departmentId,
          page,
          products: products.length,
          paginator: response.paginator,
        },
        'Fetched Stok Center category page.',
      );

      for (const product of products) {
        const listing = this.normalizeListing(category, product, fetchUrl);

        if (listing) {
          listings.push(listing);
        }
      }

      const totalPages = response.paginator?.total_pages;
      if (totalPages && page >= totalPages) {
        break;
      }

      const pageSize = response.paginator?.items_per_page ?? STOKCENTER_DEFAULT_PAGE_SIZE;
      if (products.length < pageSize) {
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

