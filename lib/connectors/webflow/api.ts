/**
 * Webflow Data API v2, the subset publishing needs: list sites, list
 * collections and their fields, create / update / publish / delete items.
 * Site API tokens (Site settings → Apps & integrations → API access) with
 * `cms:read` and `cms:write`. Rate limit is 60 requests a minute; a 429 is
 * retried once after the `Retry-After` the API asks for.
 */

export const WEBFLOW_API_BASE = "https://api.webflow.com/v2";

export class WebflowApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
    public readonly code?: string,
  ) {
    super(`webflow ${path}: ${message}`);
    this.name = "WebflowApiError";
  }
}

export interface WebflowSite {
  id: string;
  displayName: string;
  shortName: string;
  previewUrl?: string | null;
  customDomains: string[];
}

export interface WebflowCollection {
  id: string;
  displayName: string;
  slug: string;
}

export interface WebflowField {
  id: string;
  slug: string;
  displayName: string;
  type: string;
  isRequired: boolean;
  isEditable: boolean;
}

export interface WebflowCollectionDetail extends WebflowCollection {
  fields: WebflowField[];
}

export interface WebflowItemInput {
  fieldData: Record<string, unknown>;
  isDraft?: boolean;
  isArchived?: boolean;
}

export interface WebflowItem {
  id: string;
  isDraft: boolean;
  isArchived: boolean;
  createdOn?: string | null;
  lastUpdated?: string | null;
  lastPublished?: string | null;
  fieldData: Record<string, unknown>;
}

export interface WebflowItemPage {
  items: WebflowItem[];
  total: number;
  offset: number;
  limit: number;
}

/** Webflow's maximum page size for collection items. */
export const WEBFLOW_ITEMS_PAGE = 100;
/** Hard ceiling per collection per sync; a blog with more posts than this is paged over several nights by offset. */
export const WEBFLOW_MAX_ITEMS = 5000;

export class WebflowApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base: string = WEBFLOW_API_BASE,
  ) {}

  private async call<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(10_000, Number(res.headers.get("retry-after") ?? "2") * 1000 || 2000);
      await new Promise((r) => setTimeout(r, wait));
      return this.call<T>(path, init, 1);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const o = (json ?? {}) as { message?: string; code?: string; details?: unknown };
      const detail = o.details ? ` ${JSON.stringify(o.details).slice(0, 300)}` : "";
      throw new WebflowApiError(res.status, path, `${o.message ?? text.slice(0, 200) ?? `status ${res.status}`}${detail}`, o.code);
    }
    return json as T;
  }

  async sites(): Promise<WebflowSite[]> {
    const json = await this.call<{ sites?: Record<string, unknown>[] }>("/sites");
    return (json.sites ?? []).map((s) => ({
      id: String(s.id),
      displayName: String(s.displayName ?? s.shortName ?? s.id),
      shortName: String(s.shortName ?? ""),
      previewUrl: typeof s.previewUrl === "string" ? s.previewUrl : null,
      customDomains: Array.isArray(s.customDomains) ? s.customDomains.map((d) => String((d as { url?: string }).url ?? d)) : [],
    }));
  }

  async collections(siteId: string): Promise<WebflowCollection[]> {
    const json = await this.call<{ collections?: Record<string, unknown>[] }>(`/sites/${siteId}/collections`);
    return (json.collections ?? []).map((c) => ({ id: String(c.id), displayName: String(c.displayName ?? c.slug ?? c.id), slug: String(c.slug ?? "") }));
  }

  async collection(collectionId: string): Promise<WebflowCollectionDetail> {
    const c = await this.call<Record<string, unknown>>(`/collections/${collectionId}`);
    const fields = Array.isArray(c.fields) ? (c.fields as Record<string, unknown>[]) : [];
    return {
      id: String(c.id),
      displayName: String(c.displayName ?? c.slug ?? c.id),
      slug: String(c.slug ?? ""),
      fields: fields.map((f) => ({ id: String(f.id), slug: String(f.slug), displayName: String(f.displayName ?? f.slug), type: String(f.type ?? ""), isRequired: !!f.isRequired, isEditable: f.isEditable !== false })),
    };
  }

  async createItem(collectionId: string, item: WebflowItemInput): Promise<WebflowItem> {
    return this.call<WebflowItem>(`/collections/${collectionId}/items`, { method: "POST", body: { isDraft: item.isDraft ?? false, isArchived: item.isArchived ?? false, fieldData: item.fieldData } });
  }

  async updateItem(collectionId: string, itemId: string, item: WebflowItemInput): Promise<WebflowItem> {
    return this.call<WebflowItem>(`/collections/${collectionId}/items/${itemId}`, { method: "PATCH", body: { ...(item.isDraft !== undefined ? { isDraft: item.isDraft } : {}), ...(item.isArchived !== undefined ? { isArchived: item.isArchived } : {}), fieldData: item.fieldData } });
  }

  async publishItems(collectionId: string, itemIds: string[]): Promise<{ publishedItemIds: string[] }> {
    const json = await this.call<{ publishedItemIds?: string[] }>(`/collections/${collectionId}/items/publish`, { method: "POST", body: { itemIds } });
    return { publishedItemIds: json.publishedItemIds ?? itemIds };
  }

  async deleteItem(collectionId: string, itemId: string): Promise<void> {
    await this.call(`/collections/${collectionId}/items/${itemId}`, { method: "DELETE" });
  }

  async getItem(collectionId: string, itemId: string): Promise<WebflowItem> {
    return normalizeItem(await this.call<Record<string, unknown>>(`/collections/${collectionId}/items/${itemId}`));
  }

  /** One page of a collection's items (staged, i.e. including drafts), oldest first as Webflow returns them. */
  async listItems(collectionId: string, opts: { offset?: number; limit?: number } = {}): Promise<WebflowItemPage> {
    const limit = Math.min(WEBFLOW_ITEMS_PAGE, Math.max(1, opts.limit ?? WEBFLOW_ITEMS_PAGE));
    const offset = Math.max(0, opts.offset ?? 0);
    const json = await this.call<{ items?: Record<string, unknown>[]; pagination?: { limit?: number; offset?: number; total?: number } }>(`/collections/${collectionId}/items?offset=${offset}&limit=${limit}`);
    const items = (json.items ?? []).map(normalizeItem);
    return { items, total: Number(json.pagination?.total ?? offset + items.length), offset: Number(json.pagination?.offset ?? offset), limit: Number(json.pagination?.limit ?? limit) };
  }

  /** Every item in a collection, paging by offset until the reported total or `maxItems` is reached. */
  async listAllItems(collectionId: string, opts: { maxItems?: number } = {}): Promise<WebflowItem[]> {
    const max = Math.max(1, opts.maxItems ?? WEBFLOW_MAX_ITEMS);
    const out: WebflowItem[] = [];
    for (let offset = 0; out.length < max; offset += WEBFLOW_ITEMS_PAGE) {
      const page = await this.listItems(collectionId, { offset, limit: Math.min(WEBFLOW_ITEMS_PAGE, max - out.length) });
      out.push(...page.items);
      if (page.items.length === 0 || out.length >= page.total) break;
    }
    return out;
  }
}

function normalizeItem(i: Record<string, unknown>): WebflowItem {
  const ts = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    id: String(i.id),
    isDraft: i.isDraft === true,
    isArchived: i.isArchived === true,
    createdOn: ts(i.createdOn),
    lastUpdated: ts(i.lastUpdated),
    lastPublished: ts(i.lastPublished),
    fieldData: (i.fieldData && typeof i.fieldData === "object" ? i.fieldData : {}) as Record<string, unknown>,
  };
}
