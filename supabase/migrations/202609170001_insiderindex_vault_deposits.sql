-- All 20 published indexes become first-class vault candidates: the 10 person books plus the 10
-- constructed multi-member thematic research baskets, all in one row shape. Two truths are added:
--   * `kind` distinguishes a person's disclosed annual book from a thematic basket, so a thematic
--     row can never read as a person index even though `person_slug` is reused for the identity slug.
--   * an explicit per-vault deposit gate (`deposits_enabled` / `deposit_reason`), CLOSED BY DEFAULT
--     and driven by tradable coverage, never by creation. Creating a vault is cheap and ungated; a
--     deposit is only honest when every mapped leg has an observed tradable pool (else weight lands
--     where it cannot be rebalanced or exited to USDC). The global publicFundsEnabled release flag
--     stays authoritative on top of this column and is enforced in application code.
begin;

alter table public.insiderindex_vault_definitions
  add column if not exists kind text not null default 'person' check (kind in ('person','thematic')),
  add column if not exists deposits_enabled boolean not null default false,
  add column if not exists deposit_reason text;

comment on column public.insiderindex_vault_definitions.kind is 'person = one disclosed annual book; thematic = constructed multi-member research basket.';
comment on column public.insiderindex_vault_definitions.deposits_enabled is 'Per-vault deposit gate. Closed by default; driven by tradable coverage, never by creation. Release flag is authoritative on top in app code.';

create or replace function public.publish_insiderindex_vault_definitions(p_document text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d jsonb := p_document::jsonb;
  def jsonb;
  h text;
  vlegs jsonb;
  bps integer;
  dep_enabled boolean;
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
    -- Deposit gate: closed unless the vault is creatable with a full pool-ready composition. This is
    -- the server's honesty guard; the release flag governs whether deposits actually go live.
    dep_enabled := coalesce((def->'deposits'->>'enabled')::boolean, false);
    if dep_enabled and (def->>'status' is distinct from 'CREATABLE' or jsonb_array_length(vlegs) = 0) then
      raise exception 'deposits cannot be enabled for % without a creatable, fully pool-ready composition', def->>'indexId';
    end if;

    h := md5(def::text);
    seen := array_append(seen, def->>'indexId');

    insert into insiderindex_vault_definitions as t (
      index_id, kind, person_slug, bioguide_id, network, name, symbol, weight_basis, status,
      structurally_creatable, blocked_reasons, deposits_enabled, deposit_reason, book_source, provenance,
      native_token_cap, host_entry_fee_bps, host_exit_fee_bps, legs, vault_legs, pool_excluded_legs,
      unmapped, coverage, cost, keeper, source_zip, source_sha256, definition_hash
    ) values (
      def->>'indexId', coalesce(def->>'kind','person'), def->>'personSlug', def->>'bioguideId', coalesce(def->>'network','mainnet-beta'),
      def->>'name', def->>'symbol', def->>'weightBasis', def->>'status',
      (def->>'structurallyCreatable')::boolean, coalesce(def->'blockedReasons','[]'::jsonb),
      dep_enabled, def->'deposits'->>'reason', def->>'bookSource',
      coalesce(def->'provenance','{}'::jsonb), coalesce((def->>'nativeTokenCap')::integer, 100), 25, 0,
      coalesce(def->'legs','[]'::jsonb), vlegs, coalesce(def->'poolExcludedLegs','[]'::jsonb),
      coalesce(def->'unmapped','[]'::jsonb), coalesce(def->'coverage','{}'::jsonb), def->'cost',
      coalesce(def->'keeper','{}'::jsonb), d->'source'->>'zip', d->'source'->>'sha256', h
    )
    on conflict (index_id) do update set
      kind = excluded.kind, person_slug = excluded.person_slug, bioguide_id = excluded.bioguide_id, network = excluded.network,
      name = excluded.name, symbol = excluded.symbol, weight_basis = excluded.weight_basis, status = excluded.status,
      structurally_creatable = excluded.structurally_creatable, blocked_reasons = excluded.blocked_reasons,
      deposits_enabled = excluded.deposits_enabled, deposit_reason = excluded.deposit_reason,
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

-- Single-row read by primary key: a plain projection over the at-most-one matching row (returns
-- NULL when none). No count(*)/bare-column mix (that is a GROUP BY error).
create or replace function public.read_insiderindex_vault_definition(p_index_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'indexId', index_id, 'kind', kind, 'personSlug', person_slug, 'network', network, 'name', name, 'symbol', symbol,
    'status', status, 'weightBasis', weight_basis, 'nativeTokenCap', native_token_cap,
    'depositsEnabled', deposits_enabled, 'depositReason', deposit_reason,
    'bookSource', book_source, 'provenance', provenance,
    'hostEntryFeeBps', host_entry_fee_bps, 'hostExitFeeBps', host_exit_fee_bps,
    'vaultAddress', vault_address, 'shareMint', share_mint, 'vaultLegs', vault_legs, 'keeper', keeper,
    'lastRebalanceAt', last_rebalance_at, 'lastRebalanceResult', last_rebalance_result,
    'definitionVersion', definition_version, 'sourceSha256', source_sha256
  )
  from insiderindex_vault_definitions where index_id = p_index_id
$$;
revoke all on function public.read_insiderindex_vault_definition(text) from public, anon, authenticated;
grant execute on function public.read_insiderindex_vault_definition(text) to service_role;

create or replace function public.read_insiderindex_vault_definitions() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'indexId', index_id, 'kind', kind, 'personSlug', person_slug, 'name', name, 'symbol', symbol, 'status', status,
    'weightBasis', weight_basis, 'structurallyCreatable', structurally_creatable, 'blockedReasons', blocked_reasons,
    'depositsEnabled', deposits_enabled, 'depositReason', deposit_reason,
    'coverage', coverage, 'vaultAddress', vault_address, 'shareMint', share_mint,
    'definitionVersion', definition_version, 'sourceSha256', source_sha256, 'updatedAt', updated_at
  ) order by index_id), '[]'::jsonb)
  from insiderindex_vault_definitions
$$;
revoke all on function public.read_insiderindex_vault_definitions() from public, anon, authenticated;
grant execute on function public.read_insiderindex_vault_definitions() to service_role;

commit;
