-- The X bot decides what to post, saves the exact text, and only then sends it (like the pack buyer saves a
-- purchase before it sends it). A post that was sent with an unknown result is sent again with the SAME text:
-- X refuses a duplicate, which the bot then reads as "already posted".

alter table bot_posts
  add column valid_until timestamptz,                 -- after this the post is stale and is dropped, never sent
  add column attempts    int not null default 0,      -- sends that did not end in a verdict
  add column last_error  text,
  add column updated_at  timestamptz not null default now();

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'bot_posts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%posted%';
  if c is not null then
    execute format('alter table bot_posts drop constraint %I', c);
  end if;
end $$;

alter table bot_posts
  add constraint bot_posts_status_check check (status in ('queued', 'posted', 'failed', 'expired'));

create index bot_posts_queue on bot_posts (status, id);
