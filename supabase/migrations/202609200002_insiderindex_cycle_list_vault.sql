-- List incomplete Mag7 (and other) cycle journals for a vault so the external keeper can
-- tick per-wallet depositors. Service-role only. Does not authorize spending.
begin;
create function public.list_insiderindex_cycles_for_vault(p_vault text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object(
   'operationId', operation_id,
   'owner', owner,
   'complete', complete
 ) order by created_at), '[]'::jsonb)
 from insiderindex_cycle_operations
 where vault = p_vault and not complete
$$;
revoke all on function public.list_insiderindex_cycles_for_vault(text) from public, anon, authenticated;
grant execute on function public.list_insiderindex_cycles_for_vault(text) to service_role;
commit;
