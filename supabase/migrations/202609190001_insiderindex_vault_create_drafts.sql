-- Create-draft journal: the wallet-signed vault create flow (`/kaku-admin`) used to journal its
-- single createVaultTx draft to a relative file on the local disk (`.data/index-vaults/...`). That
-- assumes one durable, shared host; on serverless/Vercel the filesystem is read-only except /tmp and
-- /tmp is neither durable nor shared across invocations, so the create failed with
-- `ENOENT: no such file or directory, mkdir '.data'`.
--
-- The draft is what makes create idempotent: it fixes the vault + share mint of the ONE createVaultTx
-- for an index, so every retry resumes that exact vault (refreshing only the blockhash) and never
-- issues a second createVaultTx. Losing it risks a duplicate mainnet vault. It is also the latch the
-- discard path reads: once `submitted` is set (BEFORE the create is broadcast) a discard is refused,
-- and a real on-chain Symmetry vault at the draft address is refused independently.
--
-- This migration moves that journal into the Supabase project the definitions already live in, as a
-- per-index row plus service-role-only security-definer RPCs, in the same style as
-- set_insiderindex_vault_address (202609170002). It preserves every property of the file journal:
--   * one draft per index            -> primary key on draft_key
--   * exclusive writer lock          -> lock_insiderindex_vault_create_draft (no time-based steal;
--                                       a held lock is RECOVERY_REQUIRED and released by hand)
--   * writer fencing                 -> write requires the caller's lock_token
--   * latch is monotonic             -> write only ever ORs `submitted` true; `clear` resets it and
--                                       the discard RPC refuses while it is true
--   * unreadable/unwritable journal  -> the RPCs raise, so create refuses rather than proceeding
-- No secrets live here: the row holds the unsigned create transaction bytes + identity, never key
-- material. This table never opens deposits and touches no release flag.
--
-- Why this store (the alternatives were weighed):
--   * /tmp on Vercel: not durable and not shared across invocations -- this is the bug, not a fix.
--   * object storage (Blob/S3): no compare-and-swap read-modify-write, so "one draft per index"
--     cannot be enforced without an external lock and the latch cannot commit atomically.
--   * Redis/KV conditional SET NX: can lock, but the draft and its submitted latch must commit
--     together, and the draft belongs next to the definition row the same create writes back.
--   * Supabase Postgres (chosen): already owns insiderindex_vault_definitions, already uses the
--     service-role security-definer RPC pattern for every other write, gives one-row-per-index via
--     the primary key, gives a real fence via UPDATE ... WHERE lock_token = $token, and commits the
--     state + latch in one transaction under the row lock.
begin;

create table if not exists public.insiderindex_vault_create_drafts (
  draft_key text primary key,
  index_id text,
  vault text,
  share_mint text,
  transactions jsonb not null default '[]'::jsonb,
  submitted boolean not null default false,
  lock_token text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint insiderindex_vault_create_drafts_key_check check (char_length(draft_key) between 1 and 128),
  constraint insiderindex_vault_create_drafts_submitted_shape check (not submitted or vault is not null)
);

comment on table public.insiderindex_vault_create_drafts is
  'One idempotent createVaultTx draft per index (draft_key = index id). Service-role RPC access only; never holds key material and never opens deposits.';
comment on column public.insiderindex_vault_create_drafts.submitted is
  'Latched true BEFORE the create is broadcast; discard refuses while true. Monotonic: only clear() may reset it.';
comment on column public.insiderindex_vault_create_drafts.lock_token is
  'Exclusive writer lease. Non-null means a writer holds it; a crashed writer leaves it set = RECOVERY_REQUIRED (release by hand).';

alter table public.insiderindex_vault_create_drafts enable row level security;
revoke all on public.insiderindex_vault_create_drafts from public, anon, authenticated, service_role;

-- Read one draft (or null). Stable read, never takes the lock.
create or replace function public.read_insiderindex_vault_create_draft(p_draft_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'draftKey', draft_key, 'indexId', index_id, 'vault', vault, 'shareMint', share_mint,
    'transactions', transactions, 'submitted', submitted,
    'lockedAt', locked_at, 'lockedBy', locked_by, 'updatedAt', updated_at
  )
  from insiderindex_vault_create_drafts where draft_key = p_draft_key
$$;
revoke all on function public.read_insiderindex_vault_create_draft(text) from public, anon, authenticated;
grant execute on function public.read_insiderindex_vault_create_draft(text) to service_role;

-- Take the exclusive writer lease for a draft key, creating the row if absent, and return the
-- committed state in one round trip. Concurrent writers fail closed: the loser's conditional UPDATE
-- matches nothing, so the row still holds another token and this call raises rather than racing.
-- A lock left held by a crashed writer is RECOVERY_REQUIRED, never stolen on a timer.
create or replace function public.lock_insiderindex_vault_create_draft(
  p_draft_key text, p_lock_token text, p_locked_by text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  row_token text;
  snapshot jsonb;
begin
  if p_draft_key is null or p_lock_token is null then raise exception 'draft key and lock token required'; end if;
  insert into insiderindex_vault_create_drafts as d (draft_key, lock_token, locked_at, locked_by, updated_at)
  values (p_draft_key, p_lock_token, now(), p_locked_by, now())
  on conflict (draft_key) do update
    set lock_token = excluded.lock_token, locked_at = now(), locked_by = excluded.locked_by, updated_at = now()
    where d.lock_token is null;
  select lock_token into row_token from insiderindex_vault_create_drafts where draft_key = p_draft_key;
  if row_token is distinct from p_lock_token then
    raise exception 'create draft % is locked by another writer; refusing to race (recovery required if its writer is gone)', p_draft_key;
  end if;
  select jsonb_build_object(
    'draftKey', draft_key, 'indexId', index_id, 'vault', vault, 'shareMint', share_mint,
    'transactions', transactions, 'submitted', submitted, 'lockedBy', locked_by
  ) into snapshot
  from insiderindex_vault_create_drafts where draft_key = p_draft_key;
  return snapshot;
end $$;
revoke all on function public.lock_insiderindex_vault_create_draft(text, text, text) from public, anon, authenticated;
grant execute on function public.lock_insiderindex_vault_create_draft(text, text, text) to service_role;

-- Commit a state transition while holding the lease. The UPDATE is fenced on the caller's lock token,
-- so a writer whose lease was recovered away cannot overwrite a newer draft. `submitted` is monotonic:
-- it can only be OR-ed true here, never cleared (only clear_... resets it).
create or replace function public.write_insiderindex_vault_create_draft(
  p_draft_key text, p_lock_token text, p_index_id text, p_vault text, p_share_mint text,
  p_transactions jsonb, p_submitted boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  row_token text;
  is_submitted boolean;
begin
  if p_draft_key is null or p_lock_token is null then raise exception 'draft key and lock token required'; end if;
  if p_transactions is null or jsonb_typeof(p_transactions) is distinct from 'array' then
    raise exception 'draft transactions array required';
  end if;
  select lock_token into row_token from insiderindex_vault_create_drafts where draft_key = p_draft_key for update;
  if not found then raise exception 'create draft % does not exist; lock it first', p_draft_key; end if;
  if row_token is distinct from p_lock_token then
    raise exception 'create draft % lease is not held by this writer; refusing to write', p_draft_key;
  end if;
  update insiderindex_vault_create_drafts set
    index_id = p_index_id,
    vault = p_vault,
    share_mint = p_share_mint,
    transactions = p_transactions,
    submitted = submitted or p_submitted,
    updated_at = now()
  where draft_key = p_draft_key
  returning submitted into is_submitted;
  return jsonb_build_object('draftKey', p_draft_key, 'submitted', is_submitted, 'writtenAt', now());
end $$;
revoke all on function public.write_insiderindex_vault_create_draft(text, text, text, text, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.write_insiderindex_vault_create_draft(text, text, text, text, text, jsonb, boolean) to service_role;

-- Release the lease. Only the token holder may release, so a second writer cannot drop the first's
-- lock (which is what would let two creates race).
create or replace function public.release_insiderindex_vault_create_draft(p_draft_key text, p_lock_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  released integer;
begin
  if p_draft_key is null or p_lock_token is null then raise exception 'draft key and lock token required'; end if;
  update insiderindex_vault_create_drafts set lock_token = null, locked_at = null, locked_by = null, updated_at = now()
    where draft_key = p_draft_key and lock_token = p_lock_token;
  get diagnostics released = row_count;
  if released = 0 then
    raise exception 'create draft % lease is not held by this writer; refusing to release', p_draft_key;
  end if;
  return jsonb_build_object('draftKey', p_draft_key, 'released', true);
end $$;
revoke all on function public.release_insiderindex_vault_create_draft(text, text) from public, anon, authenticated;
grant execute on function public.release_insiderindex_vault_create_draft(text, text) to service_role;

-- Discard the never-broadcast draft (reset the row to empty) under the lease. Refuses while
-- `submitted` is true so a broadcast create can never be discarded. The row is kept (not deleted) so
-- the caller's lease release still has a row to release; one row per key is the invariant.
-- The on-chain Symmetry-vault refusal is decided by the caller, which has the RPC connection.
create or replace function public.clear_insiderindex_vault_create_draft(p_draft_key text, p_lock_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  row_token text;
  is_submitted boolean;
begin
  if p_draft_key is null or p_lock_token is null then raise exception 'draft key and lock token required'; end if;
  select lock_token, submitted into row_token, is_submitted
    from insiderindex_vault_create_drafts where draft_key = p_draft_key for update;
  if not found then return jsonb_build_object('draftKey', p_draft_key, 'cleared', false); end if;
  if row_token is distinct from p_lock_token then
    raise exception 'create draft % lease is not held by this writer; refusing to clear', p_draft_key;
  end if;
  if is_submitted then
    raise exception 'create draft % was already broadcast; it cannot be discarded', p_draft_key;
  end if;
  update insiderindex_vault_create_drafts
    set index_id = null, vault = null, share_mint = null, transactions = '[]'::jsonb, submitted = false, updated_at = now()
    where draft_key = p_draft_key;
  return jsonb_build_object('draftKey', p_draft_key, 'cleared', true);
end $$;
revoke all on function public.clear_insiderindex_vault_create_draft(text, text) from public, anon, authenticated;
grant execute on function public.clear_insiderindex_vault_create_draft(text, text) to service_role;

-- Operator recovery for a crashed writer: force-drop a stale lease without touching the draft.
-- Deliberately not called by application code; there is no timer that steals a lock.
create or replace function public.recover_insiderindex_vault_create_draft_lock(
  p_draft_key text, p_expected_lock_token text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  row_token text;
begin
  if p_draft_key is null then raise exception 'draft key required'; end if;
  select lock_token into row_token from insiderindex_vault_create_drafts where draft_key = p_draft_key for update;
  if not found then raise exception 'no create draft %', p_draft_key; end if;
  if row_token is null then raise exception 'create draft % is not locked', p_draft_key; end if;
  if p_expected_lock_token is not null and row_token is distinct from p_expected_lock_token then
    raise exception 'create draft % is locked by a different token than the one supplied', p_draft_key;
  end if;
  update insiderindex_vault_create_drafts set lock_token = null, locked_at = null, locked_by = null, updated_at = now()
    where draft_key = p_draft_key;
  return jsonb_build_object('draftKey', p_draft_key, 'releasedToken', row_token);
end $$;
revoke all on function public.recover_insiderindex_vault_create_draft_lock(text, text) from public, anon, authenticated;
grant execute on function public.recover_insiderindex_vault_create_draft_lock(text, text) to service_role;

commit;
