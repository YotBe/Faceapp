-- Retention and deletion.
--
-- Two things make this real rather than decorative:
--
--   1. deletion_audit has no foreign key to events. If it did, the cascade that
--      deletes the event would delete the proof that we deleted it. The audit
--      row has to outlive its subject.
--
--   2. storage_gc_queue exists because deleting a row in Postgres does not
--      delete a 4MB JPEG in R2 or Supabase Storage. A retention job that only
--      touches the database leaves every original photo sitting in a bucket.
--      Retention enqueues the object keys; the worker performs the real
--      deletion and marks the row done.

-- ---------------------------------------------------------------------------
-- deletion_audit
-- ---------------------------------------------------------------------------
create table deletion_audit (
  id            uuid primary key default gen_random_uuid(),

  -- Intentionally NOT a foreign key. See above.
  event_id      uuid,
  event_slug    text,

  kind          text not null
                  check (kind in ('event_retention', 'event_manual', 'selfie', 'exclusion_purge', 'photo')),

  photos_deleted    int not null default 0,
  faces_deleted     int not null default 0,
  storage_enqueued  int not null default 0,

  actor         text not null default 'system',   -- 'system' (cron), or an operator id
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index deletion_audit_event_idx on deletion_audit (event_id, created_at desc);
create index deletion_audit_kind_created_idx on deletion_audit (kind, created_at desc);

comment on table deletion_audit is
  'Proof of deletion. Deliberately has no FK to events so it survives the cascade it records.';

-- ---------------------------------------------------------------------------
-- storage_gc_queue
-- ---------------------------------------------------------------------------
create table storage_gc_queue (
  id            bigint generated always as identity primary key,

  event_id      uuid,                      -- no FK: the event is gone by the time this is worked
  bucket        text not null,
  storage_key   text not null,

  state         text not null default 'pending'
                  check (state in ('pending', 'done', 'failed')),
  attempts      int not null default 0,
  last_error    text,

  created_at    timestamptz not null default now(),
  completed_at  timestamptz,

  constraint storage_gc_queue_uniq unique (bucket, storage_key)
);

create index storage_gc_queue_pending_idx on storage_gc_queue (state, created_at)
  where state <> 'done';

comment on table storage_gc_queue is
  'Object-store keys awaiting real deletion. A DB cascade does not remove bytes from a bucket.';

-- ---------------------------------------------------------------------------
-- run_retention()
--
-- Deletes every event whose delete_after has passed. Returns one row per
-- deleted event so the caller (pg_cron, or a test) can see what happened.
--
-- SECURITY DEFINER so the cron job runs with the table owner's rights and is
-- not filtered by RLS. search_path is pinned: a SECURITY DEFINER function with
-- a mutable search_path is a privilege escalation waiting to happen.
-- ---------------------------------------------------------------------------
create or replace function run_retention(p_limit int default 100)
returns table (
  event_id          uuid,
  slug              text,
  photos_deleted    int,
  faces_deleted     int,
  storage_enqueued  int
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  ev            record;
  v_photos      int;
  v_faces       int;
  v_enqueued    int;
begin
  for ev in
    select e.id, e.slug, e.name, e.delete_after, e.jurisdiction_code
    from events e
    where e.delete_after <= now()
    order by e.delete_after
    limit p_limit
    for update
  loop
    select count(*) into v_photos from photos p where p.event_id = ev.id;
    select count(*) into v_faces  from faces  f where f.event_id = ev.id;

    -- Enqueue every object this event owns: original, watermarked preview, thumb.
    with keys as (
      select p.storage_bucket as bucket, k.storage_key
      from photos p
      cross join lateral (
        values (p.storage_key), (p.preview_key), (p.thumb_key)
      ) as k(storage_key)
      where p.event_id = ev.id
        and k.storage_key is not null
    )
    insert into storage_gc_queue (event_id, bucket, storage_key)
    select ev.id, keys.bucket, keys.storage_key from keys
    on conflict (bucket, storage_key) do nothing;

    get diagnostics v_enqueued = row_count;

    insert into deletion_audit (
      event_id, event_slug, kind,
      photos_deleted, faces_deleted, storage_enqueued,
      actor, details
    ) values (
      ev.id, ev.slug, 'event_retention',
      v_photos, v_faces, v_enqueued,
      'system',
      jsonb_build_object(
        'delete_after',      ev.delete_after,
        'jurisdiction',      ev.jurisdiction_code,
        'deleted_at',        now()
      )
    );

    -- Cascades to photos, faces, clusters, search_logs and exclusions.
    delete from events where id = ev.id;

    event_id         := ev.id;
    slug             := ev.slug;
    photos_deleted   := v_photos;
    faces_deleted    := v_faces;
    storage_enqueued := v_enqueued;
    return next;
  end loop;
end;
$$;

revoke all on function run_retention(int) from public;

comment on function run_retention(int) is
  'Deletes events past delete_after, enqueues their storage objects for real deletion, and records proof in deletion_audit.';

-- ---------------------------------------------------------------------------
-- log_selfie_deletion()
--
-- The attendee selfie and its embedding never reach a table: they live in the
-- worker's memory for the duration of one request. This is how we record that
-- they were destroyed, so "we delete it within 60 seconds" is an auditable
-- claim and not marketing copy. `elapsed_ms` is the time from receipt to
-- destruction.
-- ---------------------------------------------------------------------------
create or replace function log_selfie_deletion(
  p_event_id  uuid,
  p_elapsed_ms int,
  p_frames    int default 3,
  p_purpose   text default 'search'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id uuid;
begin
  if p_elapsed_ms < 0 then
    raise exception 'elapsed_ms must be non-negative';
  end if;

  insert into deletion_audit (event_id, kind, actor, details)
  values (
    p_event_id, 'selfie', 'system',
    jsonb_build_object(
      'elapsed_ms',   p_elapsed_ms,
      'frames',       p_frames,
      'purpose',      p_purpose,
      'within_sla',   p_elapsed_ms <= 60000
    )
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function log_selfie_deletion(uuid, int, int, text) from public;

-- ---------------------------------------------------------------------------
-- Scheduling
--
-- pg_cron is available on Supabase but not on a bare Postgres, so this is
-- guarded rather than assumed. Hourly: an event whose retention expires is
-- deleted within the hour, which is well inside any contractual window.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron';
    -- EXECUTE, not a direct call: cron.schedule does not exist until the line
    -- above has run, and we do not want plpgsql resolving it before then.
    execute $sched$
      select cron.schedule('faceapp-retention', '0 * * * *', 'select run_retention(500);')
    $sched$;
  else
    raise notice 'pg_cron not available; schedule run_retention(500) externally (see docs/COMPLIANCE.md)';
  end if;
end;
$$;
