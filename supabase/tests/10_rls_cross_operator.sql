-- Phase 0 acceptance: RLS blocks cross-operator reads.
--
-- Two operators, one event each, fully populated. Then we become each of them
-- in turn and check that the database refuses to show them anything belonging
-- to the other one.

\set ON_ERROR_STOP on
\set QUIET on

begin;

select test.section('fixtures');

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'operator-a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'operator-b@example.com');

insert into events (id, operator_id, name, slug, delete_after, jurisdiction_code) values
  ('aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'Operator A wedding', 'operator-a-wedding', now() + interval '30 days', 'IL'),
  ('bbbbbbbb-0000-0000-0000-000000000002',
   '22222222-2222-2222-2222-222222222222',
   'Operator B festival', 'operator-b-festival', now() + interval '30 days', 'DE');

insert into photos (id, event_id, storage_key) values
  ('aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'a/1.jpg'),
  ('bbbbbbbb-1111-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'b/1.jpg');

insert into faces (photo_id, event_id, embedding, bbox, det_score, face_px, quality_tier) values
  ('aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   test.vec(1), '{"x":10,"y":10,"w":120,"h":140}', 0.91, 120, 2),
  ('bbbbbbbb-1111-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002',
   test.vec(2), '{"x":10,"y":10,"w":120,"h":140}', 0.88, 120, 2);

insert into clusters (event_id, centroid, face_count) values
  ('aaaaaaaa-0000-0000-0000-000000000001', test.vec(3), 1),
  ('bbbbbbbb-0000-0000-0000-000000000002', test.vec(4), 1);

insert into search_logs (event_id, ip_hash, results_returned) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'hash-a', 4),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'hash-b', 7);

insert into exclusions (event_id, embedding) values
  ('aaaaaaaa-0000-0000-0000-000000000001', test.vec(5)),
  ('bbbbbbbb-0000-0000-0000-000000000002', test.vec(6));

insert into deletion_audit (event_id, event_slug, kind) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'operator-a-wedding', 'selfie'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'operator-b-festival', 'selfie');

-- ---------------------------------------------------------------------------
select test.section('operator A sees only operator A');
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
set local role authenticated;

-- Guard: if the role switch above silently failed, everything below would pass
-- as superuser and prove nothing.
select test.eq(current_user::text, 'authenticated', 'running as the authenticated role');
select test.eq((select auth.uid()), '11111111-1111-1111-1111-111111111111'::uuid,
               'auth.uid() resolves from the JWT claim');

select test.eq((select count(*) from events)::int, 1, 'events: sees exactly one');
select test.eq((select slug from events), 'operator-a-wedding', 'events: and it is their own');
select test.eq((select count(*) from events
                where id = 'bbbbbbbb-0000-0000-0000-000000000002')::int, 0,
               'events: direct lookup of another operator''s event returns nothing');

select test.eq((select count(*) from photos)::int, 1, 'photos: scoped to own event');
select test.eq((select storage_key from photos), 'a/1.jpg', 'photos: and it is their own');

select test.eq((select count(*) from faces)::int, 1, 'faces: scoped to own event');
select test.eq((select count(*) from clusters)::int, 1, 'clusters: scoped to own event');
select test.eq((select count(*) from search_logs)::int, 1, 'search_logs: scoped to own event');
select test.eq((select ip_hash from search_logs), 'hash-a', 'search_logs: and it is their own');
select test.eq((select count(*) from deletion_audit)::int, 1, 'deletion_audit: scoped to own event');

-- Opt-out embeddings are not the operator's to read, so there is no grant at all.
select test.rejects(
  'select count(*) from exclusions',
  'permission denied',
  'exclusions: opt-out embeddings are unreadable by any operator');

-- ---------------------------------------------------------------------------
select test.section('operator A cannot write across the boundary');
-- ---------------------------------------------------------------------------

-- These do not raise. A policy filters the row out of the UPDATE/DELETE and the
-- statement succeeds having done nothing, which is exactly what we need to
-- assert — an error would at least be noisy.
select test.eq(
  test.affected($q$update events set name = 'hijacked'
                   where id = 'bbbbbbbb-0000-0000-0000-000000000002'$q$),
  0, 'update of another operator''s event affects zero rows');

select test.eq(
  test.affected($q$delete from events
                   where id = 'bbbbbbbb-0000-0000-0000-000000000002'$q$),
  0, 'delete of another operator''s event affects zero rows');

select test.eq(
  test.affected($q$delete from photos
                   where id = 'bbbbbbbb-1111-0000-0000-000000000002'$q$),
  0, 'delete of another operator''s photo affects zero rows');

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('22222222-2222-2222-2222-222222222222', 'planted',
             'planted-event-x', now() + interval '10 days', 'IL')$q$,
  'row-level security',
  'cannot create an event owned by another operator');

select test.rejects(
  $q$update events set operator_id = '22222222-2222-2222-2222-222222222222'
     where id = 'aaaaaaaa-0000-0000-0000-000000000001'$q$,
  'row-level security',
  'cannot hand an event to another operator');

-- Writes to faces belong to the ingestion worker, not to the browser session.
select test.rejects(
  $q$insert into faces (photo_id, event_id, embedding, bbox, det_score, face_px, quality_tier)
     values ('aaaaaaaa-1111-0000-0000-000000000001',
             'aaaaaaaa-0000-0000-0000-000000000001',
             test.vec(9), '{"x":1,"y":1,"w":80,"h":80}', 0.9, 80, 2)$q$,
  'permission denied',
  'operators cannot write faces directly');

reset role;

-- ---------------------------------------------------------------------------
select test.section('operator B sees only operator B');
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
set local role authenticated;

select test.eq((select count(*) from events)::int, 1, 'events: sees exactly one');
select test.eq((select slug from events), 'operator-b-festival', 'events: and it is their own');
select test.eq((select storage_key from photos), 'b/1.jpg', 'photos: and it is their own');
select test.eq((select ip_hash from search_logs), 'hash-b', 'search_logs: and it is their own');

reset role;

-- ---------------------------------------------------------------------------
select test.section('anonymous attendee reaches nothing but public reference data');
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '';
set local role anon;

select test.eq(current_user::text, 'anon', 'running as the anon role');

select test.rejects('select count(*) from events',       'permission denied', 'anon: events');
select test.rejects('select count(*) from photos',       'permission denied', 'anon: photos');
select test.rejects('select count(*) from faces',        'permission denied', 'anon: faces');
select test.rejects('select count(*) from clusters',     'permission denied', 'anon: clusters');
select test.rejects('select count(*) from search_logs',  'permission denied', 'anon: search_logs');
select test.rejects('select count(*) from exclusions',   'permission denied', 'anon: exclusions');
select test.rejects('select count(*) from deletion_audit','permission denied','anon: deletion_audit');
select test.rejects('select count(*) from storage_gc_queue','permission denied','anon: storage_gc_queue');

-- The jurisdiction allow-list is the one thing a browser may read: the signup
-- form has to be able to tell an operator why their country is refused.
select test.ok((select count(*) from jurisdictions) > 0, 'anon: jurisdictions readable');
select test.eq((select allowed from jurisdictions where code = 'US-IL'), false,
               'anon: Illinois is on the list and is refused');

reset role;

rollback;
