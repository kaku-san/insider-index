-- General admin creation of any persisted InsiderIndex vault (not only the fixed Kaku San basket).
-- Runs AFTER the deposits migration (202609170001), so it re-creates read_insiderindex_vault_definition
-- as a SUPERSET: every field the deposits migration returns (kind, depositsEnabled/depositReason, ...)
-- PLUS the coverage, pool-excluded legs, mapped legs, structural-creatability and blocked reasons the
-- create screen must show the operator BEFORE they sign — catalog coverage vs tradable (pool-ready)
-- coverage, and every leg with no tradable pool called out. No silent re-weighting: the numbers are
-- read live from the definition record.
-- Also adds set_insiderindex_vault_address: it writes the captain-authorised creation back onto the
-- record (one source of truth for the keeper + the site). Idempotent; refuses to clobber a different
-- already-recorded vault. Creating a vault never opens deposits; this migration touches no deposit/
-- release flag (the deposits migration + application code stay authoritative).
begin;

alter table public.insiderindex_vault_definitions
  add column if not exists vault_created_at timestamptz,
  add column if not exists creation_receipt jsonb;

-- Superset of the deposits-migration read: keeps kind + deposit gate, adds coverage + pool-excluded
-- legs + mapped legs + creatability + creation receipt for the pre-sign preview (one source of truth).
create or replace function public.read_insiderindex_vault_definition(p_index_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'indexId', index_id, 'kind', kind, 'personSlug', person_slug, 'network', network, 'name', name, 'symbol', symbol,
    'status', status, 'weightBasis', weight_basis, 'nativeTokenCap', native_token_cap,
    'structurallyCreatable', structurally_creatable, 'blockedReasons', blocked_reasons,
    'depositsEnabled', deposits_enabled, 'depositReason', deposit_reason,
    'bookSource', book_source, 'provenance', provenance,
    'hostEntryFeeBps', host_entry_fee_bps, 'hostExitFeeBps', host_exit_fee_bps,
    'legs', legs, 'vaultLegs', vault_legs, 'poolExcludedLegs', pool_excluded_legs,
    'coverage', coverage, 'keeper', keeper,
    'vaultAddress', vault_address, 'shareMint', share_mint,
    'vaultCreatedAt', vault_created_at, 'creationReceipt', creation_receipt,
    'lastRebalanceAt', last_rebalance_at, 'lastRebalanceResult', last_rebalance_result,
    'definitionVersion', definition_version, 'sourceSha256', source_sha256
  )
  from insiderindex_vault_definitions where index_id = p_index_id
$$;
revoke all on function public.read_insiderindex_vault_definition(text) from public, anon, authenticated;
grant execute on function public.read_insiderindex_vault_definition(text) to service_role;

-- Write back the created vault address + share mint + creation receipt. Idempotent: a re-run with the
-- same vault_address is a no-op update; a different vault_address on an already-recorded index is
-- refused so a created vault is never abandoned by overwrite. Only a CREATABLE definition may be set.
create function public.set_insiderindex_vault_address(
  p_index_id text, p_vault_address text, p_share_mint text, p_receipt jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  existing text;
  existing_mint text;
  st text;
begin
  if p_index_id is null or p_vault_address is null or p_share_mint is null then
    raise exception 'index id, vault address and share mint required';
  end if;
  select vault_address, share_mint, status into existing, existing_mint, st
    from insiderindex_vault_definitions where index_id = p_index_id;
  if not found then raise exception 'no such index definition %', p_index_id; end if;
  if st is distinct from 'CREATABLE' then raise exception 'index % is % (not CREATABLE); cannot record a vault', p_index_id, st; end if;
  if existing is not null and existing is distinct from p_vault_address then
    raise exception 'index % already has vault %; refusing to overwrite with %', p_index_id, existing, p_vault_address;
  end if;
  if existing_mint is not null and existing_mint is distinct from p_share_mint then
    raise exception 'index % already has share mint %; refusing to overwrite', p_index_id, existing_mint;
  end if;
  update insiderindex_vault_definitions set
    vault_address = p_vault_address,
    share_mint = p_share_mint,
    vault_created_at = coalesce(vault_created_at, now()),
    creation_receipt = coalesce(p_receipt, '{}'::jsonb),
    updated_at = now()
  where index_id = p_index_id;
  return jsonb_build_object('indexId', p_index_id, 'vaultAddress', p_vault_address, 'shareMint', p_share_mint);
end $$;
revoke all on function public.set_insiderindex_vault_address(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_insiderindex_vault_address(text, text, text, jsonb) to service_role;

commit;
