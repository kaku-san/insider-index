-- Apply with Supabase SQL editor or `supabase db push`. No browser writes/raw reads.
begin;
create table public.raw_batches (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  endpoint text not null, params jsonb not null,
  fetched_at timestamptz not null, payload_hash text not null,
  row_count integer not null check (row_count >= 0), http_status integer not null,
  body text not null,
  check (payload_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')),
  check (not (params ?| array['apikey', 'api_key']))
);
create index raw_batches_payload on public.raw_batches(payload_hash);
create table public.people (
  id text primary key check (id ~ '^[A-Z][0-9]{6}$'), payload jsonb not null,
  portfolio jsonb, book_state text not null default 'not-ingested',
  saved_at timestamptz, index_hash text, last_ingestion jsonb, last_ingested_at timestamptz
);
create table public.fmp_store_state (id text primary key, payload jsonb not null, saved_at timestamptz not null default now());
create table public.source_documents (
  id text primary key, person_id text not null references public.people(id),
  source_url text, filing_date date, period date, payload jsonb not null
);
create table public.book_snapshots (
  id text primary key, person_id text not null references public.people(id),
  document_id text not null references public.source_documents(id),
  complete boolean not null, period date, payload jsonb not null, saved_at timestamptz not null default now(),
  unique(id, person_id), check (not complete or (period is not null and payload->>'partial' = 'false' and payload->'issues' = '[]'::jsonb))
);
create table public.disclosed_items (
  snapshot_id text not null references public.book_snapshots(id), item_id text not null,
  kind text not null, ticker text, amount_low numeric, amount_high numeric,
  payload jsonb not null, primary key(snapshot_id, item_id)
);
create table public.transactions (
  id text primary key, person_id text not null references public.people(id),
  transaction_date date, disclosure_date date, amount_low numeric, amount_high numeric,
  payload jsonb not null, saved_at timestamptz not null default now()
);
create table public.index_versions (
  hash text primary key check (hash ~ '^[a-f0-9]{64}$'),
  person_id text not null references public.people(id), snapshot_id text not null,
  period date not null, version bigint not null check (version > 0),
  status text not null check (status in ('CANDIDATE','BLOCKED','POLICY_VALID')),
  source_disclosure_hash text not null,
  definition jsonb not null, document_text text not null,
  unique(person_id,version),
  published_at timestamptz not null default now(),
  foreign key(snapshot_id, person_id) references public.book_snapshots(id, person_id),
  check (definition = document_text::jsonb),
  check (hash = encode(sha256(convert_to(document_text, 'UTF8')), 'hex'))
);
create index index_versions_person_period on public.index_versions(person_id, period desc, published_at desc);
create table public.constituents (
  index_hash text not null references public.index_versions(hash), mint text not null,
  ticker text not null, issuer text not null check (issuer in ('xstock', 'backpack')),
  weight_bps integer not null check (weight_bps > 0 and weight_bps <= 10000), payload jsonb not null,
  primary key(index_hash, mint), check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
alter table public.people add foreign key(index_hash) references public.index_versions(hash);

-- Only service-role server requests can access these tables; anon/authenticated cannot read raw payloads.
do $$ declare t text; begin
  foreach t in array array['raw_batches','people','fmp_store_state','source_documents','book_snapshots','disclosed_items','transactions','index_versions','constituents'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end $$;
grant insert on public.raw_batches to service_role;
-- Immutability and atomicity: only the RPC owner writes normalized books and publications.
revoke insert, update, delete, truncate on public.people, public.fmp_store_state, public.source_documents,
  public.book_snapshots, public.disclosed_items, public.transactions, public.index_versions, public.constituents from service_role;

create function public.save_fmp_directory(p_directory jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare p jsonb;
begin
  for p in select * from jsonb_array_elements(p_directory->'people') loop
    insert into people(id, payload) values(p->>'id', p)
    on conflict(id) do update set payload = excluded.payload;
  end loop;
  insert into fmp_store_state(id,payload) values('directory', p_directory - 'people')
  on conflict(id) do update set payload = excluded.payload, saved_at = now();
end $$;

create function public.save_fmp_portfolio(p_portfolio jsonb, p_snapshots jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb; i jsonb; st jsonb; pg jsonb; doc_id text; pid text := p_portfolio->'person'->>'id';
begin
  -- Every successfully fetched source page must already be durably captured. Failed fetches may have no page.
  for st in select value from jsonb_each(p_portfolio->'ingestion') loop
    for pg in select * from jsonb_array_elements(st->'pages') loop
      if not exists(select 1 from raw_batches r where r.payload_hash = pg->>'payloadHash'
        and r.endpoint = pg->>'endpoint' and r.params = pg->'params' and r.fetched_at = (pg->>'fetchedAt')::timestamptz) then
        raise exception 'missing raw batch';
      end if;
    end loop;
  end loop;
  insert into people(id,payload,portfolio,book_state,saved_at,last_ingestion,last_ingested_at)
  values(pid,p_portfolio->'person',p_portfolio,p_portfolio->>'state',now(),
    jsonb_build_object('state',p_portfolio->'state','partial',p_portfolio->'partial','ingestion',p_portfolio->'ingestion'),now())
  on conflict(id) do update set payload=excluded.payload,
    portfolio=case when people.portfolio->'indexInput'->>'snapshotId' is not null
      and p_portfolio->'indexInput'->>'snapshotId' is null then excluded.portfolio || jsonb_build_object(
        'snapshots',people.portfolio->'snapshots','indexInput',people.portfolio->'indexInput',
        'bookComplete',people.portfolio->'bookComplete','state',people.book_state,'complete',false,'partial',true)
      else excluded.portfolio end,
    book_state=case when people.portfolio->'indexInput'->>'snapshotId' is not null
      and p_portfolio->'indexInput'->>'snapshotId' is null then people.book_state else excluded.book_state end,
    saved_at=case when people.portfolio->'indexInput'->>'snapshotId' is not null
      and p_portfolio->'indexInput'->>'snapshotId' is null then people.saved_at else excluded.saved_at end,
    last_ingestion=excluded.last_ingestion,last_ingested_at=excluded.last_ingested_at;
  for st in select * from jsonb_array_elements(p_snapshots) loop
    s := st->'payload';
    doc_id := encode(sha256(convert_to(s->>'id','UTF8')), 'hex');
    insert into source_documents(id,person_id,source_url,filing_date,period,payload)
      values(doc_id,pid,s->>'sourceUrl',(s->>'filingDate')::date,(s->>'referenceDate')::date,
        s - array['items','stocks','etfs','options','income','liabilities','other']) on conflict do nothing;
    insert into book_snapshots(id,person_id,document_id,complete,period,payload)
      values(st->>'id',pid,doc_id,(s->>'complete')::boolean,(s->>'referenceDate')::date,s) on conflict do nothing;
    for i in select * from jsonb_array_elements(s->'items') loop
      insert into disclosed_items(snapshot_id,item_id,kind,ticker,amount_low,amount_high,payload)
        values(st->>'id',i->>'id',i->>'kind',i->>'ticker',(i->'valueRange'->>'low')::numeric,(i->'valueRange'->>'high')::numeric,i)
        on conflict do nothing;
    end loop;
  end loop;
  for i in select * from jsonb_array_elements(p_portfolio->'activity') loop
    insert into transactions(id,person_id,transaction_date,disclosure_date,amount_low,amount_high,payload)
      values(i->>'id',pid,(i->>'transactionDate')::date,(i->>'disclosureDate')::date,
        (i->'amount'->>'low')::numeric,(i->'amount'->>'high')::numeric,i) on conflict do nothing;
  end loop;
end $$;

create function public.publish_fmp_index(p_hash text, p_document text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d jsonb := p_document::jsonb; c jsonb; s book_snapshots; total integer; next_version bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(d->>'personId',0));
  select * into s from book_snapshots where id=d->>'snapshotId' and person_id=d->>'personId';
  if not found or not s.complete or s.period <> (d->>'period')::date then raise exception 'complete saved annual snapshot required'; end if;
  if d->>'schemaVersion' is distinct from '1' or d->>'methodology' is distinct from 'annual-eligible-value-v1'
    or d->>'status' is distinct from 'CANDIDATE' or d->>'sourceDisclosureHash' is distinct from s.id
    or jsonb_typeof(d->'assets') is distinct from 'array' or jsonb_array_length(d->'assets') = 0 then
    raise exception 'invalid index definition';
  end if;
  select sum((value->>'targetWeightBps')::integer) into total from jsonb_array_elements(d->'assets');
  if total is distinct from 10000 then raise exception 'weights must total 10000'; end if;
  -- Hash and foreign keys bind the entire exclusion/mint/weight document to its annual snapshot.
  select coalesce(max(version),0)+1 into next_version from index_versions where person_id=s.person_id;
  insert into index_versions(hash,person_id,snapshot_id,period,version,status,source_disclosure_hash,definition,document_text)
    values(p_hash,d->>'personId',s.id,s.period,next_version,'CANDIDATE',s.id,d,p_document) on conflict do nothing;
  if (select count(*) <> count(distinct value->>'mint') from jsonb_array_elements(d->'assets')) then raise exception 'duplicate constituent mint'; end if;
  for c in select * from jsonb_array_elements(d->'assets') loop
    if (c->>'targetWeightBps')::numeric <> trunc((c->>'targetWeightBps')::numeric)
      or jsonb_typeof(c->'sourceItemIds') is distinct from 'array' or jsonb_array_length(c->'sourceItemIds')=0
      or (c->>'sizingValue')::numeric <= 0 then raise exception 'invalid asset sizing or evidence'; end if;
    if exists(select 1 from jsonb_array_elements_text(c->'sourceItemIds') item_id where not exists(
      select 1 from disclosed_items i where i.snapshot_id=s.id and i.item_id=item_id.value
      and i.kind in ('stock','etf') and i.ticker=c->>'ticker'
      and i.payload->'token'->>'mint'=c->>'mint'
      and i.payload->'token'->'decimals'=c->'decimals'
      and i.payload->'token'->>'issuer'=case c->>'provider' when 'xstocks' then 'xstock' else c->>'provider' end
    )) then raise exception 'constituent lacks saved catalog and disclosed symbol evidence'; end if;
    insert into constituents(index_hash,mint,ticker,issuer,weight_bps,payload)
      values(p_hash,c->>'mint',c->>'ticker',case c->>'provider' when 'xstocks' then 'xstock' else c->>'provider' end,(c->>'targetWeightBps')::integer,c) on conflict do nothing;
  end loop;
  update people set index_hash = (select hash from index_versions where person_id=s.person_id order by period desc,published_at desc,hash asc limit 1) where id=s.person_id;
end $$;
revoke all on function public.save_fmp_directory(jsonb), public.save_fmp_portfolio(jsonb,jsonb), public.publish_fmp_index(text,text) from public, anon, authenticated;
grant execute on function public.save_fmp_directory(jsonb), public.save_fmp_portfolio(jsonb,jsonb), public.publish_fmp_index(text,text) to service_role;
commit;
