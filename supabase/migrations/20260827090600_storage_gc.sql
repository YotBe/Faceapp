-- Storage garbage collection.
--
-- `run_retention()` enqueues every object key an expired event owned, because
-- deleting a row in Postgres does not delete a 4MB JPEG in R2. Until something
-- drains that queue, retention empties the database and leaves the photographs
-- in the bucket — which means "this album is deleted after 60 days" is true of
-- the index and false of the thing the sentence is actually about.
--
-- This is the other half. Same shape as the ingestion queue, for the same
-- reasons: leases rather than status flags, so a worker killed mid-batch
-- releases its work; backoff rather than immediate retry, so a permanently
-- failing key cannot spin a worker; and a dead-letter state, so it cannot
-- retry forever either.
--
-- One difference from ingestion, and it matters: a dead-lettered ingest job is
-- a photograph that will not be searchable. A dead-lettered GC row is
-- **personal data still sitting in a bucket after we said it was gone**. It
-- needs a human, so `storage_gc_backlog` exists to make that visible rather
-- than leaving it to be discovered.

alter table storage_gc_queue
  add column run_after    timestamptz not null default now(),
  add column max_attempts int not null default 8,
  add column locked_by    text,
  add column locked_until timestamptz;

drop index if exists storage_gc_queue_pending_idx;
create index storage_gc_queue_claimable_idx
  on storage_gc_queue (state, run_after)
  where state in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- claim_storage_gc()
-- ---------------------------------------------------------------------------
create or replace function claim_storage_gc(
  p_worker text,
  p_limit  int default 100,
  p_lease  interval default interval '2 minutes'
)
returns setof storage_gc_queue
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  return query
  with claimable as (
    select q.id
    from storage_gc_queue q
    where q.state = 'pending'
      and q.run_after <= now()
      and (q.locked_until is null or q.locked_until < now())
    order by q.created_at, q.id
    limit p_limit
    for update skip locked
  )
  update storage_gc_queue q
     set attempts     = q.attempts + 1,
         locked_by    = p_worker,
         locked_until = now() + p_lease
    from claimable c
   where q.id = c.id
  returning q.*;
end;
$$;

revoke all on function claim_storage_gc(text, int, interval) from public;

-- ---------------------------------------------------------------------------
-- finish_storage_gc()
--
-- A key that is already absent counts as success. The object store is the
-- authority on whether the bytes exist, and "it was deleted twice" is not a
-- failure — retrying a lease that expired after a successful delete is the
-- normal case, not an error.
-- ---------------------------------------------------------------------------
create or replace function finish_storage_gc(
  p_id    bigint,
  p_ok    boolean,
  p_error text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  row_    storage_gc_queue%rowtype;
  v_state text;
begin
  select * into row_ from storage_gc_queue where id = p_id for update;
  if not found then
    raise exception 'no storage gc row %', p_id;
  end if;

  if p_ok then
    update storage_gc_queue
       set state = 'done', locked_by = null, locked_until = null,
           last_error = null, completed_at = now()
     where id = p_id;
    return 'done';
  end if;

  if row_.attempts >= row_.max_attempts then
    v_state := 'failed';
    update storage_gc_queue
       set state = 'failed', locked_by = null, locked_until = null,
           last_error = p_error
     where id = p_id;
  else
    v_state := 'pending';
    update storage_gc_queue
       set state = 'pending', locked_by = null, locked_until = null,
           run_after = now() + least(
             make_interval(secs => power(2, row_.attempts)::double precision),
             interval '1 hour'
           ),
           last_error = p_error
     where id = p_id;
  end if;

  return v_state;
end;
$$;

revoke all on function finish_storage_gc(bigint, boolean, text) from public;

-- ---------------------------------------------------------------------------
-- storage_gc_backlog
--
-- What is still out there after we told someone it was deleted.
--
-- `oldest_pending_age` is the number to alert on. A queue that is draining has
-- a backlog measured in minutes; one measured in days means the worker is not
-- running, and nobody finds that out from a queue depth that looks like any
-- other number.
-- ---------------------------------------------------------------------------
create or replace view storage_gc_backlog as
select
  count(*) filter (where state = 'pending')                as pending,
  count(*) filter (where state = 'failed')                 as dead_lettered,
  count(*) filter (where state = 'done')                   as deleted,
  coalesce(max(now() - created_at) filter (where state = 'pending'),
           interval '0')                                   as oldest_pending_age,
  coalesce(max(now() - created_at) filter (where state = 'failed'),
           interval '0')                                   as oldest_dead_lettered_age
from storage_gc_queue;

comment on view storage_gc_backlog is
  'Objects still in the bucket after their event was deleted. oldest_pending_age is the alert.';
