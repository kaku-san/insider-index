-- Repair already-applied trade publication functions without touching saved books.
-- The former SQL alias `c` collided with the PL/pgSQL constituent variable.
begin;
create or replace function public.publish_fmp_trade_index(p_hash text, p_document text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d jsonb := p_document::jsonb;
  c jsonb; e jsonb; t transactions; next_version bigint; total integer;
  pid text := d->>'personId';
begin
  perform pg_advisory_xact_lock(hashtextextended(pid,0));
  if d->>'basis' is distinct from 'disclosed-trade-activity'
    or coalesce(d->>'methodology','') not in ('trade-band-midpoints','equal-weight-mapped-names')
    or jsonb_typeof(d->'constituents') is distinct from 'array'
    or jsonb_array_length(d->'constituents') = 0
    or jsonb_typeof(d->'evidence') is distinct from 'array'
    or jsonb_array_length(d->'evidence') = 0
    or p_hash is distinct from encode(sha256(convert_to(p_document,'UTF8')),'hex')
    then raise exception 'invalid trade index definition'; end if;
  -- Evidence is an exact copy of saved transactions, never a new/rewritten book.
  for e in select * from jsonb_array_elements(d->'evidence') loop
    select * into t from transactions where id=e->>'id' and person_id=pid;
    if not found or t.payload is distinct from e then raise exception 'trade evidence is not saved for person'; end if;
  end loop;
  if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(d->'evidence'))
    then raise exception 'duplicate trade evidence'; end if;
  select sum((value->>'weightBps')::integer) into total from jsonb_array_elements(d->'constituents');
  if total is distinct from 10000 then raise exception 'weights must total 10000'; end if;
  if (select count(*) <> count(distinct value->>'mint') from jsonb_array_elements(d->'constituents'))
    then raise exception 'duplicate constituent mint'; end if;
  for c in select * from jsonb_array_elements(d->'constituents') loop
    if jsonb_typeof(c->'tradeIds') is distinct from 'array' or jsonb_array_length(c->'tradeIds')=0
      or (c->>'weightBps')::numeric <> trunc((c->>'weightBps')::numeric)
      or c->>'mint' is distinct from c->'token'->>'mint'
      or c->>'issuer' is distinct from c->'token'->>'issuer'
      or c->>'ticker' is distinct from c->'token'->>'ticker'
      then raise exception 'invalid constituent evidence'; end if;
    if exists(select 1 from jsonb_array_elements_text(c->'tradeIds') tid where not exists (
      select 1 from transactions tr where tr.id=tid.value and tr.person_id=pid
        and tr.payload->>'personId'=pid and tr.payload->>'kind' in ('stock','etf')
        and replace(replace(upper(trim(tr.payload->>'ticker')),'-','.'),'/','.')=c->>'ticker'
        and tr.transaction_date is not null
        and exists(select 1 from jsonb_array_elements(d->'evidence') ev where ev->>'id'=tr.id)
    )) then raise exception 'constituent lacks saved symbol evidence'; end if;
    -- Reuse the catalog evidence already captured on the saved trade. A changed
    -- issuer mint requires re-ingestion/review, not permission to invent a mint.
    if not exists(select 1 from transactions tr where tr.person_id=pid
      and replace(replace(upper(trim(tr.payload->>'ticker')),'-','.'),'/','.')=c->>'ticker'
      and tr.payload->'token'->>'mint'=c->>'mint'
      and tr.payload->'token'->>'issuer'=c->>'issuer'
      and tr.payload->'token'->'decimals'=c->'token'->'decimals')
      then raise exception 'constituent lacks saved catalog evidence'; end if;
  end loop;
  if (d->>'period')::date is distinct from (
    select max(tr.transaction_date) from transactions tr where tr.person_id=pid
      and exists(select 1 from jsonb_array_elements(d->'constituents') model_constituent(value),
        jsonb_array_elements_text(model_constituent.value->'tradeIds') tid where tid.value=tr.id)
  ) then raise exception 'invalid trade period'; end if;
  if exists(select 1 from index_versions where hash=p_hash) then return; end if;
  select coalesce(max(version),0)+1 into next_version from index_versions where person_id=pid;
  insert into index_versions(hash,person_id,snapshot_id,period,version,status,source_disclosure_hash,definition,document_text)
    values(p_hash,pid,null,(d->>'period')::date,next_version,'CANDIDATE',d->>'sourceHash',d,p_document);
  for c in select * from jsonb_array_elements(d->'constituents') loop
    insert into constituents(index_hash,mint,ticker,issuer,weight_bps,payload)
      values(p_hash,c->>'mint',c->>'ticker',c->>'issuer',(c->>'weightBps')::integer,c);
  end loop;
end $$;
revoke all on function public.publish_fmp_trade_index(text,text) from public, anon, authenticated;
grant execute on function public.publish_fmp_trade_index(text,text) to service_role;
commit;
