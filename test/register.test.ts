import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FedRegisterClient,
  farCaseHistory,
  getDocument,
  getDocumentsBatch,
  getFacetCounts,
  getPublicInspection,
  listAgencies,
  openCommentPeriods,
  searchDocuments,
} from "../src/register.js";
import type { FetchFn, RegisterDeps, SleepFn } from "../src/types.js";

/**
 * Every test runs against an injected fake fetch, a fixed
 * fake clock, and a recording fake sleep: no live network,
 * no real waiting, no live call is made.
 */

const TODAY = new Date("2026-10-27T12:00:00.000Z");
const now = () => new Date(TODAY.getTime());

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
type Handler = (url: string) => Reply;

function makeFetch(handler: Handler, captured: string[] = []): FetchFn {
  return async (url) => {
    captured.push(url);
    const r = handler(url);
    const status = r.status ?? 200;
    const headers = r.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      headers: {
        get: (name: string) => {
          const key = Object.keys(headers).find(
            (k) => k.toLowerCase() === name.toLowerCase(),
          );
          return key === undefined ? null : headers[key];
        },
      },
    };
  };
}

const throwingFetch: FetchFn = async () => {
  throw new Error("connection refused");
};

function makeSleep(record: number[] = []): SleepFn {
  return async (ms) => {
    record.push(ms);
  };
}

function deps(fetchFn: FetchFn, extra: Partial<RegisterDeps> = {}): RegisterDeps {
  return { fetchFn, now, sleep: makeSleep(), ...extra };
}

function okFetch(body: unknown, captured: string[] = []): FetchFn {
  return makeFetch(() => ({ body }), captured);
}

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

async function expectError(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal(err instanceof Error ? err.message : String(err), message);
    return true;
  });
}

describe("search_documents", () => {
  it("returns the upstream JSON verbatim when no comment filter is given", async () => {
    const body = '{"count":1,"results":[{"document_number":"2026-1"}]}';
    const out = await searchDocuments({ term: "x" }, deps(okFetch(body)));
    assert.equal(out, body);
  });

  it("maps flat args to conditions[...] parameters exactly", async () => {
    const captured: string[] = [];
    await searchDocuments(
      {
        term: "climate",
        type: ["RULE", "PRORULE"],
        agencies: ["environmental-protection-agency"],
        docket_id: "EPA-2026-001",
        regulation_id_number: "2060-AV11",
        cfr_title: 40,
        cfr_part: "50-99",
        sections: ["air"],
        topics: ["emissions"],
        significant: true,
        publication_date_is: "2026-10-01",
        publication_date_year: 2026,
        publication_date_gte: "2026-01-01",
        publication_date_lte: "2026-12-31",
        effective_date_is: "2026-11-01",
        effective_date_year: 2026,
        effective_date_gte: "2026-02-01",
        effective_date_lte: "2026-11-30",
        per_page: 25,
        page: 2,
        order: "newest",
        fields: ["title", "comments_close_on"],
      },
      deps(okFetch({ count: 0, results: [] }, captured)),
    );
    assert.equal(captured.length, 1);
    const url = new URL(captured[0]);
    assert.equal(
      `${url.origin}${url.pathname}`,
      "https://www.federalregister.gov/api/v1/documents.json",
    );
    const p = url.searchParams;
    assert.equal(p.get("conditions[term]"), "climate");
    assert.deepEqual(p.getAll("conditions[type][]"), ["RULE", "PRORULE"]);
    assert.deepEqual(p.getAll("conditions[agencies][]"), [
      "environmental-protection-agency",
    ]);
    assert.equal(p.get("conditions[docket_id]"), "EPA-2026-001");
    assert.equal(p.get("conditions[regulation_id_number]"), "2060-AV11");
    assert.equal(p.get("conditions[cfr][title]"), "40");
    assert.equal(p.get("conditions[cfr][part]"), "50-99");
    assert.deepEqual(p.getAll("conditions[sections][]"), ["air"]);
    assert.deepEqual(p.getAll("conditions[topics][]"), ["emissions"]);
    assert.equal(p.get("conditions[significant]"), "1");
    assert.equal(p.get("conditions[publication_date][is]"), "2026-10-01");
    assert.equal(p.get("conditions[publication_date][year]"), "2026");
    assert.equal(p.get("conditions[publication_date][gte]"), "2026-01-01");
    assert.equal(p.get("conditions[publication_date][lte]"), "2026-12-31");
    assert.equal(p.get("conditions[effective_date][is]"), "2026-11-01");
    assert.equal(p.get("conditions[effective_date][year]"), "2026");
    assert.equal(p.get("conditions[effective_date][gte]"), "2026-02-01");
    assert.equal(p.get("conditions[effective_date][lte]"), "2026-11-30");
    assert.equal(p.get("per_page"), "25");
    assert.equal(p.get("page"), "2");
    assert.equal(p.get("order"), "newest");
    assert.deepEqual(p.getAll("fields[]"), ["title", "comments_close_on"]);
  });

  it("sends significant false as \"0\" and does not send comment dates upstream", async () => {
    const captured: string[] = [];
    await searchDocuments(
      { significant: false, comment_date_gte: "2026-11-01" },
      deps(okFetch({ count: 0, results: [] }, captured)),
    );
    const p = paramsOf(captured[0]);
    assert.equal(p.get("conditions[significant]"), "0");
    assert.equal(p.get("conditions[comment_date][gte]"), null);
    assert.equal(p.get("comment_date_gte"), null);
  });

  it("filters the returned page client-side on comments_close_on", async () => {
    const body = {
      count: 4,
      total_pages: 1,
      results: [
        { document_number: "a", comments_close_on: "2026-11-15" },
        { document_number: "b", comments_close_on: null },
        { document_number: "c", comments_close_on: "2026-10-01" },
        { document_number: "d", comments_close_on: "2026-12-31" },
      ],
    };
    const out = await searchDocuments(
      { comment_date_gte: "2026-11-01", comment_date_lte: "2026-12-01" },
      deps(okFetch(body)),
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.count, 4);
    assert.equal(parsed.total_pages, 1);
    assert.deepEqual(
      parsed.results.map((r: { document_number: string }) => r.document_number),
      ["a"],
    );
  });

  it("honours an injected base URL", async () => {
    const captured: string[] = [];
    await searchDocuments(
      {},
      deps(okFetch({ results: [] }, captured), { baseUrl: "https://example.test/fr/" }),
    );
    assert.ok(captured[0].startsWith("https://example.test/fr/documents.json"));
  });

  it("rejects per_page outside 1..1000 before any request", async () => {
    for (const per_page of [0, 1001, 2.5]) {
      const captured: string[] = [];
      await expectError(
        searchDocuments({ per_page }, deps(okFetch({}, captured))),
        "per_page must be an integer between 1 and 1000",
      );
      assert.deepEqual(captured, []);
    }
  });
});

describe("get_document and get_documents_batch", () => {
  it("fetches /documents/{number}.json with fields[]", async () => {
    const captured: string[] = [];
    const out = await getDocument(
      { document_number: "2026-12345", fields: ["title"] },
      deps(okFetch('{"document_number":"2026-12345"}', captured)),
    );
    assert.equal(out, '{"document_number":"2026-12345"}');
    const url = new URL(captured[0]);
    assert.equal(url.pathname, "/api/v1/documents/2026-12345.json");
    assert.deepEqual(url.searchParams.getAll("fields[]"), ["title"]);
  });

  it("rejects an empty document_number before any request", async () => {
    const captured: string[] = [];
    await expectError(
      getDocument({ document_number: "" }, deps(okFetch({}, captured))),
      "document_number must be a non-empty string",
    );
    assert.deepEqual(captured, []);
  });

  it("joins batch numbers with commas in the path", async () => {
    const captured: string[] = [];
    await getDocumentsBatch(
      { document_numbers: ["2026-1", "2026-2", "2026-3"] },
      deps(okFetch({ results: [] }, captured)),
    );
    const url = new URL(captured[0]);
    assert.equal(url.pathname, "/api/v1/documents/2026-1,2026-2,2026-3.json");
  });

  it("rejects batch sizes outside 1..20 with the pinned message", async () => {
    const msg = "document_numbers must be an array of 1 to 20 document numbers";
    await expectError(getDocumentsBatch({ document_numbers: [] }, deps(okFetch({}))), msg);
    await expectError(
      getDocumentsBatch(
        { document_numbers: Array.from({ length: 21 }, (_, i) => `n${i}`) },
        deps(okFetch({})),
      ),
      msg,
    );
    await expectError(
      getDocumentsBatch({ document_numbers: "2026-1" } as never, deps(okFetch({}))),
      msg,
    );
  });
});

describe("get_facet_counts", () => {
  it("hits /documents/facets/{facet} with the filter subset mapped", async () => {
    const captured: string[] = [];
    await getFacetCounts(
      {
        facet: "monthly",
        term: "rule",
        agencies: ["treasury-department"],
        type: ["RULE"],
        docket_id: "D-1",
        regulation_id_number: "1545-AB12",
        cfr_title: 26,
        cfr_part: "1",
        publication_date_gte: "2026-01-01",
        publication_date_lte: "2026-06-30",
        significant: false,
      },
      deps(okFetch({ monthly: {} }, captured)),
    );
    const url = new URL(captured[0]);
    assert.equal(url.pathname, "/api/v1/documents/facets/monthly");
    const p = url.searchParams;
    assert.equal(p.get("conditions[term]"), "rule");
    assert.deepEqual(p.getAll("conditions[agencies][]"), ["treasury-department"]);
    assert.deepEqual(p.getAll("conditions[type][]"), ["RULE"]);
    assert.equal(p.get("conditions[docket_id]"), "D-1");
    assert.equal(p.get("conditions[regulation_id_number]"), "1545-AB12");
    assert.equal(p.get("conditions[cfr][title]"), "26");
    assert.equal(p.get("conditions[cfr][part]"), "1");
    assert.equal(p.get("conditions[publication_date][gte]"), "2026-01-01");
    assert.equal(p.get("conditions[publication_date][lte]"), "2026-06-30");
    assert.equal(p.get("conditions[significant]"), "0");
  });

  it("rejects an empty facet", async () => {
    await expectError(
      getFacetCounts({ facet: "" }, deps(okFetch({}))),
      "facet must be a non-empty string",
    );
  });
});

describe("get_public_inspection and list_agencies", () => {
  it("maps public-inspection args including available_on and special_filing", async () => {
    const captured: string[] = [];
    await getPublicInspection(
      {
        term: "filing",
        agencies: ["justice-department"],
        type: ["NOTICE"],
        docket_id: "D-9",
        available_on: "2026-10-28",
        special_filing: true,
        per_page: 10,
        page: 3,
        fields: ["title"],
      },
      deps(okFetch({ results: [] }, captured)),
    );
    const url = new URL(captured[0]);
    assert.equal(url.pathname, "/api/v1/public-inspection-documents.json");
    const p = url.searchParams;
    assert.equal(p.get("conditions[term]"), "filing");
    assert.deepEqual(p.getAll("conditions[agencies][]"), ["justice-department"]);
    assert.deepEqual(p.getAll("conditions[type][]"), ["NOTICE"]);
    assert.equal(p.get("conditions[docket_id]"), "D-9");
    assert.equal(p.get("conditions[available_on]"), "2026-10-28");
    assert.equal(p.get("conditions[special_filing]"), "1");
    assert.equal(p.get("per_page"), "10");
    assert.equal(p.get("page"), "3");
    assert.deepEqual(p.getAll("fields[]"), ["title"]);
  });

  it("rejects a bad per_page for public inspection", async () => {
    await expectError(
      getPublicInspection({ per_page: 0 }, deps(okFetch({}))),
      "per_page must be an integer between 1 and 1000",
    );
  });

  it("list_agencies fetches /agencies with no query", async () => {
    const captured: string[] = [];
    const out = await listAgencies(deps(okFetch('[{"id":1}]', captured)));
    assert.equal(out, '[{"id":1}]');
    assert.equal(captured[0], "https://www.federalregister.gov/api/v1/agencies");
  });
});

describe("pacing and 429 handling", () => {
  it("waits at least 300 ms between request starts on a shared client", async () => {
    const sleeps: number[] = [];
    const client = new FedRegisterClient({
      fetchFn: okFetch({ results: [] }),
      now,
      sleep: makeSleep(sleeps),
    });
    await client.listAgencies();
    await client.listAgencies();
    assert.deepEqual(sleeps, [300]);
  });

  it("on 429 waits Retry-After seconds and retries the same request once", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchFn = makeFetch(() => {
      calls++;
      return calls === 1
        ? { status: 429, body: "slow down", headers: { "Retry-After": "2" } }
        : { body: { results: [] } };
    });
    const out = await searchDocuments(
      {},
      deps(fetchFn, { sleep: makeSleep(sleeps) }),
    );
    assert.equal(out, '{"results":[]}');
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [2000]);
  });

  it("defaults the 429 wait to 60 seconds when Retry-After is absent", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchFn = makeFetch(() => {
      calls++;
      return calls === 1 ? { status: 429, body: "slow down" } : { body: { ok: 1 } };
    });
    await listAgencies(deps(fetchFn, { sleep: makeSleep(sleeps) }));
    assert.deepEqual(sleeps, [60000]);
  });

  it("gives up after the single retry and reports HTTP 429", async () => {
    let calls = 0;
    const fetchFn = makeFetch(() => {
      calls++;
      return { status: 429, body: "slow down", headers: { "Retry-After": "1" } };
    });
    await expectError(
      listAgencies(deps(fetchFn)),
      "federal register error: HTTP 429",
    );
    assert.equal(calls, 2);
  });

  it("maps a non-2xx reply to federal register error: HTTP <status>", async () => {
    const fetchFn = makeFetch(() => ({ status: 500, body: "boom" }));
    await expectError(listAgencies(deps(fetchFn)), "federal register error: HTTP 500");
  });

  it("maps a throwing fetch to federal register unreachable", async () => {
    await expectError(listAgencies(deps(throwingFetch)), "federal register unreachable");
  });
});

describe("open_comment_periods (composition)", () => {
  function pagedFetch(pages: Record<number, Reply>, captured: string[] = []): FetchFn {
    return makeFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return pages[page] ?? { body: { count: 0, total_pages: 0, results: [] } };
    }, captured);
  }

  it("scans 120 days back, keeps open periods, sorts ascending, reports complete", async () => {
    const captured: string[] = [];
    const fetchFn = pagedFetch(
      {
        1: {
          body: {
            count: 4,
            total_pages: 2,
            results: [
              { document_number: "late", comments_close_on: "2026-12-01" },
              { document_number: "closed", comments_close_on: "2026-10-26" },
              { document_number: "none", comments_close_on: null },
            ],
          },
        },
        2: {
          body: {
            count: 4,
            total_pages: 2,
            results: [{ document_number: "soon", comments_close_on: "2026-10-27" }],
          },
        },
      },
      captured,
    );
    const out = await openCommentPeriods({}, deps(fetchFn));
    const parsed = JSON.parse(out);
    assert.deepEqual(
      parsed.results.map((r: { document_number: string }) => r.document_number),
      ["soon", "late"],
    );
    assert.equal(parsed.complete, true);
    assert.equal(parsed.truncated, false);
    assert.equal(captured.length, 2);
    const p = paramsOf(captured[0]);
    assert.equal(p.get("conditions[publication_date][gte]"), "2026-06-29");
    assert.equal(p.get("per_page"), "1000");
    assert.equal(p.get("order"), "newest");
  });

  it("passes term and agencies conditions into the scan", async () => {
    const captured: string[] = [];
    const fetchFn = pagedFetch(
      { 1: { body: { count: 0, total_pages: 1, results: [] } } },
      captured,
    );
    await openCommentPeriods(
      { term: "emissions", agencies: ["environmental-protection-agency"] },
      deps(fetchFn),
    );
    const p = paramsOf(captured[0]);
    assert.equal(p.get("conditions[term]"), "emissions");
    assert.deepEqual(p.getAll("conditions[agencies][]"), [
      "environmental-protection-agency",
    ]);
  });

  it("applies limit and marks truncated", async () => {
    const fetchFn = pagedFetch({
      1: {
        body: {
          count: 3,
          total_pages: 1,
          results: [
            { document_number: "a", comments_close_on: "2026-11-01" },
            { document_number: "b", comments_close_on: "2026-11-02" },
            { document_number: "c", comments_close_on: "2026-11-03" },
          ],
        },
      },
    });
    const out = await openCommentPeriods({ limit: 2 }, deps(fetchFn));
    const parsed = JSON.parse(out);
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.complete, true);
  });

  it("reports complete=false when the 5-page cap cuts the scan short", async () => {
    const captured: string[] = [];
    const page: Reply = {
      body: { count: 9999, total_pages: 9, results: [] },
    };
    const fetchFn = pagedFetch({ 1: page, 2: page, 3: page, 4: page, 5: page }, captured);
    const out = await openCommentPeriods({}, deps(fetchFn));
    const parsed = JSON.parse(out);
    assert.equal(parsed.complete, false);
    assert.equal(parsed.truncated, false);
    assert.equal(captured.length, 5);
  });
});

describe("far_case_history (composition)", () => {
  it("searches by case number with per_page 1000 and order oldest, verbatim", async () => {
    const captured: string[] = [];
    const body = '{"count":2,"results":[{"document_number":"x"}]}';
    const out = await farCaseHistory(
      { case_number: "FAR Case 2023-008" },
      deps(okFetch(body, captured)),
    );
    assert.equal(out, body);
    const url = new URL(captured[0]);
    assert.equal(url.pathname, "/api/v1/documents.json");
    const p = url.searchParams;
    assert.equal(p.get("conditions[term]"), "FAR Case 2023-008");
    assert.equal(p.get("per_page"), "1000");
    assert.equal(p.get("order"), "oldest");
  });

  it("rejects an empty case_number", async () => {
    await expectError(
      farCaseHistory({ case_number: "" }, deps(okFetch({}))),
      "case_number must be a non-empty string",
    );
  });
});
