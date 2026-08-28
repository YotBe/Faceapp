-- Storage garbage collection.
--
-- The claim/finish mechanics, and the one property that distinguishes this
-- queue from the ingestion queue: a row that cannot be drained is personal data
-- still sitting in a bucket after somebody was told it was deleted, so it has
-- to end up visible rather than merely marked.

\set ON_ERROR_STOP on
\set QUIET on

begin;

insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'gc@example.com');

insert into events (id, operator_id, name, slug, created_at, delete_after, jurisdiction_code)
values ('aaaa0000-0000-0000-0000-000000000c01',
        '66666666-6666-6666-6666-666666666666', 'Expired album',
        'expired-album-gc-1', now() - interval '90 days', now() - interval '1 day', 'IL');

insert into photos (event_id, storage_key, preview_key, thumb_key)
select 'aaaa0000-0000-0000-0000-000000000c01',
       'ev/orig/' || i || '.jpg',
       'ev/prev/' || i || '.webp',
       'ev/thumb/' || i || '.webp'
from generate_series(1, 4) as i;

select test.section('retention fills the queue');

select test.eq((select storage_enqueued from run_retention()), 12,
               'twelve object keys queued for four photos');
select test.eq((select pending from storage_gc_backlog)::int, 12,
               'and the backlog view agrees');
select test.eq((select deleted from storage_gc_backlog)::int, 0,
               'nothing deleted yet — the database is empty and the bucket is not');

select test.section('claiming');

create temporary table gc_a on commit drop as
  select * from claim_storage_gc('gc-a', 5);
create temporary table gc_b on commit drop as
  select * from claim_storage_gc('gc-b', 5);

select test.eq((select count(*) from gc_a)::int, 5, 'worker A claims five');
select test.eq((select count(*) from gc_b)::int, 5, 'worker B claims five more');
select test.eq((select count(*) from gc_a a join gc_b b on a.id = b.id)::int, 0,
               'and never the same row twice');
select test.eq((select count(*) from claim_storage_gc('gc-c', 50))::int, 2,
               'a third worker gets exactly what is left');

select test.section('a killed worker releases its rows');

update storage_gc_queue set locked_until = now() - interval '1 second'
 where locked_by = 'gc-a';

select test.eq((select count(*) from claim_storage_gc('gc-d', 50))::int, 5,
               'the dead worker''s five become claimable again');
select test.eq((select distinct attempts from storage_gc_queue where locked_by = 'gc-d'), 2,
               'and the retry is counted');

select test.section('completion and backoff');

select test.eq(finish_storage_gc((select id from gc_b limit 1), true), 'done',
               'a deleted object is done');
select test.eq((select deleted from storage_gc_backlog)::int, 1, 'the backlog shrinks');
select test.ok(
  (select completed_at is not null from storage_gc_queue where id = (select id from gc_b limit 1)),
  'and records when');

select test.eq(
  finish_storage_gc((select id from gc_b offset 1 limit 1), false, 'connection reset'),
  'pending', 'a transient failure is rescheduled');
select test.ok(
  (select run_after > now() from storage_gc_queue where id = (select id from gc_b offset 1 limit 1)),
  'with backoff, so a broken bucket cannot spin the worker');

select test.section('a row that will not drain becomes visible');

update storage_gc_queue set attempts = max_attempts
 where id = (select id from gc_b offset 2 limit 1);

select test.eq(
  finish_storage_gc((select id from gc_b offset 2 limit 1), false, 'access denied'),
  'failed', 'once the attempts are spent it is dead-lettered');

select test.eq((select dead_lettered from storage_gc_backlog)::int, 1,
               'and the backlog reports it — this is a photograph still in the bucket');
select test.ok((select oldest_dead_lettered_age from storage_gc_backlog) >= interval '0',
               'with an age, which is what a monitor alerts on');

select test.eq((select count(*) from claim_storage_gc('gc-e', 50)
                where id = (select id from gc_b offset 2 limit 1))::int, 0,
               'a dead-lettered row is never claimed again');

select test.section('the audit still outlives everything');

select test.eq((select count(*) from deletion_audit
                where event_id = 'aaaa0000-0000-0000-0000-000000000c01'
                  and kind = 'event_retention')::int, 1,
               'the proof of deletion survives, independent of the bucket');

rollback;
