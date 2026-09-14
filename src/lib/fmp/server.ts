import "server-only";
import { globalState, memo } from "@/lib/cache";
import { loadSolanaCatalog } from "@/lib/venues/solana-catalog";
import { createFmpClient, type FmpClient } from "./client";
import { createPeopleService, type PeopleService } from "./service";
import type { Batch } from "./types";

type Cached = { value: Batch; expires: number };
const state = globalState("fmp_batches", () => ({ cache: new Map<string, Cached>(), pending: new Map<string, Promise<Batch>>() }));
const raw = createFmpClient();
async function cached(key: string, ttl: number, load: () => Promise<Batch>): Promise<Batch> {
  const hit = state.cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const pending = state.pending.get(key);
  if (pending) return pending;
  const promise = load().then((value) => {
    // Never silently serve stale success after a failure or cache an error for a full day.
    state.cache.set(key, { value, expires: Date.now() + (value.complete ? ttl : 60_000) });
    return value;
  }).finally(() => state.pending.delete(key));
  state.pending.set(key, promise);
  return promise;
}
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const client: FmpClient = {
  profiles: (id) => cached(`profile:${id ?? "directory"}`, DAY, () => raw.profiles(id)),
  annual: (id) => cached(`annual:${id}`, DAY, () => raw.annual(id)),
  aggregates: (id) => cached(`aggregate:${id}`, DAY, () => raw.aggregates(id)),
  houseTrades: (id) => cached(`house:${id}`, HOUR, () => raw.houseTrades(id)),
  senateTrades: (id) => cached(`senate:${id}`, HOUR, () => raw.senateTrades(id)),
  houseLatest: () => cached("house-latest", HOUR, () => raw.houseLatest()),
  senateLatest: () => cached("senate-latest", HOUR, () => raw.senateLatest()),
};
const service = createPeopleService(client, loadSolanaCatalog);
const normalizedCache = { ttlMs: 60_000, staleOnError: false, staleWhileRevalidate: false };
export const peopleService: PeopleService = {
  directory: () => memo("fmp:directory", normalizedCache, () => service.directory()),
  portfolio: (id) => memo(`fmp:portfolio:${id}`, normalizedCache, () => service.portfolio(id)),
};
