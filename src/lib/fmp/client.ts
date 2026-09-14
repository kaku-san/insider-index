/** Node-only transport and private raw archive. Never import this into client components. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Batch, FmpEndpoint, FmpParams, FmpRow, IngestionIssue, SourcePage } from "./types.ts";

const BASE = "https://financialmodelingprep.com/stable/";
const ENDPOINTS = new Set<FmpEndpoint>([
  "senate-profile", "senate-net-worth", "senate-net-worth-aggregated",
  "house-trades-by-id", "senate-trades-by-id", "house-latest", "senate-latest",
]);
export class FmpError extends Error {
  readonly issue: IngestionIssue;
  constructor(issue: IngestionIssue) {
    // Never include upstream messages, headers, URLs, request objects or causes.
    super(`FMP ${issue.code}${issue.httpStatus ? ` (${issue.httpStatus})` : ""}`);
    this.name = "FmpError";
    this.issue = issue;
  }
}

export async function readFmpKey(): Promise<string | null> {
  if (process.env.FMP_API_KEY?.trim()) return process.env.FMP_API_KEY.trim();
  try { return (await readFile(join(homedir(), ".config/fmp-api-key"), "utf8")).trim() || null; }
  catch { return null; }
}

export type RawCapture = SourcePage & { httpStatus: number; body: string };
/** Archive is not web-served. Files are unique per observation; hashes describe stored bytes. */
export function privateArchive(directory = join(process.cwd(), ".data/fmp")) {
  return async (capture: RawCapture): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(join(directory, `${capture.payloadHash}-${randomUUID()}.json`), JSON.stringify(capture), {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
  };
}

function redact(body: string, key: string): string {
  return body.split(key).join("[REDACTED]")
    .split(encodeURIComponent(key)).join("[REDACTED]")
    .replace(/([?&](?:apikey|api_key)=)[^&\s"<>]+/gi, "$1[REDACTED]");
}
function object(value: unknown): value is FmpRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validRows(payload: unknown): payload is FmpRow[] {
  return Array.isArray(payload) && payload.every((row) => object(row) &&
    !Object.keys(row).some((key) => /^(error(?: message)?|message|information|note)$/i.test(key)));
}

export type FmpClientOptions = {
  key?: () => Promise<string | null>;
  fetch?: typeof fetch;
  archive?: (capture: RawCapture) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
  retries?: number;
};
export function createFmpClient(options: FmpClientOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const archive = options.archive ?? privateArchive();
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxPages = options.maxPages ?? 2000;
  const retries = options.retries ?? 2;
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(retries) || retries < 0 || retries > 5) {
    throw new Error("Invalid FMP client limits");
  }

  async function page(endpoint: FmpEndpoint, params: FmpParams): Promise<{ rows: FmpRow[]; source: SourcePage }> {
    const pageNumber = params.page ?? 0;
    const fail = (code: IngestionIssue["code"], httpStatus?: number) => new FmpError({ code, endpoint, page: pageNumber, ...(httpStatus ? { httpStatus } : {}) });
    if (!ENDPOINTS.has(endpoint)) throw fail("payload");
    // Explicit allowlist; callers cannot smuggle credentials or arbitrary URLs into metadata.
    const safe: FmpParams = {};
    if (params.senateID !== undefined) {
      if (!/^[A-Z]\d{6}$/.test(params.senateID)) throw fail("identity");
      safe.senateID = params.senateID;
    }
    for (const name of ["page", "limit"] as const) {
      const value = params[name];
      if (value !== undefined) {
        if (!Number.isInteger(value) || value < (name === "page" ? 0 : 1) || (name === "limit" && value > 1000)) throw fail("payload");
        safe[name] = value;
      }
    }
    const key = await (options.key ?? readFmpKey)();
    if (!key) throw fail("unconfigured");
    const url = new URL(endpoint, BASE);
    for (const [name, value] of Object.entries(safe)) url.searchParams.set(name, String(value));
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let body: string;
      try {
        response = await fetcher(url, {
          headers: { apikey: key, Accept: "application/json" }, cache: "no-store",
          redirect: "error", signal: AbortSignal.timeout(25_000),
        });
        body = redact(await response.text(), key);
      } catch {
        if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        throw fail("network");
      }
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { payload = null; }
      const source: SourcePage = {
        endpoint, params: safe, fetchedAt: now().toISOString(),
        payloadHash: createHash("sha256").update(body).digest("hex"),
        rowCount: Array.isArray(payload) ? payload.length : 0,
      };
      try { await archive({ ...source, httpStatus: response.status, body }); }
      catch { throw fail("storage"); }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const header = response.headers.get("retry-after");
          const seconds = header === null ? NaN : Number(header);
          const delay = header === null ? 500 * 2 ** attempt
            : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now().getTime();
          // Do not hammer when the provider requires a wait longer than this request budget.
          if (Number.isFinite(delay) && delay <= 30_000) { await sleep(Math.max(0, delay)); continue; }
        }
        throw fail("http", response.status);
      }
      if (!validRows(payload)) throw fail("payload");
      return { rows: payload, source };
    }
  }

  async function collect(endpoint: FmpEndpoint, params: FmpParams = {}, paginated = true): Promise<Batch> {
    const batch: Batch = { endpoint, status: "partial", complete: false, rows: [], pages: [], issues: [] };
    const seen = new Set<string>();
    for (let index = 0; index < (paginated ? maxPages : 1); index++) {
      let result: Awaited<ReturnType<typeof page>>;
      try { result = await page(endpoint, paginated ? { ...params, page: index, limit: params.limit ?? 100 } : params); }
      catch (error) {
        if (!(error instanceof FmpError)) throw error;
        batch.issues.push(error.issue);
        batch.status = batch.pages.length ? "partial" : "failed";
        return batch;
      }
      batch.pages.push(result.source);
      // Hash the parsed payload too: formatting changes must not hide a repeated page.
      const hash = createHash("sha256").update(JSON.stringify(result.rows)).digest("hex");
      if (result.rows.length && seen.has(hash)) {
        batch.issues.push({ code: "repeated-page", endpoint, page: index });
        return batch;
      }
      seen.add(hash);
      batch.rows.push(...result.rows.map((row, ordinal) => ({ row, source: result.source, ordinal })));
      if (!result.rows.length || !paginated) {
        batch.complete = true;
        batch.status = "complete";
        return batch;
      }
    }
    batch.issues.push({ code: "page-limit", endpoint, page: maxPages });
    return batch;
  }

  return {
    profiles: (senateID?: string) => collect("senate-profile", senateID ? { senateID } : {}),
    annual: (senateID: string) => collect("senate-net-worth", { senateID, limit: 250 }),
    // Documented as one complete series, not a paginated endpoint.
    aggregates: (senateID: string) => collect("senate-net-worth-aggregated", { senateID }, false),
    houseTrades: (senateID: string) => collect("house-trades-by-id", { senateID }),
    senateTrades: (senateID: string) => collect("senate-trades-by-id", { senateID }),
    houseLatest: () => collect("house-latest"),
    senateLatest: () => collect("senate-latest"),
  };
}
export type FmpClient = ReturnType<typeof createFmpClient>;
