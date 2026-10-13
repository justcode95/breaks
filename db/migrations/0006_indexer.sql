-- The balance indexer: which addresses it reads and how far it got with each.
--
-- It follows the token from its mint: every transaction that touches the mint, then every token account that shows up
-- in those transactions, and so on. Tokens can only reach an account from the mint or from another account of the
-- mint, so reading every account that ever held tokens, from the beginning, reads every transfer.
--
-- A "pass" over one address reads its signatures from the newest back to where the previous pass stopped
-- (`until_sig`), a page at a time; `resume_before` is where the pass in progress continues. When a pass ends,
-- `covered_until` is the time it started minus a margin for finalization: every transaction of the address with a
-- block time up to then is in balance_events. The smallest `covered_until` over the accounts that can still change is
-- what indexer_state.indexed_until may claim.

create table indexed_accounts (
  address       text primary key,                -- the mint itself, or a token account of it
  kind          text not null check (kind in ('mint', 'token_account')),
  active        boolean not null default true,   -- false once the account is known to hold nothing (nothing can leave it)
  discovered_at timestamptz not null default now(),
  until_sig     text,                            -- newest signature of the last finished pass
  resume_before text,                            -- the pass in progress continues before this signature
  pass_newest   text,                            -- newest signature seen by the pass in progress
  pass_cover    timestamptz,                     -- what the pass in progress will have covered when it ends
  covered_until timestamptz,                     -- null until the first pass has finished
  check (resume_before is null or pass_cover is not null)
);
create index indexed_accounts_due on indexed_accounts (covered_until) where active;

-- A token account can change owner (SetAuthority) inside one transaction. The old owner then loses the balance and the
-- new owner gains it, both in the same transaction and on the same token account, so one row per owner.
alter table balance_events drop constraint balance_events_signature_token_account_key;
alter table balance_events add constraint balance_events_signature_token_account_owner_key unique (signature, token_account, owner);
create index balance_events_account_slot on balance_events (token_account, slot);
