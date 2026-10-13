-- What the eligibility job needs besides balance_events and twab_snapshots.
--
-- indexer_state: how far the balance indexer has read. Eligibility is only computed once the indexer has
-- passed the end of a break's window by a safety margin; a quiet token has no events to show that, so the
-- indexer itself must record its progress here (one row).
--
-- published_documents: the public record of a break's eligibility (every wallet's TWAB and why it is in or
-- out, and the exact balance-event text that inputs_hash commits to), addressed by its SHA-256. The website
-- serves these. Later they can also go to IPFS or Arweave; the eligibility job only sees a URI.

create table indexer_state (
  id            int primary key check (id = 1),
  indexed_until timestamptz not null,        -- everything up to this time is in balance_events
  updated_at    timestamptz not null default now()
);

create table published_documents (
  sha256       text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);
