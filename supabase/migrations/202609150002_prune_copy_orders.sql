begin;
create function public.prune_expired_copy_orders()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from public.copy_orders as candidate
  where candidate.expires_at < now() - interval '5 minutes'
    and not exists (
      select 1 from public.positions
      where positions.request_id = candidate.request_id
    );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
revoke all on function public.prune_expired_copy_orders() from public, anon, authenticated;
grant execute on function public.prune_expired_copy_orders() to service_role;
commit;
