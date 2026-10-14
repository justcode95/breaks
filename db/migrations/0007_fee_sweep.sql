-- The fee sweep: fee SOL is swapped to USDC and the USDC is deposited into the treasury.
--
-- fee_swaps: one row per swap transaction, saved BEFORE the transaction is sent, so a restart never sends a second
-- swap while the first might still land. `payload` is the signed transaction (opaque to the sweeper; it is sent again
-- as it is while the swap is pending), `expiry` the last block height at which it can still land. The unique index
-- allows one swap in flight at a time.
--
-- treasury_events (0001) gets a unique key so that writing the same event twice is harmless.

create table fee_swaps (
  id           bigint generated always as identity primary key,
  status       text not null default 'prepared' check (status in ('prepared', 'submitted', 'landed', 'failed', 'expired')),
  lamports_in  bigint not null check (lamports_in > 0),
  min_usdc_out bigint not null check (min_usdc_out > 0),
  signature    text not null unique,
  expiry       text not null,
  payload      text not null,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index fee_swaps_one_in_flight on fee_swaps ((true)) where status in ('prepared', 'submitted');

create unique index treasury_events_kind_tx on treasury_events (kind, tx_sig) where tx_sig is not null;
