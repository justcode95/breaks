-- v0 schema (Phase 1 scaffold). Not deployed anywhere yet, so this file may still be edited in place.
-- Money is bigint in base units (USDC has 6 decimals). Token-derived quantities are numeric(40,0).
-- Items on the "pending approval" list in CLAUDE.md (A1 randomness provider, A2 weight rule,
-- A4 challenge window) are deliberately not modelled yet.

create table breaks (
  id             bigint generated always as identity primary key,
  onchain_id     bigint unique,                 -- break_id used in the program PDAs, set once created on-chain
  status         text not null default 'scheduled' check (status in (
                   'scheduled', 'open', 'closed', 'eligibility_committed', 'funded',
                   'pool_committed', 'randomness_requested', 'settled', 'delivered', 'cancelled')),
  paid_spots     int not null check (paid_spots >= 0),
  free_spots     int not null check (free_spots >= 0),
  spot_price     bigint not null check (spot_price >= 0),
  pack_machine   text not null,                 -- one Collector Crypt machine/tier per break
  max_pack_price bigint not null check (max_pack_price > 0),
  opens_at       timestamptz not null,
  closes_at      timestamptz not null,
  pool_hash      bytea,                         -- committed on-chain before the randomness request
  pool_size      int check (pool_size >= 0),
  create_tx      text,
  created_at     timestamptz not null default now(),
  check (closes_at > opens_at)
);

create table spots (
  id          bigint generated always as identity primary key,
  break_id    bigint not null references breaks (id),
  kind        text not null check (kind in ('paid', 'free')),
  idx         int not null check (idx >= 0),    -- purchase order (paid) or draw order (free)
  wallet      text not null,
  paid        bigint check (paid >= 0),         -- USDC paid; null for free spots
  purchase_tx text,
  claim_tx    text,                             -- free spots: the claim_free_spot transaction
  refund_tx   text,
  created_at  timestamptz not null default now(),
  unique (break_id, kind, idx),
  check ((kind = 'paid') = (paid is not null))
);

-- One row per pack bought. The buyer state machine (planned -> submitted -> confirmed -> pulled)
-- is persisted so a restart never buys a second pack for the same index.
create table packs (
  id           bigint generated always as identity primary key,
  break_id     bigint not null references breaks (id),
  pack_index   int not null check (pack_index >= 0),
  status       text not null default 'planned' check (status in ('planned', 'submitted', 'confirmed', 'pulled', 'failed')),
  purchase_sig text,
  price        bigint check (price >= 0),
  card_mint    text unique,
  proof_ref    text,                            -- pointer to the Collector Crypt VRF proof for this pull
  updated_at   timestamptz not null default now(),
  unique (break_id, pack_index),
  check (status <> 'pulled' or card_mint is not null),
  check (status not in ('submitted', 'confirmed', 'pulled') or purchase_sig is not null)
);

-- Card -> spot assignment and its on-chain delivery.
create table deliveries (
  id                bigint generated always as identity primary key,
  break_id          bigint not null references breaks (id),
  spot_id           bigint not null unique references spots (id),
  card_mint         text not null unique,
  status            text not null default 'pending' check (status in ('pending', 'submitted', 'confirmed', 'failed')),
  tx_sig            text,
  sellback_deadline timestamptz,                -- end of Collector Crypt's sellback window, once verified (Phase 0)
  updated_at        timestamptz not null default now(),
  check (status = 'pending' or tx_sig is not null)
);

create table balance_events (
  id            bigint generated always as identity primary key,
  signature     text not null,
  slot          bigint not null,
  block_time    timestamptz not null,
  owner         text not null,                  -- wallet that owns the token account
  token_account text not null,
  delta         numeric(40, 0) not null,
  balance_after numeric(40, 0) not null check (balance_after >= 0),
  unique (signature, token_account)
);
create index balance_events_owner_time on balance_events (owner, block_time);

create table twab_snapshots (
  break_id bigint not null references breaks (id),
  wallet   text not null,
  twab     numeric not null check (twab >= 0),
  weight   numeric(40, 0) not null check (weight >= 0),
  eligible boolean not null,
  reason   text,                                -- why a wallet is not eligible (min TWAB, exclusion code, ...)
  primary key (break_id, wallet)
);

create table eligibility_lists (
  break_id     bigint primary key references breaks (id),
  root         bytea not null,
  total_weight numeric(40, 0) not null check (total_weight >= 0),
  entry_count  int not null check (entry_count >= 0),
  inputs_hash  bytea not null,                  -- hash of the published balance_events snapshot
  list_uri     text not null,
  inputs_uri   text not null,
  commit_tx    text,
  committed_at timestamptz
);

create table draws (
  break_id     bigint primary key references breaks (id),
  provider     text not null,
  request_id   text,
  request_tx   text,
  requested_at timestamptz,
  seed         bytea,
  proof        bytea,
  settle_tx    text,
  settled_at   timestamptz
);

create table treasury_events (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('fee_sweep', 'swap', 'deposit', 'lock', 'release', 'fund_purchases', 'refund')),
  asset      text not null check (asset in ('SOL', 'USDC')),
  amount     bigint not null,                   -- base units of `asset`
  break_id   bigint references breaks (id),
  tx_sig     text,
  note       text,
  created_at timestamptz not null default now()
);

create table exclusions (
  wallet      text primary key,
  reason_code text not null,                    -- public reason, e.g. lp_pool, exchange, team, bundle
  note        text,
  added_at    timestamptz not null default now(),
  removed_at  timestamptz
);

create table x_links (
  wallet    text primary key,
  x_handle  text not null unique,
  signature text not null,                      -- signed message proving the wallet owner linked the handle
  may_tag   boolean not null default false,     -- consent to be tagged in bot posts
  linked_at timestamptz not null default now()
);

create table bot_posts (
  id         bigint generated always as identity primary key,
  kind       text not null,
  break_id   bigint references breaks (id),
  dedupe_key text not null unique,
  body       text not null,
  status     text not null default 'queued' check (status in ('queued', 'posted', 'failed')),
  x_post_id  text,
  created_at timestamptz not null default now(),
  posted_at  timestamptz
);
