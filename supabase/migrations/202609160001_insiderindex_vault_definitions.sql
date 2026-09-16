-- Durable per-vault InsiderIndex definitions: one row per person index / Symmetry V3 vault.
-- The keeper reads its target weights and eligibility inputs from here, never from local files.
-- Definitions are UPDATED in place (never duplicated) and versioned by their derived hash + the
-- source drop sha256, so a refresh never silently changes weights without a trace. A live
-- vault_address / share_mint and the last rebalance result survive a definition refresh.
-- Legs are xStock-first with verified Backpack .US fallback; transaction-derived books never
-- become weights (they persist as blocked). No net worth, no NAV.
begin;

create table public.insiderindex_vault_definitions (
  index_id text primary key,
  person_slug text not null,
  bioguide_id text,
  network text not null default 'mainnet-beta' check (network in ('mainnet-beta','devnet')),
  name text not null,
  symbol text not null,
  weight_basis text not null,
  status text not null check (status in ('CREATABLE','WAIT_POOL_EVIDENCE','BLOCKED')),
  structurally_creatable boolean not null,
  blocked_reasons jsonb not null default '[]'::jsonb,
  book_source text,
  -- Full derivation provenance (fmpYear, annualFetchComplete, holdings/ticker/weighted counts,
  -- note). book_source stays its own queryable column above; this shows book honesty without
  -- re-reading the source zip.
  provenance jsonb not null default '{}'::jsonb,
  native_token_cap integer not null check (native_token_cap between 1 and 100),
  host_entry_fee_bps integer not null check (host_entry_fee_bps = 25),
  host_exit_fee_bps integer not null check (host_exit_fee_bps = 0),
  -- Mapped catalog legs (mints + book weights) and the pool-ready vault composition (bps→10000).
  legs jsonb not null default '[]'::jsonb,
  vault_legs jsonb not null default '[]'::jsonb,
  pool_excluded_legs jsonb not null default '[]'::jsonb,
  unmapped jsonb not null default '[]'::jsonb,
  coverage jsonb not null default '{}'::jsonb,
  cost jsonb,
  keeper jsonb not null default '{}'::jsonb,
  -- Set by the captain-authorised creation step, never wiped by a definition refresh.
  vault_address text,
  share_mint text,
  last_rebalance_at timestamptz,
  last_rebalance_result jsonb,
  -- Provenance / versioning.
  source_zip text,
  source_sha256 text,
  definition_hash text not null,
  definition_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(legs) = 'array'),
  check (jsonb_typeof(vault_legs) = 'array')
);
comment on table public.insiderindex_vault_definitions is 'Per-person InsiderIndex vault definitions. Keeper target/eligibility source of truth. Not net worth, not NAV.';

alter table public.insiderindex_vault_definitions enable row level security;
revoke all on public.insiderindex_vault_definitions from public, anon, authenticated, service_role;
grant select on public.insiderindex_vault_definitions to service_role;

-- Owner RPC: upsert the full set from one derivation document in a single transaction. Updates in
-- place, bumps definition_version only when the derived hash changes, and preserves a live
-- vault_address / share_mint / last rebalance across refreshes.
create or replace function public.publish_insiderindex_vault_definitions(p_document text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d jsonb := p_document::jsonb;
  def jsonb;
  h text;
  vlegs jsonb;
  bps integer;
  changed integer := 0;
  total integer := 0;
  seen text[] := array[]::text[];
begin
  if jsonb_typeof(d->'definitions') is distinct from 'array' then
    raise exception 'definitions array required';
  end if;

  for def in select value from jsonb_array_elements(d->'definitions') loop
    total := total + 1;
    if def->>'indexId' is null or def->>'personSlug' is null then raise exception 'index id and person slug required'; end if;
    if def->>'hostEntryFeeBps' is distinct from '25' or def->>'hostExitFeeBps' is distinct from '0' then
      raise exception 'host fees must be 25 in / 0 out';
    end if;

    vlegs := coalesce(def->'vaultLegs', '[]'::jsonb);
    -- The pool-ready composition, when present, must carry integer bps summing to exactly 10000.
    if jsonb_array_length(vlegs) > 0 then
      select sum((e->>'targetWeightBps')::integer) into bps from jsonb_array_elements(vlegs) e;
      if bps is distinct from 10000 then raise exception 'vault legs must total 10000 bps for %', def->>'indexId'; end if;
    end if;
    -- Transaction-derived books never carry weights.
    if def->>'weightBasis' = 'none-txn-derived' and jsonb_array_length(coalesce(def->'legs','[]'::jsonb)) > 0 then
      raise exception 'txn-derived book cannot carry legs for %', def->>'indexId';
    end if;

    h := md5(def::text);
    seen := array_append(seen, def->>'indexId');

    insert into insiderindex_vault_definitions as t (
      index_id, person_slug, bioguide_id, network, name, symbol, weight_basis, status,
      structurally_creatable, blocked_reasons, book_source, provenance, native_token_cap,
      host_entry_fee_bps, host_exit_fee_bps, legs, vault_legs, pool_excluded_legs, unmapped,
      coverage, cost, keeper, source_zip, source_sha256, definition_hash
    ) values (
      def->>'indexId', def->>'personSlug', def->>'bioguideId', coalesce(def->>'network','mainnet-beta'),
      def->>'name', def->>'symbol', def->>'weightBasis', def->>'status',
      (def->>'structurallyCreatable')::boolean, coalesce(def->'blockedReasons','[]'::jsonb), def->>'bookSource',
      coalesce(def->'provenance','{}'::jsonb), coalesce((def->>'nativeTokenCap')::integer, 100), 25, 0,
      coalesce(def->'legs','[]'::jsonb), vlegs, coalesce(def->'poolExcludedLegs','[]'::jsonb),
      coalesce(def->'unmapped','[]'::jsonb), coalesce(def->'coverage','{}'::jsonb), def->'cost',
      coalesce(def->'keeper','{}'::jsonb), d->'source'->>'zip', d->'source'->>'sha256', h
    )
    on conflict (index_id) do update set
      person_slug = excluded.person_slug, bioguide_id = excluded.bioguide_id, network = excluded.network,
      name = excluded.name, symbol = excluded.symbol, weight_basis = excluded.weight_basis, status = excluded.status,
      structurally_creatable = excluded.structurally_creatable, blocked_reasons = excluded.blocked_reasons,
      book_source = excluded.book_source, provenance = excluded.provenance, native_token_cap = excluded.native_token_cap,
      legs = excluded.legs, vault_legs = excluded.vault_legs, pool_excluded_legs = excluded.pool_excluded_legs,
      unmapped = excluded.unmapped, coverage = excluded.coverage, cost = excluded.cost, keeper = excluded.keeper,
      source_zip = excluded.source_zip, source_sha256 = excluded.source_sha256,
      definition_hash = excluded.definition_hash,
      definition_version = case when t.definition_hash is distinct from excluded.definition_hash
        then t.definition_version + 1 else t.definition_version end,
      updated_at = case when t.definition_hash is distinct from excluded.definition_hash then now() else t.updated_at end
    where t.definition_hash is distinct from excluded.definition_hash;

    if found then changed := changed + 1; end if;
  end loop;

  return jsonb_build_object('total', total, 'changed', changed, 'indexIds', to_jsonb(seen));
end $$;

revoke all on function public.publish_insiderindex_vault_definitions(text) from public, anon, authenticated;
grant execute on function public.publish_insiderindex_vault_definitions(text) to service_role;

-- Keeper read: targets + eligibility inputs for one vault (or all). Never exposes raw books.
create function public.read_insiderindex_vault_definition(p_index_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when count(*) = 0 then null else jsonb_build_object(
    'indexId', index_id, 'personSlug', person_slug, 'network', network, 'name', name, 'symbol', symbol,
    'status', status, 'weightBasis', weight_basis, 'nativeTokenCap', native_token_cap,
    'bookSource', book_source, 'provenance', provenance,
    'hostEntryFeeBps', host_entry_fee_bps, 'hostExitFeeBps', host_exit_fee_bps,
    'vaultAddress', vault_address, 'shareMint', share_mint, 'vaultLegs', vault_legs, 'keeper', keeper,
    'lastRebalanceAt', last_rebalance_at, 'lastRebalanceResult', last_rebalance_result,
    'definitionVersion', definition_version, 'sourceSha256', source_sha256
  ) end
  from insiderindex_vault_definitions where index_id = p_index_id
$$;
revoke all on function public.read_insiderindex_vault_definition(text) from public, anon, authenticated;
grant execute on function public.read_insiderindex_vault_definition(text) to service_role;

create function public.read_insiderindex_vault_definitions() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'indexId', index_id, 'personSlug', person_slug, 'name', name, 'symbol', symbol, 'status', status,
    'weightBasis', weight_basis, 'structurallyCreatable', structurally_creatable, 'blockedReasons', blocked_reasons,
    'coverage', coverage, 'vaultAddress', vault_address, 'shareMint', share_mint,
    'definitionVersion', definition_version, 'sourceSha256', source_sha256, 'updatedAt', updated_at
  ) order by index_id), '[]'::jsonb)
  from insiderindex_vault_definitions
$$;
revoke all on function public.read_insiderindex_vault_definitions() from public, anon, authenticated;
grant execute on function public.read_insiderindex_vault_definitions() to service_role;

commit;
