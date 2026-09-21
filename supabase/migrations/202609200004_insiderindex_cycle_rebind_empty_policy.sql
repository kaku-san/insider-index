-- A changed public Mag7 definition/policy can rebind only an entirely empty, restartable row.
-- Immutable operation identity, all receipts and every unresolved draft remain protected.
begin;
create or replace function public.write_insiderindex_cycle(p_operation_id uuid,p_token uuid,p_revision bigint,p_state jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r insiderindex_cycle_operations; done boolean;
begin
 select * into r from insiderindex_cycle_operations where operation_id=p_operation_id for update;
 if not found or p_token is null or r.lock_token is distinct from p_token or r.revision is distinct from p_revision then raise exception 'CYCLE_WRITER_FENCE'; end if;
 if p_state->>'operationId' is distinct from p_operation_id::text or p_state->>'indexId' is distinct from r.index_id
   or p_state->>'vault' is distinct from r.vault or p_state->>'shareMint' is distinct from r.share_mint or p_state->>'owner' is distinct from r.owner
   or p_state->>'keeper' is distinct from r.state->>'keeper'
 then raise exception 'CYCLE_IDENTITY_CONFLICT'; end if;
 -- Definition hash, policy hash and approved amount move together only before funding. No unsigned
 -- wire is discarded here: canonical reconciliation must clear it first.
 if p_state->>'definitionHash' is distinct from r.state->>'definitionHash'
   or p_state->>'policyHash' is distinct from r.state->>'policyHash'
   or p_state->>'approvedDepositUsdcRaw' is distinct from r.state->>'approvedDepositUsdcRaw' then
   if (r.state - 'definitionHash' - 'policyHash' - 'approvedDepositUsdcRaw') is distinct from (p_state - 'definitionHash' - 'policyHash' - 'approvedDepositUsdcRaw')
     or r.state->>'phase' not in ('new','investing') or p_state->>'phase' not in ('new','investing')
     or (r.state->>'contributedUsdcRaw')::numeric <> 0 or (r.state->>'mintedSharesRaw')::numeric <> 0
     or (p_state->>'contributedUsdcRaw')::numeric <> 0 or (p_state->>'mintedSharesRaw')::numeric <> 0
     or r.state->>'pending' is not null or p_state->>'pending' is not null
     or exists(select 1 from jsonb_array_elements(r.state->'receipts') e where e->>'status'='finalized' and e->>'action' in ('contribute','mint'))
     or exists(select 1 from jsonb_array_elements(p_state->'receipts') e where e->>'status'='finalized' and e->>'action' in ('contribute','mint'))
   then raise exception 'CYCLE_PUBLIC_AMOUNT_RESTART_REFUSED'; end if;
 end if;
 if jsonb_typeof(p_state->'receipts') is distinct from 'array' or jsonb_typeof(p_state->'credits') is distinct from 'array'
   or jsonb_typeof(p_state->'expiredDrafts') is distinct from 'array' then raise exception 'CYCLE_JOURNAL_SHAPE'; end if;
 if exists(select 1 from jsonb_array_elements(r.state->'receipts') with ordinality old(value,n)
   where value is distinct from (p_state->'receipts')->(n::integer-1)) then raise exception 'CYCLE_RECEIPT_HISTORY_IMMUTABLE'; end if;
 if exists(select 1 from jsonb_array_elements(r.state->'expiredDrafts') with ordinality old(value,n)
   where value is distinct from (p_state->'expiredDrafts')->(n::integer-1)) then raise exception 'CYCLE_EXPIRY_HISTORY_IMMUTABLE'; end if;
 if exists(select 1 from jsonb_array_elements(r.state->'credits') with ordinality old(value,n)
   where (value-'soldRaw') is distinct from (((p_state->'credits')->(n::integer-1))-'soldRaw')
   or (value->>'soldRaw')::numeric > ((p_state->'credits')->(n::integer-1)->>'soldRaw')::numeric)
 then raise exception 'CYCLE_CREDIT_HISTORY_IMMUTABLE'; end if;
 if exists(select 1 from jsonb_array_elements(p_state->'credits') c where c->>'owner' is distinct from r.owner
   or c->>'vault' is distinct from r.vault or c->>'operationId' is distinct from p_operation_id::text
   or (c->>'soldRaw')::numeric > (c->>'receivedRaw')::numeric or not exists(
     select 1 from jsonb_array_elements(p_state->'receipts') e where e->>'signature'=c->>'signature' and e->>'action'='claim' and e->>'status'='finalized'))
 then raise exception 'CYCLE_CREDIT_NOT_ATTRIBUTABLE'; end if;
 if (p_state->>'ownerSolDebitLamports')::numeric is distinct from (select coalesce(sum((e->>'payerDebitLamports')::numeric),0) from jsonb_array_elements(p_state->'receipts') e where e->>'payer'=r.owner)
   or (p_state->>'keeperSolDebitLamports')::numeric is distinct from (select coalesce(sum((e->>'payerDebitLamports')::numeric),0) from jsonb_array_elements(p_state->'receipts') e where e->>'payer'=p_state->>'keeper')
 then raise exception 'CYCLE_FEE_TOTAL_DIVERGENCE'; end if;
 if r.state->>'pending' is not null and (r.state->'pending'->>'signature' is null or exists(
     select 1 from jsonb_array_elements(p_state->'receipts') e where e->>'signature'=r.state->'pending'->>'signature' and e->>'status'='expired-unexecuted'))
   and p_state->'pending'->>'stepId' is distinct from r.state->'pending'->>'stepId'
   and not exists(select 1 from jsonb_array_elements(p_state->'receipts') e where e->>'messageHash'=r.state->'pending'->>'messageHash' and e->>'status' in ('finalized','failed'))
   and not exists(select 1 from jsonb_array_elements(p_state->'expiredDrafts') e where e->>'stepId'=r.state->'pending'->>'stepId'
     and e->>'messageHash'=r.state->'pending'->>'messageHash' and (e->>'throughBlockHeight')::numeric > (r.state->'pending'->>'lastValidBlockHeight')::numeric)
 then raise exception 'CYCLE_DRAFT_CANNOT_BE_FORGOTTEN_WITHOUT_HISTORY_PROOF'; end if;
 if r.state->'pending'->>'signature' is not null and
    (p_state->'pending'->>'signature' is distinct from r.state->'pending'->>'signature'
     or p_state->'pending'->>'messageHash' is distinct from r.state->'pending'->>'messageHash') and not exists(
   select 1 from jsonb_array_elements(p_state->'receipts') e where e->>'signature'=r.state->'pending'->>'signature'
   and e->>'messageHash'=r.state->'pending'->>'messageHash' and e->>'status' in ('finalized','failed','expired-unexecuted'))
 then raise exception 'CYCLE_INFLIGHT_SIGNATURE_CANNOT_BE_FORGOTTEN'; end if;
 done := p_state->>'phase'='complete';
 if r.complete and not done then raise exception 'CYCLE_COMPLETION_MONOTONIC'; end if;
 if done and (p_state->>'burnedSharesRaw')::numeric < (p_state->>'mintedSharesRaw')::numeric then raise exception 'CYCLE_NATIVE_EXIT_OUTSTANDING'; end if;
 if done and (p_state->>'pending' is not null or p_state->>'recoveryRequired' is not null or p_state->>'nativeClaimsClear' is distinct from 'true' or exists(
   select 1 from jsonb_array_elements(p_state->'credits') e where e->>'mint'<>'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
   and (e->>'receivedRaw')::numeric<>(e->>'soldRaw')::numeric)) then raise exception 'CYCLE_OUTSTANDING_OBLIGATIONS'; end if;
 update insiderindex_cycle_operations set state=p_state,complete=done,revision=revision+1,updated_at=now() where operation_id=p_operation_id;
 return jsonb_build_object('revision',r.revision+1);
end $$;
revoke all on function public.write_insiderindex_cycle(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.write_insiderindex_cycle(uuid,uuid,bigint,jsonb) to service_role;
commit;
