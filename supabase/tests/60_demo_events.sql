-- Demonstration events, and the gate that only they may pass.

\set ON_ERROR_STOP on
\set QUIET on

begin;

insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777777', 'demo-gate@example.com');

select test.section('a normal event is not a demo');

insert into events (id, operator_id, name, slug, delete_after, jurisdiction_code)
values ('11110000-0000-0000-0000-000000000001',
        '77777777-7777-7777-7777-777777777777', 'Real wedding',
        'real-wedding-gate-1', now() + interval '60 days', 'IL');

select test.eq((select is_demo from events where id = '11110000-0000-0000-0000-000000000001'),
               false, 'is_demo defaults to false — you have to ask for it');

select test.section('a demo event must be acknowledged');

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code, is_demo)
     values ('77777777-7777-7777-7777-777777777777', 'Unacknowledged demo',
             'unack-demo-1', now() + interval '20 days', 'IL', true)$q$,
  'events_demo_is_acknowledged',
  'ticking the box without recording who did it is refused');

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code,
                         demo_acknowledged_at, demo_acknowledged_by)
     values ('77777777-7777-7777-7777-777777777777', 'Acknowledged non-demo',
             'ack-nondemo-1', now() + interval '20 days', 'IL', now(), 'someone')$q$,
  'events_demo_is_acknowledged',
  'and an acknowledgement without the flag is equally refused');

insert into events (id, operator_id, name, slug, delete_after, jurisdiction_code,
                    is_demo, demo_acknowledged_at, demo_acknowledged_by)
values ('11110000-0000-0000-0000-000000000002',
        '77777777-7777-7777-7777-777777777777', 'Demonstration',
        'demonstration-gate-1', now() + interval '20 days', 'IL',
        true, now(), 'demo-gate@example.com');
select test.ok(true, 'a properly acknowledged demo event is accepted');

select test.section('a demo cannot linger');

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code,
                         is_demo, demo_acknowledged_at, demo_acknowledged_by)
     values ('77777777-7777-7777-7777-777777777777', 'Long demo',
             'long-demo-1', now() + interval '90 days', 'IL',
             true, now(), 'x@example.com')$q$,
  'events_demo_retention_is_short',
  'a demo is capped at 30 days, however long a real event may run');

select test.eq(
  test.affected($q$update events set delete_after = now() + interval '90 days'
                   where id = '11110000-0000-0000-0000-000000000001'$q$),
  1, 'while a real event may still be kept for its full contractual term');

select test.section('the acknowledgement cannot be half-erased');

select test.rejects(
  $q$update events set demo_acknowledged_by = null
     where id = '11110000-0000-0000-0000-000000000002'$q$,
  'events_demo_acknowledgement_complete',
  'you cannot drop who acknowledged it and keep the timestamp');

rollback;
