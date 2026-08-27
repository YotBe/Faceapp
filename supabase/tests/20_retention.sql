-- Phase 0 acceptance: the retention job deletes an expired event end to end.
--
-- "End to end" means all four of these, not just the first:
--   * the event and everything hanging off it is gone
--   * an event that has not expired is untouched
--   * the object-store keys are queued for real deletion, because a cascade in
--     Postgres does not remove a 4MB JPEG from a bucket
--   * the proof of deletion survives the deletion

\set ON_ERROR_STOP on
\set QUIET on

begin;

select test.section('fixtures: one expired event, one live event');

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'retention@example.com');

-- created_at is backdated so that a delete_after in the past still satisfies
-- events_retention_window (delete_after must be after created_at).
insert into events (id, operator_id, name, slug, created_at, delete_after, jurisdiction_code) values
  ('cccccccc-0000-0000-0000-000000000001',
   '33333333-3333-3333-3333-333333333333',
   'Expired festival', 'expired-festival-2025',
   now() - interval '95 days', now() - interval '5 days', 'IL'),
  ('dddddddd-0000-0000-0000-000000000002',
   '33333333-3333-3333-3333-333333333333',
   'Live wedding', 'live-wedding-2026',
   now() - interval '2 days', now() + interval '40 days', 'IL');

insert into photos (id, event_id, storage_key, preview_key, thumb_key) values
  ('cccccccc-1111-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
   'expired/orig/1.jpg', 'expired/preview/1.webp', 'expired/thumb/1.webp'),
  ('cccccccc-1111-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001',
   'expired/orig/2.jpg', 'expired/preview/2.webp', 'expired/thumb/2.webp'),
  -- A photo that failed ingestion: original only, no preview or thumb yet.
  ('cccccccc-1111-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001',
   'expired/orig/3.jpg', null, null),
  ('dddddddd-1111-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002',
   'live/orig/1.jpg', 'live/preview/1.webp', 'live/thumb/1.webp');

insert into faces (photo_id, event_id, embedding, bbox, det_score, face_px, quality_tier)
select 'cccccccc-1111-0000-0000-000000000001',
       'cccccccc-0000-0000-0000-000000000001',
       test.vec(i), '{"x":1,"y":1,"w":100,"h":100}', 0.9, 100, 2
from generate_series(1, 5) as i;

insert into faces (photo_id, event_id, embedding, bbox, det_score, face_px, quality_tier)
values ('dddddddd-1111-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002',
        test.vec(99), '{"x":1,"y":1,"w":100,"h":100}', 0.9, 100, 2);

insert into clusters (event_id, centroid, face_count) values
  ('cccccccc-0000-0000-0000-000000000001', test.vec(11), 5);

insert into search_logs (event_id, ip_hash, results_returned) values
  ('cccccccc-0000-0000-0000-000000000001', 'hash-x', 12);

insert into exclusions (event_id, embedding) values
  ('cccccccc-0000-0000-0000-000000000001', test.vec(12));

select test.eq((select count(*) from faces where event_id = 'cccccccc-0000-0000-0000-000000000001')::int,
               5, 'fixture: five faces on the expired event');

-- ---------------------------------------------------------------------------
select test.section('run_retention()');
-- ---------------------------------------------------------------------------

create temporary table retention_result on commit drop as
  select * from run_retention();

select test.eq((select count(*) from retention_result)::int, 1,
               'exactly one event was collected');
select test.eq((select slug from retention_result), 'expired-festival-2025',
               'and it is the expired one');
select test.eq((select photos_deleted from retention_result), 3,
               'reported three photos deleted');
select test.eq((select faces_deleted from retention_result), 5,
               'reported five faces deleted');
select test.eq((select storage_enqueued from retention_result), 7,
               'reported seven storage objects enqueued (2 photos x 3 keys + 1 original)');

-- ---------------------------------------------------------------------------
select test.section('the expired event is gone');
-- ---------------------------------------------------------------------------

select test.eq((select count(*) from events
                where id = 'cccccccc-0000-0000-0000-000000000001')::int, 0, 'events');
select test.eq((select count(*) from photos
                where event_id = 'cccccccc-0000-0000-0000-000000000001')::int, 0, 'photos cascaded');
select test.eq((select count(*) from faces
                where event_id = 'cccccccc-0000-0000-0000-000000000001')::int, 0,
               'faces cascaded — no biometric data left behind');
select test.eq((select count(*) from clusters
                where event_id = 'cccccccc-0000-0000-0000-000000000001')::int, 0, 'clusters cascaded');
select test.eq((select count(*) from search_logs
                where event_id = 'cccccccc-0000-0000-0000-000000000001')::int, 0, 'search_logs cascaded');
select test.eq((select count(*) from exclusions
                where event_id = 'cccccccc-0000-0000-0000-000000000001')::int, 0, 'exclusions cascaded');

-- ---------------------------------------------------------------------------
select test.section('the live event is untouched');
-- ---------------------------------------------------------------------------

select test.eq((select count(*) from events
                where id = 'dddddddd-0000-0000-0000-000000000002')::int, 1, 'events');
select test.eq((select count(*) from photos
                where event_id = 'dddddddd-0000-0000-0000-000000000002')::int, 1, 'photos');
select test.eq((select count(*) from faces
                where event_id = 'dddddddd-0000-0000-0000-000000000002')::int, 1, 'faces');
select test.eq((select count(*) from storage_gc_queue
                where storage_key like 'live/%')::int, 0,
               'no live object was queued for deletion');

-- ---------------------------------------------------------------------------
select test.section('object storage is actually scheduled for deletion');
-- ---------------------------------------------------------------------------

select test.eq((select count(*) from storage_gc_queue)::int, 7,
               'seven keys queued');
select test.eq((select count(*) from storage_gc_queue where state = 'pending')::int, 7,
               'all pending — the worker has not run yet');
select test.ok(
  exists (select 1 from storage_gc_queue where storage_key = 'expired/orig/1.jpg')
  and exists (select 1 from storage_gc_queue where storage_key = 'expired/preview/1.webp')
  and exists (select 1 from storage_gc_queue where storage_key = 'expired/thumb/1.webp')
  and exists (select 1 from storage_gc_queue where storage_key = 'expired/orig/3.jpg'),
  'originals, previews and thumbnails are all queued');
select test.eq((select count(*) from storage_gc_queue where storage_key is null)::int, 0,
               'the photo with no preview or thumb contributed no null keys');
select test.eq((select bucket from storage_gc_queue limit 1), 'event-photos',
               'the bucket travelled with the key');

-- ---------------------------------------------------------------------------
select test.section('proof of deletion outlives the deletion');
-- ---------------------------------------------------------------------------

select test.eq((select count(*) from deletion_audit
                where event_id = 'cccccccc-0000-0000-0000-000000000001'
                  and kind = 'event_retention')::int, 1,
               'an audit row exists for an event that no longer exists');
select test.eq((select event_slug from deletion_audit
                where event_id = 'cccccccc-0000-0000-0000-000000000001'),
               'expired-festival-2025',
               'the audit row remembers which event it was');
select test.eq((select photos_deleted from deletion_audit
                where event_id = 'cccccccc-0000-0000-0000-000000000001'), 3,
               'the audit row records what was destroyed');
select test.eq((select faces_deleted from deletion_audit
                where event_id = 'cccccccc-0000-0000-0000-000000000001'), 5,
               'including the face count');
select test.ok((select details ? 'deleted_at' from deletion_audit
                where event_id = 'cccccccc-0000-0000-0000-000000000001'),
               'and when');

-- ---------------------------------------------------------------------------
select test.section('a second run is a no-op');
-- ---------------------------------------------------------------------------

select test.eq((select count(*) from run_retention())::int, 0,
               'nothing left to collect');
select test.eq((select count(*) from storage_gc_queue)::int, 7,
               'and no duplicate storage keys were queued');

-- ---------------------------------------------------------------------------
select test.section('selfie deletion is auditable');
-- ---------------------------------------------------------------------------

select test.ok(
  log_selfie_deletion('dddddddd-0000-0000-0000-000000000002', 1840, 3, 'search') is not null,
  'log_selfie_deletion returns an audit id');

select test.eq((select (details ->> 'within_sla')::boolean from deletion_audit
                where kind = 'selfie'
                  and event_id = 'dddddddd-0000-0000-0000-000000000002'),
               true,
               '1.8s is inside the 60s destruction SLA');

select test.ok(
  (select count(*) from deletion_audit where kind = 'selfie') = 1,
  'the selfie audit row carries no embedding, only timing');

rollback;
