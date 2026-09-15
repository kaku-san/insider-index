-- Durable top-20 politician profiles ranked from saved FMP annual band midpoints.
-- Derived snapshot only: never rewrites books, indexes, or raw FMP rows. No invented net-worth/YoY/S&P.
begin;
create table public.top_politician_profiles (
  list_order integer primary key check (list_order between 1 and 20),
  person_id text not null unique references public.people(id),
  rank integer not null check (rank > 0),
  pinned boolean not null default false,
  estimated_midpoint numeric,
  payload jsonb not null,
  published_at timestamptz not null default now(),
  check (payload->'person'->>'id' = person_id),
  check (jsonb_typeof(payload->'netWorth') = 'null'),
  check (jsonb_typeof(payload->'yearOverYearReturn') = 'null'),
  check (jsonb_typeof(payload->'sp500Overlay') = 'null')
);
comment on table public.top_politician_profiles is 'Persisted top-20 FMP politician profiles from disclosed holding-band midpoints. Not net worth, YoY, or S&P performance.';

alter table public.top_politician_profiles enable row level security;
revoke all on public.top_politician_profiles from public, anon, authenticated, service_role;
grant select on public.top_politician_profiles to service_role;

create or replace function public.publish_top_politician_profiles(p_document text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d jsonb := p_document::jsonb;
  p jsonb;
  n integer;
  expected integer := 0;
  pid text;
begin
  if d->>'source' is distinct from 'fmp'
    or d->>'methodology' is distinct from 'holding-band-midpoints'
    or jsonb_typeof(d->'profiles') is distinct from 'array' then
    raise exception 'invalid top profiles document';
  end if;
  n := jsonb_array_length(d->'profiles');
  if n > 20 then raise exception 'too many profiles'; end if;
  if (d->>'listed')::integer is distinct from n then raise exception 'listed count mismatch'; end if;
  if jsonb_typeof(d->'netWorth') is distinct from 'null'
    or jsonb_typeof(d->'yearOverYearReturn') is distinct from 'null'
    or jsonb_typeof(d->'sp500Overlay') is distinct from 'null' then
    raise exception 'invented series not allowed';
  end if;
  if coalesce(d->>'netWorthReason','') = ''
    or coalesce(d->>'yearOverYearReturnReason','') = ''
    or coalesce(d->>'sp500OverlayReason','') = '' then
    raise exception 'omitted series require a reason';
  end if;
  if not exists(
      select 1 from jsonb_array_elements(d->'profiles') e where e->'person'->>'id'='P000197'
    ) then
    raise exception 'pelosi-required';
  end if;

  delete from top_politician_profiles;
  for p in select value from jsonb_array_elements(d->'profiles') loop
    expected := expected + 1;
    pid := p->'person'->>'id';
    if (p->>'listOrder')::integer is distinct from expected then raise exception 'list order must be contiguous'; end if;
    if pid is null or not exists(select 1 from people where id=pid) then raise exception 'unknown person'; end if;
    if (p->>'rank')::integer is null or (p->>'rank')::integer < 1 then raise exception 'invalid rank'; end if;
    if jsonb_typeof(p->'netWorth') is distinct from 'null'
      or jsonb_typeof(p->'yearOverYearReturn') is distinct from 'null'
      or jsonb_typeof(p->'sp500Overlay') is distinct from 'null' then
      raise exception 'invented series not allowed';
    end if;
    insert into top_politician_profiles(list_order, person_id, rank, pinned, estimated_midpoint, payload)
    values (
      expected,
      pid,
      (p->>'rank')::integer,
      pid = 'P000197' or coalesce((p->>'pinned')::boolean, false),
      case when jsonb_typeof(p->'estimatedValue'->'midpoint') = 'number'
        then (p->'estimatedValue'->>'midpoint')::numeric end,
      p
    );
  end loop;

  insert into fmp_store_state(id, payload, saved_at)
  values ('top-politician-profiles', d - 'profiles', now())
  on conflict (id) do update set payload = excluded.payload, saved_at = now();
end $$;

revoke all on function public.publish_top_politician_profiles(text) from public, anon, authenticated;
grant execute on function public.publish_top_politician_profiles(text) to service_role;

create function public.read_top_politician_profiles() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with publication as (
    select payload, saved_at, true as published
    from fmp_store_state
    where id = 'top-politician-profiles'
    union all
    select '{}'::jsonb, null::timestamptz, false
    where not exists(select 1 from fmp_store_state where id = 'top-politician-profiles')
  ), profiles as (
    select
      coalesce(jsonb_agg(payload order by list_order), '[]'::jsonb) as payload,
      count(*)::integer as listed,
      coalesce(bool_or(person_id = 'P000197'), false) as pelosi_pinned
    from top_politician_profiles
  )
  select jsonb_build_object(
    'source', 'fmp',
    'storage', 'supabase',
    'methodology', 'holding-band-midpoints',
    'universeSize', coalesce((publication.payload->>'universeSize')::integer, 0),
    'listed', profiles.listed,
    'pelosiPinned', profiles.pelosi_pinned,
    'published', publication.published or profiles.listed > 0,
    'savedAt', publication.saved_at,
    'stale', publication.saved_at is not null and exists(
      select 1 from book_snapshots where saved_at > publication.saved_at
    ),
    'profiles', profiles.payload,
    'netWorth', null,
    'netWorthReason', coalesce(publication.payload->>'netWorthReason', 'no-verified-net-worth-series'),
    'yearOverYearReturn', null,
    'yearOverYearReturnReason', coalesce(publication.payload->>'yearOverYearReturnReason', 'no-dated-holdings-price-series'),
    'sp500Overlay', null,
    'sp500OverlayReason', coalesce(publication.payload->>'sp500OverlayReason', 'no-benchmark-series')
  )
  from publication cross join profiles
$$;

revoke all on function public.read_top_politician_profiles() from public, anon, authenticated;
grant execute on function public.read_top_politician_profiles() to service_role;
commit;
