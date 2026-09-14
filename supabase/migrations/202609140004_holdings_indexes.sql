-- Owner-applied migration. Retains raw FMP rows, books, transactions and immutable definitions.
-- Trade-only versions are historical, not the live product. No browser or direct service writes.
begin;
create or replace function public.fmp_holding_name(n text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select trim(regexp_replace(regexp_replace(regexp_replace(lower(replace(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(n,''), '^.*⇒', ''), '\[(ST|EF)\]', '', 'gi'), '\([A-Z][A-Z0-9.-]{0,14}\)', '', 'g'), '\mcommon stock\M', '', 'gi'), '&', ' and ')),
    '[^a-z0-9 ]', ' ', 'g'), '\m(incorporated|inc|corporation|corp|limited|ltd|company|co)\M', ' ', 'g'), '\s+', ' ', 'g'))
$$;

create or replace function public.fmp_matches_holding(n text, candidate text, symbol text) returns boolean
language plpgsql immutable set search_path = public, pg_temp as $$
declare hints text[]; hint text; normalized text := fmp_holding_name(n); other text := fmp_holding_name(candidate);
begin
  select array_agg(m[1]) into hints from regexp_matches(coalesce(n,''), '\(([A-Z][A-Z0-9.-]{0,14})\)', 'g') m;
  if cardinality(hints)=1 then hint := replace(hints[1],'-','.'); end if;
  if hint is not null and hint <> replace(symbol,'-','.') then return false; end if;
  return normalized <> '' and (normalized=other or (hint is not null and
    trim(regexp_replace(regexp_replace(normalized, '\m(class|series) [a-z0-9]+\M', '', 'g'), '\s+', ' ', 'g'))=other));
end $$;

create or replace function public.publish_fmp_holdings_index(p_hash text, p_document text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d jsonb := p_document::jsonb; s book_snapshots; c jsonb; r jsonb; item jsonb;
  next_version bigint; total numeric; newest text; tid text;
begin
  perform pg_advisory_xact_lock(hashtextextended(d->>'personId',0));
  select * into s from book_snapshots where id=d->>'snapshotId' and person_id=d->>'personId';
  if not found or s.period is null or s.period is distinct from (d->>'period')::date then raise exception 'saved annual snapshot required'; end if;
  select id into newest from book_snapshots where person_id=s.person_id and period is not null
    and jsonb_array_length(payload->'items') > 0 order by period desc, coalesce(payload->>'filingDate','') desc,id asc limit 1;
  if s.id is distinct from newest then raise exception 'latest saved holdings required'; end if;
  if d->>'basis' is distinct from 'disclosed-holdings'
    or d->>'methodology' not in ('holding-band-midpoints','equal-weight-mapped-holdings')
    or d->>'methodology' is null or d->>'sourceHash' is distinct from s.id
    or d->'snapshotComplete' is distinct from to_jsonb(s.complete)
    or d->'snapshotIssues' is distinct from s.payload->'issues'
    or jsonb_typeof(d->'constituents') is distinct from 'array' or jsonb_array_length(d->'constituents')=0
    or jsonb_typeof(d->'evidence') is distinct from 'array'
    or jsonb_array_length(d->'evidence') <> jsonb_array_length(s.payload->'items') then raise exception 'invalid holdings definition'; end if;
  if (select count(*) <> count(distinct e->'holding'->>'id') from jsonb_array_elements(d->'evidence') e) then raise exception 'duplicate holding evidence'; end if;
  for r in select value from jsonb_array_elements(d->'evidence') loop
    if not exists(select 1 from disclosed_items i where i.snapshot_id=s.id and i.item_id=r->'holding'->>'id'
      and i.payload=r->'holding' and i.payload->>'personId'=s.person_id) then raise exception 'holding not in saved book'; end if;
    if r->>'ticker' is null then continue; end if;
    item := r->'holding';
    if item->>'kind' not in ('stock','etf') then raise exception 'ineligible holding'; end if;
    if r->>'method' = 'source-symbol' then
      if item->>'ticker' is distinct from r->>'ticker' then raise exception 'missing source symbol'; end if;
    elsif r->>'method' = 'person-trade-symbol' then
      if jsonb_typeof(r->'tradeIds') is distinct from 'array' or jsonb_array_length(r->'tradeIds')=0 then raise exception 'missing trade evidence'; end if;
      for tid in select value from jsonb_array_elements_text(r->'tradeIds') loop
        if not exists(select 1 from transactions t where t.id=tid and t.person_id=s.person_id
          and t.payload->>'ticker'=r->>'ticker' and t.payload->>'kind'=item->>'kind'
          and fmp_matches_holding(item->>'name',t.payload->>'name',t.payload->>'ticker')
          and fmp_holding_name(item->>'name') <> '') then raise exception 'invalid person symbol evidence'; end if;
      end loop;
    elsif r->>'method' = 'fmp-exact-name' then
      if r->'searchComplete' is distinct from 'true'::jsonb or not exists(
        select 1 from jsonb_array_elements(r->'candidates') candidate join raw_batches b
          on b.endpoint='search-name' and b.http_status=200
          and b.payload_hash=candidate->'source'->>'payloadHash'
          and b.params=candidate->'source'->'params'
          and b.fetched_at=(candidate->'source'->>'fetchedAt')::timestamptz
        where b.row_count < (b.params->>'limit')::integer
          and jsonb_array_length(r->'candidates')=b.row_count
          and b.body::jsonb->((candidate->>'ordinal')::integer)=candidate->'row'
          and replace(candidate->'row'->>'symbol','-','.')=r->>'ticker'
          and candidate->'row'->>'currency'='USD'
          and coalesce(candidate->'row'->>'exchangeShortName',candidate->'row'->>'exchange') in ('NASDAQ','NYSE','AMEX')
          and fmp_matches_holding(item->>'name',candidate->'row'->>'name',candidate->'row'->>'symbol')
          and fmp_holding_name(item->>'name') <> ''
      ) then raise exception 'invalid archived name evidence'; end if;
    else raise exception 'unknown resolution method'; end if;
  end loop;
  select sum((value->>'weightBps')::numeric) into total from jsonb_array_elements(d->'constituents');
  if total is distinct from 10000 then raise exception 'weights must total 10000'; end if;
  if (select count(*) <> count(distinct value->>'mint') from jsonb_array_elements(d->'constituents')) then raise exception 'duplicate constituent'; end if;
  select coalesce(max(version),0)+1 into next_version from index_versions where person_id=s.person_id;
  insert into index_versions(hash,person_id,snapshot_id,period,version,status,source_disclosure_hash,definition,document_text)
    values(p_hash,s.person_id,s.id,s.period,next_version,'CANDIDATE',s.id,d,p_document) on conflict do nothing;
  for c in select value from jsonb_array_elements(d->'constituents') loop
    if (c->>'weightBps')::numeric is null or (c->>'weightBps')::numeric <> trunc((c->>'weightBps')::numeric)
      or jsonb_typeof(c->'holdingIds') is distinct from 'array' or jsonb_array_length(c->'holdingIds')=0
      or c->'token'->>'mint' is distinct from c->>'mint' or c->'token'->>'issuer' is distinct from c->>'issuer'
      or c->'token'->>'ticker' is distinct from c->>'ticker' then raise exception 'invalid constituent'; end if;
    for tid in select value from jsonb_array_elements_text(c->'holdingIds') loop
      if not exists(select 1 from jsonb_array_elements(d->'evidence') e where e->'holding'->>'id'=tid
        and e->>'ticker'=c->>'ticker' and e->'token'=c->'token' and e->>'reason' is null
        and e->'holding'->>'kind' in ('stock','etf')) then raise exception 'missing resolved holding evidence'; end if;
    end loop;
    insert into constituents(index_hash,mint,ticker,issuer,weight_bps,payload)
      values(p_hash,c->>'mint',c->>'ticker',c->>'issuer',(c->>'weightBps')::integer,c) on conflict do nothing;
  end loop;
  -- An idempotent rerun can restore an earlier immutable document as the current target.
  update index_versions set status='BLOCKED' where person_id=s.person_id and hash<>p_hash and status='CANDIDATE';
  update index_versions set status='CANDIDATE' where hash=p_hash;
  update people set index_hash=p_hash where id=s.person_id;
end $$;
revoke all on function public.fmp_holding_name(text), public.fmp_matches_holding(text,text,text), public.publish_fmp_holdings_index(text,text) from public,anon,authenticated;
grant execute on function public.publish_fmp_holdings_index(text,text) to service_role;
-- Keep available latest holdings even when their annual pagination is partial.
-- Only an actually empty/failed annual refresh preserves the previous book.
create or replace function public.save_fmp_portfolio(p_portfolio jsonb, p_snapshots jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb; i jsonb; st jsonb; pg jsonb; doc_id text; pid text := p_portfolio->'person'->>'id';
begin
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
    portfolio=case when jsonb_array_length(people.portfolio->'snapshots') > 0
      and coalesce(jsonb_array_length(p_portfolio->'snapshots'),0)=0 then excluded.portfolio || jsonb_build_object(
        'snapshots',people.portfolio->'snapshots','indexInput',people.portfolio->'indexInput',
        'bookComplete',people.portfolio->'bookComplete','state',people.book_state,'complete',false,'partial',true)
      else excluded.portfolio end,
    book_state=case when jsonb_array_length(people.portfolio->'snapshots') > 0
      and coalesce(jsonb_array_length(p_portfolio->'snapshots'),0)=0 then people.book_state else excluded.book_state end,
    saved_at=case when jsonb_array_length(people.portfolio->'snapshots') > 0
      and coalesce(jsonb_array_length(p_portfolio->'snapshots'),0)=0 then people.saved_at else excluded.saved_at end,
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
  -- A new annual observation must not leave an older holdings target live, even if
  -- the new book has no mapped securities and therefore cannot publish a replacement.
  update index_versions set status='BLOCKED' where person_id=pid and definition->>'basis'='disclosed-holdings'
    and status='CANDIDATE' and snapshot_id is distinct from (
      select id from book_snapshots where person_id=pid and period is not null
        and jsonb_array_length(payload->'items')>0
      order by period desc,coalesce(payload->>'filingDate','') desc,id asc limit 1);
  update people set index_hash=null where id=pid and index_hash in (select hash from index_versions where status='BLOCKED');
end $$;
-- Disable the legacy publisher so it cannot reintroduce a trade-only live product.
revoke execute on function public.publish_fmp_trade_index(text,text), public.publish_fmp_index(text,text) from service_role;
update people set index_hash=null where index_hash in (select hash from index_versions where definition->>'basis'='disclosed-trade-activity');
update index_versions set status='BLOCKED' where definition->>'basis'='disclosed-trade-activity' and status='CANDIDATE';
notify pgrst, 'reload schema';
commit;
