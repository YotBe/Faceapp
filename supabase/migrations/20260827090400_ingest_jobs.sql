-- Ingestion queue.
--
-- Postgres as a queue rather than Redis, per the stack decision: at 100k photos
-- per event and a handful of workers this is nowhere near the throughput where
-- a dedicated broker earns its operational cost, and keeping the queue in the
-- same transaction as the row it is about removes a whole class of
-- "enqueued but the insert rolled back" bug.
--
-- The acceptance criterion this exists to satisfy is "killing a worker
-- mid-batch loses no jobs". That is why claims are leases with an expiry rather
-- than a status flag: a worker that dies holding a job cannot release it, so
-- the lease has to expire on its own.

create table ingest_jobs (
  id            bigint generated always as identity primary key,
  photo_id      uuid not null references photos on delete cascade,
  event_id      uuid not null references events on delete cascade,

  state         text not null default 'pending'
                  check (state in ('pending', 'running', 'done', 'failed')),

  attempts      int not null default 0,
  max_attempts  int not null default 5,

  -- Exponential backoff lives here: a failed job is rescheduled rather than
  -- retried immediately, so a systematically broken photo cannot spin a worker.
  run_after     timestamptz not null default now(),

  -- Lease. locked_until is what makes a killed worker recoverable.
  locked_by     text,
  locked_until  timestamptz,

  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One live job per photo. Re-running ingestion for an album is idempotent
  -- (Phase 2 acceptance criterion) and this is half of why: the enqueue is an
  -- upsert that cannot produce a second job for a photo already queued.
  constraint ingest_jobs_photo_uniq unique (photo_id)
);

create index ingest_jobs_claimable_idx on ingest_jobs (state, run_after)
  where state in ('pending', 'running');
create index ingest_jobs_event_idx on ingest_jobs (event_id, state);

comment on table ingest_jobs is
  'One job per photo. Claims are time-limited leases so a killed worker releases its work automatically.';

-- ---------------------------------------------------------------------------
-- claim_ingest_jobs()
--
-- SKIP LOCKED is the whole trick: several workers can claim disjoint batches
-- concurrently without blocking each other, and without any of them seeing a
-- row another worker is already holding.
--
-- Jobs whose lease has expired are claimable again. That is the recovery path
-- for a worker that was killed mid-photo.
-- ---------------------------------------------------------------------------
create or replace function claim_ingest_jobs(
  p_worker  text,
  p_limit   int default 8,
  p_lease   interval default interval '5 minutes'
)
returns setof ingest_jobs
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  return query
  with claimable as (
    select j.id
    from ingest_jobs j
    where j.run_after <= now()
      and (
        j.state = 'pending'
        or (j.state = 'running' and j.locked_until < now())
      )
    order by j.run_after, j.id
    limit p_limit
    for update skip locked
  )
  update ingest_jobs j
     set state        = 'running',
         attempts     = j.attempts + 1,
         locked_by    = p_worker,
         locked_until = now() + p_lease,
         updated_at   = now()
    from claimable c
   where j.id = c.id
  returning j.*;
end;
$$;

revoke all on function claim_ingest_jobs(text, int, interval) from public;

-- ---------------------------------------------------------------------------
-- finish_ingest_job()
--
-- Success marks done. Failure either reschedules with exponential backoff or,
-- once max_attempts is spent, lands in 'failed' — the dead letter state. A
-- failed job is deliberately NOT retried forever: a corrupt JPEG would
-- otherwise consume a worker slot for the life of the event.
-- ---------------------------------------------------------------------------
create or replace function finish_ingest_job(
  p_job_id  bigint,
  p_ok      boolean,
  p_error   text default null,
  p_faces   int default 0,
  p_rejected int default 0
)
returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  j          ingest_jobs%rowtype;
  v_state    text;
  v_backoff  interval;
begin
  select * into j from ingest_jobs where id = p_job_id for update;
  if not found then
    raise exception 'no ingest job %', p_job_id;
  end if;

  if p_ok then
    update ingest_jobs
       set state = 'done', locked_by = null, locked_until = null,
           last_error = null, updated_at = now()
     where id = p_job_id;

    update photos
       set status = 'done', error = null,
           faces_indexed = p_faces, faces_rejected = p_rejected
     where id = j.photo_id;

    update events e
       set face_count     = e.face_count + p_faces,
           faces_rejected = e.faces_rejected + p_rejected
     where e.id = j.event_id;

    v_state := 'done';
  else
    if j.attempts >= j.max_attempts then
      v_state := 'failed';
      update ingest_jobs
         set state = 'failed', locked_by = null, locked_until = null,
             last_error = p_error, updated_at = now()
       where id = p_job_id;
      update photos set status = 'failed', error = p_error where id = j.photo_id;
    else
      -- 2s, 4s, 8s, 16s... Capped so a long-running event does not end up with
      -- a job scheduled past its own retention deadline.
      v_backoff := least(
        make_interval(secs => power(2, j.attempts)::double precision),
        interval '10 minutes'
      );
      v_state := 'pending';
      update ingest_jobs
         set state = 'pending', locked_by = null, locked_until = null,
             run_after = now() + v_backoff,
             last_error = p_error, updated_at = now()
       where id = p_job_id;
      update photos set status = 'pending', error = p_error where id = j.photo_id;
    end if;
  end if;

  -- The event is ready once nothing is left to do. Photos that landed in the
  -- dead letter queue do not hold the album hostage; the operator sees them in
  -- the failure list and decides.
  update events e
     set status = 'ready'
   where e.id = j.event_id
     and e.status = 'indexing'
     and not exists (
       select 1 from ingest_jobs q
       where q.event_id = j.event_id and q.state in ('pending', 'running')
     );

  return v_state;
end;
$$;

revoke all on function finish_ingest_job(bigint, boolean, text, int, int) from public;

-- ---------------------------------------------------------------------------
-- RLS: the operator may watch their own queue. Only the worker writes.
-- ---------------------------------------------------------------------------
alter table ingest_jobs enable row level security;
grant select on ingest_jobs to authenticated;

create policy ingest_jobs_select_own on ingest_jobs
  for select to authenticated
  using (exists (
    select 1 from events e
    where e.id = ingest_jobs.event_id
      and e.operator_id = (select auth.uid())
  ));
