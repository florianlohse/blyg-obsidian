// A Studio for scale tests: only the reads of the reader (reading list, mentions, own posts, change counters), over a large synthetic list. It counts what it is asked,
// and can answer a request with a scripted status (429 with Retry-After, 409 cursor-expired). Kept apart from tests/studio/fake-studio.ts, which models writes.
import type { RawRequest, RawResponse } from "../../src/platform/http";
import { syntheticRows } from "../../src/dev/syntheticPosts";

export const SCALE_HOST = "https://studio.example.test";
export const SCALE_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2ln";

export interface Fault {
  /** Matches "METHOD /api/path" without the query. */
  match: RegExp;
  /** The answer, given instead of the real one; runs once per `times`. */
  answer: Partial<RawResponse>;
  times: number;
}

export class ScaleStudio {
  /** The contract gate's `GET /api/capabilities`: once per client session, kept out of `requests` so the list shows what a refresh itself asks. */
  gateRequests = 0;
  readonly requests: Array<{ method: string; path: string; status: number }> = [];
  readonly faults: Fault[] = [];
  private epoch = 0;
  private readonly rows: Record<string, unknown>[];
  constructor(posts: number, blygs = 200) {
    this.rows = syntheticRows(posts, { blygs });
  }
  /** A change in the middle of a walk: cursors made before it expire. */
  bump(): void {
    this.epoch++;
  }
  countOf(re: RegExp): number {
    return this.requests.filter((r) => re.test(`${r.method} ${r.path}`)).length;
  }

  readonly transport = (req: RawRequest): Promise<RawResponse> => {
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const fault = this.faults.find((f) => f.times > 0 && f.match.test(key));
    let res: RawResponse;
    if (fault) {
      fault.times--;
      res = { status: 200, headers: {}, text: "", ...fault.answer };
    } else res = this.handle(req.method, url);
    if (url.pathname === "/api/capabilities") this.gateRequests++;
    else this.requests.push({ method: req.method, path: url.pathname, status: res.status });
    return Promise.resolve(res);
  };

  private json(status: number, body: unknown): RawResponse {
    return { status, headers: {}, text: JSON.stringify(body) };
  }

  private page(url: URL, rows: unknown[]): RawResponse {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    let offset = 0;
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null) {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o: number; e: number };
      if (parsed.e !== this.epoch) return this.json(409, { code: "cursor-expired", message: "Collection changed; restart from its first page" });
      offset = parsed.o;
    }
    const next = offset + limit < rows.length ? Buffer.from(JSON.stringify({ o: offset + limit, e: this.epoch })).toString("base64url") : null;
    return this.json(200, { items: rows.slice(offset, offset + limit), page: { limit, nextCursor: next } });
  }

  private handle(method: string, url: URL): RawResponse {
    const path = url.pathname;
    if (method === "GET" && path === "/api/capabilities") return this.json(200, { contractVersion: "5.2.0", endpoints: { publicBase: SCALE_HOST, studio: `${SCALE_HOST}/studio`, api: `${SCALE_HOST}/api`, issuer: `${SCALE_HOST}/studio/auth`, mcp: `${SCALE_HOST}/studio/mcp`, media: `${SCALE_HOST}/media` }, operations: [], extensions: [] });
    if (method === "GET" && path === "/api/reading/imported") return this.page(url, this.rows);
    if (method === "GET" && path === "/api/mentions") return this.page(url, []);
    if (method === "GET" && path === "/api/reading") return this.page(url, []);
    if (method === "GET" && path === "/api/changes") return this.json(200, { epoch: "e1", domains: { reading: 1, subscriptions: 1 } });
    if (method === "POST" && path === "/api/subscriptions/poll") return this.json(200, { polling: 200 });
    return this.json(404, { code: "not-found", message: "not found" });
  }
}
