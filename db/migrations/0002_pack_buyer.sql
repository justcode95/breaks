-- Pack buyer: what the buyer state machine needs to survive a crash without buying a pack twice.
--
-- packs.purchase_sig is the signature of the CURRENT attempt (cleared when the attempt is given up and the
-- pack goes back to 'planned'); pack_attempts keeps every signature ever submitted for a pack, so a wrong
-- "this never landed" verdict can be traced afterwards. packs.expiry is provider-defined: when the current
-- purchase can no longer land (for Solana, the last valid block height).

alter table packs
  add column attempt    int not null default 0 check (attempt >= 0),
  add column expiry     text,
  add column last_error text,
  add constraint packs_submitted_has_expiry check (status <> 'submitted' or expiry is not null);

create table pack_attempts (
  id         bigint generated always as identity primary key,
  break_id   bigint not null,
  pack_index int not null,
  attempt    int not null check (attempt >= 1),
  signature  text not null unique,
  expiry     text not null,
  price      bigint check (price >= 0),         -- null when the purchase was found in wallet history
  outcome    text not null default 'submitted' check (outcome in ('submitted', 'confirmed', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (break_id, pack_index) references packs (break_id, pack_index)
);
create index pack_attempts_pack on pack_attempts (break_id, pack_index);
