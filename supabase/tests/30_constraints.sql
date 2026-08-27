-- Phase 0 acceptance: the rules that matter are enforced by the database, not
-- by whichever form validator happens to run first.

\set ON_ERROR_STOP on
\set QUIET on

begin;

insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'constraints@example.com');

-- ---------------------------------------------------------------------------
select test.section('jurisdiction gate');
-- ---------------------------------------------------------------------------

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('44444444-4444-4444-4444-444444444444', 'Chicago wedding',
             'chicago-wedding-1', now() + interval '30 days', 'US-IL')$q$,
  'BIPA',
  'an Illinois event is refused, and the error says why');

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('44444444-4444-4444-4444-444444444444', 'Austin festival',
             'austin-festival-1', now() + interval '30 days', 'US-TX')$q$,
  'CUBI',
  'a Texas event is refused');

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('44444444-4444-4444-4444-444444444444', 'Somewhere',
             'somewhere-event-1', now() + interval '30 days', 'ZZ')$q$,
  'unknown jurisdiction',
  'an unknown jurisdiction is refused');

insert into events (id, operator_id, name, slug, delete_after, jurisdiction_code)
values ('eeeeeeee-0000-0000-0000-000000000001',
        '44444444-4444-4444-4444-444444444444', 'Tel Aviv wedding',
        'tel-aviv-wedding-1', now() + interval '30 days', 'IL');
select test.ok(true, 'an Israeli event is accepted');

select test.rejects(
  $q$update events set jurisdiction_code = 'US-IL'
     where id = 'eeeeeeee-0000-0000-0000-000000000001'$q$,
  'BIPA',
  'an existing event cannot be moved into a blocked jurisdiction');

-- ---------------------------------------------------------------------------
select test.section('retention window');
-- ---------------------------------------------------------------------------

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('44444444-4444-4444-4444-444444444444', 'Forever album',
             'forever-album-1', now() + interval '10 years', 'IL')$q$,
  'events_retention_window',
  'an album cannot be kept for ten years');

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('44444444-4444-4444-4444-444444444444', 'Already gone',
             'already-gone-1', now() - interval '1 day', 'IL')$q$,
  'events_retention_window',
  'a new event cannot be created already expired');

-- ---------------------------------------------------------------------------
select test.section('slug shape (public URL, must not be walkable)');
-- ---------------------------------------------------------------------------

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('44444444-4444-4444-4444-444444444444', 'Shouty',
             'Tel-Aviv-Wedding', now() + interval '30 days', 'IL')$q$,
  'events_slug_check',
  'uppercase slugs are refused');

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('44444444-4444-4444-4444-444444444444', 'Tiny',
             'ab', now() + interval '30 days', 'IL')$q$,
  'events_slug_check',
  'a two-character slug is refused');

-- ---------------------------------------------------------------------------
select test.section('youth events need an attestation before they are searchable');
-- ---------------------------------------------------------------------------

insert into events (id, operator_id, name, slug, delete_after, jurisdiction_code, is_youth_event)
values ('eeeeeeee-0000-0000-0000-000000000002',
        '44444444-4444-4444-4444-444444444444', 'School sports day',
        'school-sports-day-1', now() + interval '30 days', 'IL', true);
select test.ok(true, 'a youth event can be drafted');

update events set status = 'indexing' where id = 'eeeeeeee-0000-0000-0000-000000000002';
select test.ok(true, 'and indexed');

select test.rejects(
  $q$update events set status = 'ready'
     where id = 'eeeeeeee-0000-0000-0000-000000000002'$q$,
  'events_youth_attested_before_ready',
  'but cannot be opened for search without an attestation');

update events
   set youth_attestation_at = now(),
       youth_attestation_by = 'Head teacher, via signed form 2026-08-01'
 where id = 'eeeeeeee-0000-0000-0000-000000000002';

update events set status = 'ready' where id = 'eeeeeeee-0000-0000-0000-000000000002';
select test.eq((select status from events where id = 'eeeeeeee-0000-0000-0000-000000000002'),
               'ready', 'once attested, it opens');

select test.rejects(
  $q$update events set youth_attestation_by = null
     where id = 'eeeeeeee-0000-0000-0000-000000000002'$q$,
  'events_youth_attestation_complete',
  'an attestation cannot be half-recorded');

-- ---------------------------------------------------------------------------
select test.section('tier-0 faces are unstorable');
-- ---------------------------------------------------------------------------

insert into photos (id, event_id, storage_key)
values ('eeeeeeee-1111-0000-0000-000000000001',
        'eeeeeeee-0000-0000-0000-000000000001', 'e/1.jpg');

select test.rejects(
  $q$insert into faces (photo_id, event_id, embedding, bbox, det_score, face_px, quality_tier)
     values ('eeeeeeee-1111-0000-0000-000000000001',
             'eeeeeeee-0000-0000-0000-000000000001',
             test.vec(1), '{"x":1,"y":1,"w":20,"h":20}', 0.3, 20, 0)$q$,
  'faces_quality_tier_check',
  'a rejected detection cannot be written even by a worker that forgets the gate');

insert into faces (photo_id, event_id, embedding, bbox, det_score, face_px, quality_tier)
values ('eeeeeeee-1111-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001',
        test.vec(1), '{"x":1,"y":1,"w":55,"h":60}', 0.62, 55, 1);
select test.ok(true, 'a weak (tier 1) face is stored');

-- ---------------------------------------------------------------------------
select test.section('re-ingesting the same album is idempotent');
-- ---------------------------------------------------------------------------

select test.rejects(
  $q$insert into photos (event_id, storage_key)
     values ('eeeeeeee-0000-0000-0000-000000000001', 'e/1.jpg')$q$,
  'photos_event_storage_key_uniq',
  'the same storage key cannot be ingested twice into one event');

insert into photos (event_id, storage_key)
values ('eeeeeeee-0000-0000-0000-000000000002', 'e/1.jpg');
select test.ok(true, 'but the same key in a different event is a different photo');

select test.eq(
  test.affected($q$insert into photos (event_id, storage_key)
                   values ('eeeeeeee-0000-0000-0000-000000000001', 'e/1.jpg')
                   on conflict (event_id, storage_key) do nothing$q$),
  0, 'so a re-run can upsert safely and do nothing');

-- ---------------------------------------------------------------------------
select test.section('embedding dimensionality');
-- ---------------------------------------------------------------------------

select test.rejects(
  $q$insert into faces (photo_id, event_id, embedding, bbox, det_score, face_px, quality_tier)
     values ('eeeeeeee-1111-0000-0000-000000000001',
             'eeeeeeee-0000-0000-0000-000000000001',
             '[1,2,3]'::vector, '{"x":1,"y":1,"w":90,"h":90}', 0.9, 90, 2)$q$,
  'expected 512 dimensions',
  'a wrong-sized embedding is refused, so a model swap cannot corrupt the index silently');

rollback;
