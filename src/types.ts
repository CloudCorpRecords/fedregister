/**
 * fedregister types.
 *
 * Eight tools over the public, keyless Federal Register
 * API v1. Every tool answers with a single text item
 * carrying the upstream JSON (verbatim, except for the
 * labelled client-side comment-date filter and the two
 * labelled compositions, open_comment_periods and
 * far_case_history).
 */

export interface SearchDocumentsArgs {
  term?: string;
  type?: string[];
  agencies?: string[];
  docket_id?: string;
  regulation_id_number?: string;
  cfr_title?: number;
  cfr_part?: string;
  sections?: string[];
  topics?: string[];
  significant?: boolean;
  publication_date_is?: string;
  publication_date_year?: number;
  publication_date_gte?: string;
  publication_date_lte?: string;
  effective_date_is?: string;
  effective_date_year?: number;
  effective_date_gte?: string;
  effective_date_lte?: string;
  /** Client-side filter on the documents' comments_close_on field. */
  comment_date_gte?: string;
  /** Client-side filter on the documents' comments_close_on field. */
  comment_date_lte?: string;
  per_page?: number;
  page?: number;
  order?: string;
  fields?: string[];
}

export interface GetDocumentArgs {
  document_number: string;
  fields?: string[];
}

export interface GetDocumentsBatchArgs {
  document_numbers: string[];
}

export interface GetFacetCountsArgs {
  facet: string;
  term?: string;
  agencies?: string[];
  type?: string[];
  docket_id?: string;
  regulation_id_number?: string;
  cfr_title?: number;
  cfr_part?: string;
  publication_date_gte?: string;
  publication_date_lte?: string;
  significant?: boolean;
}

export interface GetPublicInspectionArgs {
  term?: string;
  agencies?: string[];
  type?: string[];
  docket_id?: string;
  available_on?: string;
  special_filing?: boolean;
  per_page?: number;
  page?: number;
  fields?: string[];
}

export interface OpenCommentPeriodsArgs {
  agencies?: string[];
  term?: string;
  limit?: number;
}

export interface FarCaseHistoryArgs {
  case_number: string;
}

/** The minimal slice of a fetch Response this client relies on. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: {
    get(name: string): string | null;
  };
}

/** Injectable fetch, so tests never touch the live network. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

/** Injectable sleep, so tests never wait out the pacing delays. */
export type SleepFn = (ms: number) => Promise<void>;

/** Runtime dependencies for the core, all injectable in tests. */
export interface RegisterDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchFn?: FetchFn;
  /**
   * Federal Register API base URL. Defaults to the
   * FEDERAL_REGISTER_API_BASE environment variable, or
   * https://www.federalregister.gov/api/v1.
   */
  baseUrl?: string;
  /** Clock, used by open_comment_periods and the pacer. */
  now?: () => Date;
  /** Sleep used for pacing and 429 back-off. */
  sleep?: SleepFn;
}
