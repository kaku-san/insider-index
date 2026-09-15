-- Track A receipts only. Never index ownership, remaining wallet balances, or NAV.
begin;
create table public.copy_orders (
  request_id text primary key,
  wallet text not null,
  disclosure_id text,
  ticker text not null,
  token_symbol text not null,
  venue text not null check (venue in ('xstock', 'backpack')),
  mint text not null,
  side text not null check (side in ('buy', 'sell')),
  token_decimals integer not null check (token_decimals between 0 and 18),
  message_hash text not null,
  expires_at timestamptz not null,
  stub boolean not null default false
);
create index copy_orders_expiry on public.copy_orders(expires_at);

create table public.positions (
  id uuid primary key,
  wallet text not null,
  disclosure_id text,
  ticker text not null,
  token_symbol text not null,
  venue text not null check (venue in ('xstock', 'backpack')),
  mint text not null,
  side text not null check (side in ('buy', 'sell')),
  -- Strings preserve exact atomic units; null means Jupiter omitted the fill amount.
  input_amount_raw text check (input_amount_raw ~ '^[0-9]+$'),
  output_amount_raw text check (output_amount_raw ~ '^[0-9]+$'),
  input_decimals integer not null check (input_decimals between 0 and 18),
  output_decimals integer not null check (output_decimals between 0 and 18),
  request_id text not null unique references public.copy_orders(request_id),
  signature text not null unique check (length(signature) > 0),
  stub boolean not null default false,
  created_at timestamptz not null default now()
);
create index positions_wallet_created on public.positions(wallet, created_at desc);

alter table public.copy_orders enable row level security;
alter table public.positions enable row level security;
revoke all on public.copy_orders, public.positions from public, anon, authenticated, service_role;
grant select, insert on public.copy_orders, public.positions to service_role;
comment on table public.positions is 'User-signed Jupiter fill receipts. Not current holdings, valuation, or native index shares.';
commit;
