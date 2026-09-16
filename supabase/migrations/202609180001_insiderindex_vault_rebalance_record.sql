-- Keeper write-back: record the outcome of one keeper tick onto its definition row so the site and
-- any later automation read one source of truth. The keeper reads targets/eligibility from this
-- table (migrations 202609160001 / 202609170001); this adds the single write it needs.
--
--   * last_rebalance_at   = the time of the tick (dry run or real).
--   * last_rebalance_result = the recorded outcome jsonb. A dry run records mode:"dry-run" and never
--     claims a rebalance happened; only a broadcast execute tick records a rebalance with signatures.
--
-- service_role holds only SELECT on the base table, so the write goes through this security-definer
-- RPC. It refuses an unknown index and refuses a row with no created vault yet (vault_address unset):
-- there is nothing to have rebalanced. The definition, legs, weights and provenance are untouched.
begin;

create or replace function public.record_insiderindex_vault_rebalance(p_index_id text, p_result text)
  returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb := p_result::jsonb;
  ts timestamptz := now();
begin
  if p_index_id is null then raise exception 'index id required'; end if;
  if jsonb_typeof(r) is distinct from 'object' then raise exception 'result object required'; end if;
  if r->>'mode' not in ('dry-run','execute') then raise exception 'result mode must be dry-run or execute'; end if;

  update insiderindex_vault_definitions
    set last_rebalance_at = ts, last_rebalance_result = r
    where index_id = p_index_id and vault_address is not null;

  if not found then
    raise exception 'no created InsiderIndex vault for % (unknown index or vault_address unset)', p_index_id;
  end if;

  return jsonb_build_object('indexId', p_index_id, 'recordedAt', ts, 'mode', r->>'mode');
end $$;

revoke all on function public.record_insiderindex_vault_rebalance(text, text) from public, anon, authenticated;
grant execute on function public.record_insiderindex_vault_rebalance(text, text) to service_role;

commit;
