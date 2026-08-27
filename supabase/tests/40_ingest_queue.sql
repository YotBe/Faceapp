-- Phase 2 acceptance: killing a worker mid-batch loses no jobs, and re-running
-- ingestion is idempotent.

\set ON_ERROR_STOP on
\set QUIET on

begin;

insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'queue@example.com');

insert into events (id, operator_id, name, slug, delete_after, jurisdiction_code, status)
values ('ffffffff-0000-0000-0000-000000000001',
        '55555555-5555-5555-5555-555555555555', 'Queue test',
        'queue-test-event', now() + interval '30 days', 'IL', 'indexing');

insert into photos (id, event_id, storage_key)
select ('ffffffff-1111-0000-0000-00000000000' || i)::uuid,
       'ffffffff-0000-0000-0000-000000000001',
       'q/' || i || '.jpg'
from generate_series(1, 6) as i;

insert into ingest_jobs (photo_id, event_id)
select id, event_id from photos where event_id = 'ffffffff-0000-0000-0000-000000000001';

select test.section('claiming');

create temporary table claim_a on commit drop as
  select * from claim_ingest_jobs('worker-a', 3);

select test.eq((select count(*) from claim_a)::int, 3, 'worker A claims three jobs');
select test.eq((select count(distinct state) from claim_a)::int, 1, 'all in one state');
select test.eq((select distinct state from claim_a), 'running', 'and that state is running');
select test.eq((select distinct attempts from claim_a), 1, 'attempt counter incremented');

create temporary table claim_b on commit drop as
  select * from claim_ingest_jobs('worker-b', 3);

select test.eq((select count(*) from claim_b)::int, 3, 'worker B claims the other three');
select test.eq(
  (select count(*) from claim_a a join claim_b b on a.id = b.id)::int, 0,
  'the two workers never got the same job');

select test.eq((select count(*) from claim_ingest_jobs('worker-c', 10))::int, 0,
               'a third worker finds nothing left to claim');

select test.section('a worker that dies releases its jobs');

-- Worker A is killed. It cannot mark anything; its lease simply runs out.
update ingest_jobs
   set locked_until = now() - interval '1 second'
 where locked_by = 'worker-a';

create temporary table reclaimed on commit drop as
  select * from claim_ingest_jobs('worker-d', 10);

select test.eq((select count(*) from reclaimed)::int, 3,
               'worker D picks up exactly the dead worker''s three jobs');
select test.eq((select count(*) from reclaimed where locked_by = 'worker-d')::int, 3,
               'and now holds the lease');
select test.eq((select distinct attempts from reclaimed), 2,
               'the retry is counted, so a job that kills workers cannot loop forever');
select test.eq(
  (select count(*) from reclaimed r join claim_b b on r.id = b.id)::int, 0,
  'worker B''s live jobs were not stolen');

select test.section('completion');

select test.eq(finish_ingest_job((select id from claim_b limit 1), true, null, 4, 2),
               'done', 'a successful job reports done');

select test.eq((select faces_indexed from photos
                where id = (select photo_id from claim_b limit 1)), 4,
               'the photo records what was indexed');
select test.eq((select faces_rejected from photos
                where id = (select photo_id from claim_b limit 1)), 2,
               'and what the gate threw away');
select test.eq((select face_count from events
                where id = 'ffffffff-0000-0000-0000-000000000001'), 4,
               'the event total rolls up');
select test.eq((select faces_rejected from events
                where id = 'ffffffff-0000-0000-0000-000000000001'), 2,
               'including rejections, so the operator can be warned about recall');

select test.eq((select status from events
                where id = 'ffffffff-0000-0000-0000-000000000001'), 'indexing',
               'the event stays indexing while work remains');

select test.section('failure, backoff and the dead letter queue');

-- Take a job all the way to its attempt limit.
select test.eq(
  finish_ingest_job((select id from reclaimed limit 1), false, 'truncated JPEG'),
  'pending', 'a first failure reschedules rather than giving up');

select test.ok(
  (select run_after > now() from ingest_jobs where id = (select id from reclaimed limit 1)),
  'and backs off into the future so it cannot spin a worker');

select test.eq(
  (select state from ingest_jobs where id = (select id from reclaimed limit 1)),
  'pending', 'the job is queued again, not lost');

update ingest_jobs set attempts = max_attempts, run_after = now()
 where id = (select id from reclaimed limit 1);

select test.eq(
  finish_ingest_job((select id from reclaimed limit 1), false, 'truncated JPEG'),
  'failed', 'once the attempt limit is spent it lands in the dead letter queue');

select test.eq((select status from photos
                where id = (select photo_id from reclaimed limit 1)), 'failed',
               'the photo is marked failed');
select test.eq((select error from photos
                where id = (select photo_id from reclaimed limit 1)), 'truncated JPEG',
               'with the reason, so the operator sees it rather than a silent gap');

select test.eq((select count(*) from claim_ingest_jobs('worker-e', 10)
                where id = (select id from reclaimed limit 1))::int, 0,
               'a dead-lettered job is never claimed again');

select test.section('the event opens once the queue drains');

do $$
declare j record;
begin
  for j in select id from ingest_jobs
            where event_id = 'ffffffff-0000-0000-0000-000000000001'
              and state in ('pending', 'running')
  loop
    perform finish_ingest_job(j.id, true, null, 1, 0);
  end loop;
end;
$$;

select test.eq((select status from events
                where id = 'ffffffff-0000-0000-0000-000000000001'), 'ready',
               'a dead-lettered photo does not hold the album hostage');

select test.section('re-ingest is idempotent');

select test.eq(
  test.affected($q$insert into ingest_jobs (photo_id, event_id)
                   select id, event_id from photos
                    where event_id = 'ffffffff-0000-0000-0000-000000000001'
                   on conflict (photo_id) do nothing$q$),
  0, 're-enqueueing an album creates no duplicate jobs');

rollback;
