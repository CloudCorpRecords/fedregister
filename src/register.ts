/**
 * fedregister core: a client for the public, keyless
 * Federal Register API v1 (base default
 * https://www.federalregister.gov/api/v1, overridable via
 * the FEDERAL_REGISTER_API_BASE environment variable or an
 * injected base URL).
 *
 * Flat tool arguments map to the API's OpenAPI
 * `conditions[...]` parameters: scalars become
 * `conditions[<name>]`, string arrays repeat the parameter
 * as `conditions[<name>][]`, CFR title/part nest under
 * `conditions[cfr][title|part]`, the publication/effective
 * date arguments nest under
 * `conditions[publication_date|effective_date][is|year|gte|lte]`,
 * and the booleans `significant` / `special_filing` are
 * sent as "1" / "0". `fields` repeats as `fields[]`;
 * `per_page`, `page`, and `order` are plain parameters.
 *
 * The API publishes no comment-date condition, so
 * `comment_date_gte` / `comment_date_lte` on
 * search_documents are CLIENT-SIDE FILTERS (labelled):
 * they drop returned documents whose `comments_close_on`
 * is null or outside the range, leaving the rest of the
 * response envelope unchanged.
 *
 * Two tools are labelled COMPOSITIONS:
 * - open_comment_periods pages through /documents.json
 *   (publication_date gte = 120 days before today — the
 *   scan window, a labelled local choice; per_page 1000,
 *   order newest, at most 5 pages), keeps documents whose
 *   comments_close_on is today or later, sorts ascending
 *   by comments_close_on, applies `limit` (default 50),
 *   and returns {"results", "complete", "truncated"} —
 *   complete when every page of the scan window was read,
 *   truncated when results were cut by limit.
 * - far_case_history is a term search for the case number
 *   with per_page 1000 and order oldest, returned verbatim.
 *
 * Pacing (pinned): at least 300 ms between request starts
 * through a shared pacer; on HTTP 429, wait the
 * `Retry-After` header value in seconds (default 60) and
 * retry the same request once. Fetch, clock, and sleep
 * are all injectable, so tests never touch the network or
 * wait in real time.
 *
 * Errors: a non-2xx reply after the single permitted 429
 * retry is `federal register error: HTTP <status>`; a
 * throwing fetch is `federal register unreachable`. All
 * validation runs before any request, with the pinned
 * error strings.
 */
import type {
  FarCaseHistoryArgs,
  FetchFn,
  FetchResponseLike,
  GetDocumentArgs,
  GetDocumentsBatchArgs,
  GetFacetCountsArgs,
  GetPublicInspectionArgs,
  OpenCommentPeriodsArgs,
  RegisterDeps,
  SearchDocumentsArgs,
  SleepFn,
} from "./types.js";

export const VERSION = "0.1.0";

export const FEDERAL_REGISTER_BASE_URL = "https://www.federalregister.gov/api/v1";

/** Minimum gap between request starts, in milliseconds. */
export const MIN_REQUEST_GAP_MS = 300;

/** Days before today that open_comment_periods scans back over. */
export const COMMENT_SCAN_WINDOW_DAYS = 120;

/** Maximum pages open_comment_periods reads from the scan window. */
export const COMMENT_SCAN_MAX_PAGES = 5;

const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, text: () => res.text(), headers: res.headers };
};

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function validatePerPage(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error("per_page must be an integer between 1 and 1000");
  }
}

function validateNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

type RawArgs = Record<string, unknown>;

/** Append the shared conditions[...] mapping for the given flat args. */
function addConditions(
  params: URLSearchParams,
  raw: RawArgs,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    switch (key) {
      case "type":
      case "agencies":
      case "sections":
      case "topics":
        if (Array.isArray(value)) {
          for (const item of value) params.append(`conditions[${key}][]`, String(item));
        }
        break;
      case "cfr_title":
        params.set("conditions[cfr][title]", String(value));
        break;
      case "cfr_part":
        params.set("conditions[cfr][part]", String(value));
        break;
      case "significant":
      case "special_filing":
        params.set(`conditions[${key}]`, value ? "1" : "0");
        break;
      case "publication_date_is":
      case "publication_date_year":
      case "publication_date_gte":
      case "publication_date_lte": {
        const sub = key.slice("publication_date_".length);
        params.set(`conditions[publication_date][${sub}]`, String(value));
        break;
      }
      case "effective_date_is":
      case "effective_date_year":
      case "effective_date_gte":
      case "effective_date_lte": {
        const sub = key.slice("effective_date_".length);
        params.set(`conditions[effective_date][${sub}]`, String(value));
        break;
      }
      default:
        params.set(`conditions[${key}]`, String(value));
        break;
    }
  }
}

function addFields(params: URLSearchParams, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) params.append("fields[]", String(item));
  }
}

function addPaging(params: URLSearchParams, raw: RawArgs): void {
  if (raw.per_page !== undefined) params.set("per_page", String(raw.per_page));
  if (raw.page !== undefined) params.set("page", String(raw.page));
}

/**
 * A stateful Federal Register client: one instance carries
 * the shared pacer, so pacing holds across calls made
 * through the same client (the MCP server keeps one).
 */
export class FedRegisterClient {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly nowFn: () => Date;
  private readonly sleepFn: SleepFn;
  private lastStartMs: number | null = null;

  constructor(deps: RegisterDeps = {}) {
    this.fetchFn = deps.fetchFn ?? defaultFetch;
    const base =
      deps.baseUrl ?? process.env.FEDERAL_REGISTER_API_BASE ?? FEDERAL_REGISTER_BASE_URL;
    this.baseUrl = base.replace(/\/+$/, "");
    this.nowFn = deps.now ?? (() => new Date());
    this.sleepFn = deps.sleep ?? defaultSleep;
  }

  private async pace(): Promise<void> {
    const nowMs = this.nowFn().getTime();
    if (this.lastStartMs !== null) {
      const wait = MIN_REQUEST_GAP_MS - (nowMs - this.lastStartMs);
      if (wait > 0) await this.sleepFn(wait);
    }
    this.lastStartMs = this.nowFn().getTime();
  }

  private async rawFetch(url: string): Promise<FetchResponseLike> {
    try {
      return await this.fetchFn(url, { method: "GET" });
    } catch {
      throw new Error("federal register unreachable");
    }
  }

  /** One paced GET, with the single permitted 429 retry. */
  private async request(url: string): Promise<string> {
    await this.pace();
    let res = await this.rawFetch(url);
    if (res.status === 429) {
      const header = res.headers?.get("Retry-After");
      const seconds = header === null || header === undefined ? NaN : Number(header);
      const waitSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 60;
      await this.sleepFn(waitSeconds * 1000);
      this.lastStartMs = this.nowFn().getTime();
      res = await this.rawFetch(url);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`federal register error: HTTP ${res.status}`);
    }
    return res.text();
  }

  private async requestJson(url: string): Promise<Record<string, unknown>> {
    const text = await this.request(url);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("federal register unreachable");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("federal register unreachable");
    }
    return parsed as Record<string, unknown>;
  }

  private url(path: string, params?: URLSearchParams): string {
    const query = params ? params.toString() : "";
    return query ? `${this.baseUrl}${path}?${query}` : `${this.baseUrl}${path}`;
  }

  /** Search Federal Register documents published since 1994. */
  async searchDocuments(args: SearchDocumentsArgs): Promise<string> {
    const raw = (args ?? {}) as unknown as RawArgs;
    validatePerPage(raw.per_page);
    const params = new URLSearchParams();
    addConditions(params, raw, [
      "term",
      "type",
      "agencies",
      "docket_id",
      "regulation_id_number",
      "cfr_title",
      "cfr_part",
      "sections",
      "topics",
      "significant",
      "publication_date_is",
      "publication_date_year",
      "publication_date_gte",
      "publication_date_lte",
      "effective_date_is",
      "effective_date_year",
      "effective_date_gte",
      "effective_date_lte",
    ]);
    addPaging(params, raw);
    if (raw.order !== undefined) params.set("order", String(raw.order));
    addFields(params, raw.fields);
    const text = await this.request(this.url("/documents.json", params));
    const gte = typeof raw.comment_date_gte === "string" ? raw.comment_date_gte : undefined;
    const lte = typeof raw.comment_date_lte === "string" ? raw.comment_date_lte : undefined;
    if (gte === undefined && lte === undefined) return text;
    // Labelled client-side filter: the API publishes no
    // comment-date condition, so filter this page here on
    // each document's comments_close_on field.
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text;
      envelope = parsed as Record<string, unknown>;
    } catch {
      return text;
    }
    if (!Array.isArray(envelope.results)) return text;
    envelope.results = envelope.results.filter((doc) => {
      if (typeof doc !== "object" || doc === null) return false;
      const close = (doc as Record<string, unknown>).comments_close_on;
      if (typeof close !== "string") return false;
      if (gte !== undefined && close < gte) return false;
      if (lte !== undefined && close > lte) return false;
      return true;
    });
    return JSON.stringify(envelope);
  }

  /** Fetch a single Federal Register document by document number. */
  async getDocument(args: GetDocumentArgs): Promise<string> {
    const raw = (args ?? {}) as unknown as RawArgs;
    const number = validateNonEmptyString(
      raw.document_number,
      "document_number must be a non-empty string",
    );
    const params = new URLSearchParams();
    addFields(params, raw.fields);
    return this.request(
      this.url(`/documents/${encodeURIComponent(number)}.json`, params),
    );
  }

  /** Fetch multiple Federal Register documents in one call (up to 20). */
  async getDocumentsBatch(args: GetDocumentsBatchArgs): Promise<string> {
    const raw = (args ?? {}) as unknown as RawArgs;
    const numbers = raw.document_numbers;
    if (
      !Array.isArray(numbers) ||
      numbers.length < 1 ||
      numbers.length > 20 ||
      numbers.some((n) => typeof n !== "string" || n.length === 0)
    ) {
      throw new Error("document_numbers must be an array of 1 to 20 document numbers");
    }
    const joined = (numbers as string[]).map((n) => encodeURIComponent(n)).join(",");
    return this.request(this.url(`/documents/${joined}.json`));
  }

  /** Counts of matching documents grouped by a facet. */
  async getFacetCounts(args: GetFacetCountsArgs): Promise<string> {
    const raw = (args ?? {}) as unknown as RawArgs;
    const facet = validateNonEmptyString(raw.facet, "facet must be a non-empty string");
    const params = new URLSearchParams();
    addConditions(params, raw, [
      "term",
      "agencies",
      "type",
      "docket_id",
      "regulation_id_number",
      "cfr_title",
      "cfr_part",
      "publication_date_gte",
      "publication_date_lte",
      "significant",
    ]);
    return this.request(
      this.url(`/documents/facets/${encodeURIComponent(facet)}`, params),
    );
  }

  /** Search documents currently on public inspection (pre-publication). */
  async getPublicInspection(args: GetPublicInspectionArgs): Promise<string> {
    const raw = (args ?? {}) as unknown as RawArgs;
    validatePerPage(raw.per_page);
    const params = new URLSearchParams();
    addConditions(params, raw, [
      "term",
      "agencies",
      "type",
      "docket_id",
      "available_on",
      "special_filing",
    ]);
    addPaging(params, raw);
    addFields(params, raw.fields);
    return this.request(this.url("/public-inspection-documents.json", params));
  }

  /** All Federal Register agencies. */
  async listAgencies(): Promise<string> {
    return this.request(this.url("/agencies"));
  }

  /**
   * Composition (labelled): proposed rules and notices whose
   * comment period is still open, sorted by deadline.
   */
  async openCommentPeriods(args: OpenCommentPeriodsArgs): Promise<string> {
    const raw = (args ?? {}) as unknown as RawArgs;
    const today = isoDate(this.nowFn());
    const windowStart = new Date(this.nowFn().getTime() - COMMENT_SCAN_WINDOW_DAYS * 86_400_000);
    const kept: Record<string, unknown>[] = [];
    let complete = false;
    for (let page = 1; page <= COMMENT_SCAN_MAX_PAGES; page++) {
      const params = new URLSearchParams();
      params.set("conditions[publication_date][gte]", isoDate(windowStart));
      if (raw.term !== undefined) params.set("conditions[term]", String(raw.term));
      if (Array.isArray(raw.agencies)) {
        for (const item of raw.agencies) params.append("conditions[agencies][]", String(item));
      }
      params.set("per_page", "1000");
      params.set("order", "newest");
      params.set("page", String(page));
      const data = await this.requestJson(this.url("/documents.json", params));
      const results = Array.isArray(data.results) ? data.results : [];
      for (const doc of results) {
        if (typeof doc !== "object" || doc === null) continue;
        const record = doc as Record<string, unknown>;
        const close = record.comments_close_on;
        if (typeof close === "string" && close >= today) kept.push(record);
      }
      const totalPages = data.total_pages;
      if (typeof totalPages === "number") {
        if (page >= totalPages) {
          complete = true;
          break;
        }
      } else if (results.length < 1000) {
        complete = true;
        break;
      }
    }
    kept.sort((a, b) => {
      const ac = String(a.comments_close_on);
      const bc = String(b.comments_close_on);
      return ac < bc ? -1 : ac > bc ? 1 : 0;
    });
    const limit =
      typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit >= 0
        ? raw.limit
        : 50;
    const truncated = kept.length > limit;
    const results = truncated ? kept.slice(0, limit) : kept;
    return JSON.stringify({ results, complete, truncated });
  }

  /**
   * Composition (labelled): the full document history of a
   * FAR/DFARS case, from the proposed rule to the final rule.
   */
  async farCaseHistory(args: FarCaseHistoryArgs): Promise<string> {
    const raw = (args ?? {}) as unknown as RawArgs;
    const caseNumber = validateNonEmptyString(
      raw.case_number,
      "case_number must be a non-empty string",
    );
    const params = new URLSearchParams();
    params.set("conditions[term]", caseNumber);
    params.set("per_page", "1000");
    params.set("order", "oldest");
    return this.request(this.url("/documents.json", params));
  }
}

/** Standalone helpers: each builds a one-shot client from the deps. */

export async function searchDocuments(
  args: SearchDocumentsArgs,
  deps: RegisterDeps = {},
): Promise<string> {
  return new FedRegisterClient(deps).searchDocuments(args);
}

export async function getDocument(
  args: GetDocumentArgs,
  deps: RegisterDeps = {},
): Promise<string> {
  return new FedRegisterClient(deps).getDocument(args);
}

export async function getDocumentsBatch(
  args: GetDocumentsBatchArgs,
  deps: RegisterDeps = {},
): Promise<string> {
  return new FedRegisterClient(deps).getDocumentsBatch(args);
}

export async function getFacetCounts(
  args: GetFacetCountsArgs,
  deps: RegisterDeps = {},
): Promise<string> {
  return new FedRegisterClient(deps).getFacetCounts(args);
}

export async function getPublicInspection(
  args: GetPublicInspectionArgs,
  deps: RegisterDeps = {},
): Promise<string> {
  return new FedRegisterClient(deps).getPublicInspection(args);
}

export async function listAgencies(deps: RegisterDeps = {}): Promise<string> {
  return new FedRegisterClient(deps).listAgencies();
}

export async function openCommentPeriods(
  args: OpenCommentPeriodsArgs,
  deps: RegisterDeps = {},
): Promise<string> {
  return new FedRegisterClient(deps).openCommentPeriods(args);
}

export async function farCaseHistory(
  args: FarCaseHistoryArgs,
  deps: RegisterDeps = {},
): Promise<string> {
  return new FedRegisterClient(deps).farCaseHistory(args);
}
