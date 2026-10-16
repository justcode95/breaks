-- The refund job gives a cancelled break's buyers their USDC back (`refund_spot`). A cancelled break whose spots are all refunded
-- on chain ends as `refunded`, so the job stops reading it. The status check must know the new value.

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'breaks'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%pool_committed%';
  if c is not null then
    execute format('alter table breaks drop constraint %I', c);
  end if;
end $$;

alter table breaks
  add constraint breaks_status_check check (status in (
    'scheduled', 'open', 'closed', 'eligibility_committed', 'funded',
    'pool_committed', 'randomness_requested', 'settled', 'drawn', 'delivered', 'cancelled', 'refunded'));
