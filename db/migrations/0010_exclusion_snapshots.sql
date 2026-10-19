-- The exclusion list each eligibility list was made with. The planner reads the active rows of `exclusions` when it builds a
-- list; the record it publishes shows only the excluded wallets that held the token, so the whole list it used is stored too, as
-- a document in `published_documents` (every wallet and its public code, not the private note), and published next to the
-- record. Lists made before this migration have none.

alter table eligibility_lists add column exclusions_uri text;
