-- NAV vault tradable slices (captain decision B, 2026-09-23). The DISCLOSED book in
-- insiderindex_vault_definitions is never rewritten: this separate table records, per index, the leg set
-- the on-chain NAV vault actually holds (tradable legs, renormalized weights, <= 25) plus every excluded
-- disclosed name with its reason, and the vault identity. Source: scripts/nav-vault-slices.mts
-- (src/lib/nav-vault/tradable-slices.json); published by `npm run nav-vault -- slices --publish`.
begin;

create table if not exists public.insiderindex_nav_vault_slices (
  index_id text primary key,
  vault_address text,
  share_mint text,
  total_legs integer not null check (total_legs >= 0),
  tradable_legs integer not null check (tradable_legs between 0 and 25),
  disclosed_weight_bps integer not null check (disclosed_weight_bps between 0 and 10000),
  vault_legs jsonb not null,
  excluded jsonb not null,
  criteria jsonb not null,
  generated_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.insiderindex_nav_vault_slices enable row level security;
revoke all on public.insiderindex_nav_vault_slices from public, anon, authenticated, service_role;
grant select on public.insiderindex_nav_vault_slices to service_role;

create or replace function public.publish_insiderindex_nav_vault_slices(p_document text)
  returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  doc jsonb := p_document::jsonb;
  s jsonb;
  n integer := 0;
begin
  if jsonb_typeof(doc->'slices') is distinct from 'array' then raise exception 'slices array required'; end if;
  for s in select * from jsonb_array_elements(doc->'slices') loop
    insert into insiderindex_nav_vault_slices as t (index_id, vault_address, share_mint, total_legs, tradable_legs, disclosed_weight_bps, vault_legs, excluded, criteria, generated_at, updated_at)
    values (s->>'indexId', s->>'vaultAddress', s->>'shareMint', (s->>'totalLegs')::int, (s->>'tradableLegs')::int, (s->>'disclosedWeightBps')::int,
            coalesce(s->'vaultLegs', '[]'::jsonb), coalesce(s->'excluded', '[]'::jsonb), coalesce(doc->'criteria', '{}'::jsonb), (doc->>'generatedAt')::timestamptz, now())
    on conflict (index_id) do update set
      vault_address = coalesce(excluded.vault_address, t.vault_address), share_mint = coalesce(excluded.share_mint, t.share_mint),
      total_legs = excluded.total_legs, tradable_legs = excluded.tradable_legs, disclosed_weight_bps = excluded.disclosed_weight_bps,
      vault_legs = excluded.vault_legs, excluded = excluded.excluded, criteria = excluded.criteria, generated_at = excluded.generated_at, updated_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('published', n);
end $$;

create or replace function public.read_insiderindex_nav_vault_slice(p_index_id text)
  returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(t) from insiderindex_nav_vault_slices t where t.index_id = p_index_id;
$$;

revoke all on function public.publish_insiderindex_nav_vault_slices(text) from public, anon, authenticated;
grant execute on function public.publish_insiderindex_nav_vault_slices(text) to service_role;
revoke all on function public.read_insiderindex_nav_vault_slice(text) from public, anon, authenticated;
grant execute on function public.read_insiderindex_nav_vault_slice(text) to service_role;

commit;
