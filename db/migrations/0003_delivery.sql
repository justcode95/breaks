-- Delivery: what the deliverer needs to survive a crash and to be audited afterwards.
--
-- deliveries.recipient is the wallet the card was (to be) sent to, copied from the verified plan, so the row
-- says what we meant to do even if the spots table is wrong. tx_sig is the signature of the CURRENT attempt
-- (cleared when the attempt is given up and the delivery goes back to 'pending'); delivery_attempts keeps
-- every signature ever submitted. A delivery found already done when we looked (the card was at the
-- recipient, e.g. after lost notes) is 'confirmed' with adopted = true and no signature.

alter table deliveries
  add column recipient  text,
  add column attempt    int not null default 0 check (attempt >= 0),
  add column expiry     text,
  add column last_error text,
  add column adopted    boolean not null default false;

-- The old rule ("anything but pending has a signature") does not fit adopted deliveries or failed ones.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'deliveries'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%tx_sig%';
  if c is not null then
    execute format('alter table deliveries drop constraint %I', c);
  end if;
end $$;

alter table deliveries
  add constraint deliveries_submitted_has_sig check (status <> 'submitted' or (tx_sig is not null and expiry is not null)),
  add constraint deliveries_confirmed_has_proof check (status <> 'confirmed' or tx_sig is not null or adopted);

create table delivery_attempts (
  id          bigint generated always as identity primary key,
  delivery_id bigint not null references deliveries (id),
  attempt     int not null check (attempt >= 1),
  signature   text not null unique,
  expiry      text not null,
  outcome     text not null default 'submitted' check (outcome in ('submitted', 'confirmed', 'failed', 'expired')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index delivery_attempts_delivery on delivery_attempts (delivery_id);
