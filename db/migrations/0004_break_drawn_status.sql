-- The pipeline mirrors the on-chain status into breaks.status. The on-chain flow has a `Drawn` state
-- (seed final and every free-spot winner recorded) that the first schema did not list.

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
    'pool_committed', 'randomness_requested', 'settled', 'drawn', 'delivered', 'cancelled'));
