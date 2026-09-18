-- Private native cycles: a durable, fenced journal; NOT a balance/ownership ledger or release gate.
-- A single native owner-intent PDA exists per vault/owner, including across index aliases.
-- No expiring lock/automatic steal: a crashed writer is RECOVERY_REQUIRED. Never broadcast before
-- the signed transaction's signature and exact bytes are durable. No signing keys are stored.
begin;
create table public.insiderindex_cycle_operations (
  operation_id uuid primary key,
  index_id text not null,
  vault text not null,
  share_mint text not null,
  owner text not null,
  state jsonb not null,
  complete boolean not null default false,
  revision bigint not null default 0,
  lock_token uuid,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(state) = 'object'),
  check (char_length(index_id) between 1 and 128)
);
create unique index insiderindex_cycle_one_native_generation on public.insiderindex_cycle_operations(vault, owner) where not complete;
alter table public.insiderindex_cycle_operations enable row level security;
revoke all on public.insiderindex_cycle_operations from public, anon, authenticated, service_role;

create function public.read_insiderindex_cycle(p_operation_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select jsonb_build_object('state', state, 'revision', revision, 'lockedAt', locked_at)
 from insiderindex_cycle_operations where operation_id = p_operation_id
$$;
create function public.lock_insiderindex_cycle(p_operation_id uuid, p_token uuid, p_initial jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r insiderindex_cycle_operations;
begin
 if p_token is null or p_initial->>'operationId' is distinct from p_operation_id::text
   or p_initial->>'phase' is distinct from 'new' or p_initial->>'pending' is not null
   or p_initial->'receipts' is distinct from '[]'::jsonb or p_initial->'credits' is distinct from '[]'::jsonb or p_initial->'expiredDrafts' is distinct from '[]'::jsonb
 then raise exception 'CYCLE_INITIAL_STATE'; end if;
 insert into insiderindex_cycle_operations(operation_id,index_id,vault,share_mint,owner,state)
 values(p_operation_id,p_initial->>'indexId',p_initial->>'vault',p_initial->>'shareMint',p_initial->>'owner',p_initial)
 on conflict(operation_id) do nothing;
 select * into r from insiderindex_cycle_operations where operation_id=p_operation_id for update;
 if r.index_id is distinct from p_initial->>'indexId' or r.vault is distinct from p_initial->>'vault'
   or r.share_mint is distinct from p_initial->>'shareMint' or r.owner is distinct from p_initial->>'owner'
 then raise exception 'CYCLE_IDENTITY_CONFLICT'; end if;
 if r.lock_token is not null then raise exception 'CYCLE_LOCK_HELD_RECOVERY_REQUIRED'; end if;
 update insiderindex_cycle_operations set lock_token=p_token, locked_at=now() where operation_id=p_operation_id;
 return jsonb_build_object('state',r.state,'revision',r.revision);
end $$;
create function public.write_insiderindex_cycle(p_operation_id uuid,p_token uuid,p_revision bigint,p_state jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r insiderindex_cycle_operations; done boolean;
begin
 select * into r from insiderindex_cycle_operations where operation_id=p_operation_id for update;
 if not found or p_token is null or r.lock_token is distinct from p_token or r.revision is distinct from p_revision then raise exception 'CYCLE_WRITER_FENCE'; end if;
 if p_state->>'operationId' is distinct from p_operation_id::text or p_state->>'indexId' is distinct from r.index_id
   or p_state->>'vault' is distinct from r.vault or p_state->>'shareMint' is distinct from r.share_mint or p_state->>'owner' is distinct from r.owner
   or p_state->>'keeper' is distinct from r.state->>'keeper' or p_state->>'policyHash' is distinct from r.state->>'policyHash'
   or p_state->>'definitionHash' is distinct from r.state->>'definitionHash'
 then raise exception 'CYCLE_IDENTITY_CONFLICT'; end if;
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
 -- Even an unsigned issued draft can have been signed/broadcast outside the app. Replacing it
 -- requires its matching landed receipt or the controller's canonical-history expiry audit.
 if r.state->>'pending' is not null and (r.state->'pending'->>'signature' is null or exists(
     select 1 from jsonb_array_elements(p_state->'receipts') e where e->>'signature'=r.state->'pending'->>'signature' and e->>'status'='expired-unexecuted'))
   and p_state->'pending'->>'stepId' is distinct from r.state->'pending'->>'stepId'
   and not exists(select 1 from jsonb_array_elements(p_state->'receipts') e where e->>'messageHash'=r.state->'pending'->>'messageHash' and e->>'status' in ('finalized','failed'))
   and not exists(select 1 from jsonb_array_elements(p_state->'expiredDrafts') e where e->>'stepId'=r.state->'pending'->>'stepId'
     and e->>'messageHash'=r.state->'pending'->>'messageHash' and (e->>'throughBlockHeight')::numeric > (r.state->'pending'->>'lastValidBlockHeight')::numeric)
 then raise exception 'CYCLE_DRAFT_CANNOT_BE_FORGOTTEN_WITHOUT_HISTORY_PROOF'; end if;
 -- An inflight signature is a permanent obligation until its same message has a terminal receipt.
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
create function public.release_insiderindex_cycle(p_operation_id uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 update insiderindex_cycle_operations set lock_token=null,locked_at=null where operation_id=p_operation_id and lock_token=p_token;
 if not found then raise exception 'CYCLE_WRITER_FENCE'; end if;
 return true;
end $$;
-- Explicit operator recovery only. No application calls this RPC and it does not erase obligations.
create function public.recover_insiderindex_cycle_lock(p_operation_id uuid,p_expected_token uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if p_expected_token is null then raise exception 'CYCLE_EXPECTED_LOCK_REQUIRED'; end if;
 return release_insiderindex_cycle(p_operation_id,p_expected_token);
end $$;
revoke all on function public.read_insiderindex_cycle(uuid), public.lock_insiderindex_cycle(uuid,uuid,jsonb), public.write_insiderindex_cycle(uuid,uuid,bigint,jsonb), public.release_insiderindex_cycle(uuid,uuid), public.recover_insiderindex_cycle_lock(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_insiderindex_cycle(uuid), public.lock_insiderindex_cycle(uuid,uuid,jsonb), public.write_insiderindex_cycle(uuid,uuid,bigint,jsonb), public.release_insiderindex_cycle(uuid,uuid), public.recover_insiderindex_cycle_lock(uuid,uuid) to service_role;
commit;
