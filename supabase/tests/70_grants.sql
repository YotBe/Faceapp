-- Privileges, as a browser role actually sees them.
--
-- The bug this guards against was invisible for the life of the project: the
-- local shim granted nothing beyond what the migrations asked for, while a real
-- Supabase project grants `all on tables` and `all on functions` in the public
-- schema to `anon` and `authenticated` by default. The shim now reproduces
-- that, so these assertions are about the deployed shape rather than a
-- friendlier local one.
--
-- The SECURITY DEFINER functions are the part that mattered. They run as their
-- owner and RLS does not apply to them, and Supabase publishes every function
-- in this schema at /rest/v1/rpc/<name>. Executable by `anon` means executable
-- by anyone who opens an attendee page and reads the key out of the JavaScript.

\set ON_ERROR_STOP on
\set QUIET on

begin;

select test.section('the browser roles cannot call the privileged functions');

-- has_function_privilege takes a role and a signature; the six below are every
-- SECURITY DEFINER function in the schema.
select test.eq(
  has_function_privilege('anon', 'run_retention(int)', 'execute'),
  false, 'anon cannot delete every expired event with one POST');

select test.eq(
  has_function_privilege('authenticated', 'run_retention(int)', 'execute'),
  false, 'nor can a signed-in operator, for somebody else''s events');

select test.eq(
  has_function_privilege('anon', 'log_selfie_deletion(uuid, int, int, text)', 'execute'),
  false, 'anon cannot forge proof that a selfie was destroyed');

select test.eq(
  has_function_privilege('anon', 'claim_ingest_jobs(text, int, interval)', 'execute'),
  false, 'anon cannot claim the ingestion queue out from under the worker');

select test.eq(
  has_function_privilege('anon', 'finish_ingest_job(bigint, boolean, text, int, int)', 'execute'),
  false, 'anon cannot mark photographs indexed that were never indexed');

select test.eq(
  has_function_privilege('anon', 'claim_storage_gc(text, int, interval)', 'execute'),
  false, 'anon cannot stall the deletion of bytes from the bucket');

select test.eq(
  has_function_privilege('anon', 'finish_storage_gc(bigint, boolean, text)', 'execute'),
  false, 'nor mark those deletions done without doing them');

select test.section('no browser role may write to any table');

-- Anything other than an empty list here is a table a browser role could write
-- to if its RLS policy were ever dropped or forgotten. RLS is the control;
-- this is the second lock on the same door.
select test.eq(
  (select coalesce(string_agg(distinct grantee || '.' || table_name || '.' || privilege_type,
                              ', ' order by grantee || '.' || table_name || '.' || privilege_type), '')
     from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      and not (grantee = 'authenticated' and table_name = 'events')
      and not (grantee = 'authenticated' and table_name = 'photos'
               and privilege_type = 'DELETE')),
  '', 'only the operator''s own events and photo deletions are writable');

select test.section('the tables a browser role must not read at all');

select test.eq(
  has_table_privilege('anon', 'operator_credentials', 'select'),
  false, 'anon cannot read password hashes');

select test.eq(
  has_table_privilege('authenticated', 'operator_credentials', 'select'),
  false, 'and neither can a signed-in operator');

select test.eq(
  has_table_privilege('authenticated', 'exclusions', 'select'),
  false, 'an opt-out embedding is not the operator''s to read');

select test.eq(
  has_table_privilege('authenticated', 'storage_gc_queue', 'select'),
  false, 'the deletion queue belongs to the worker');

select test.eq(
  has_table_privilege('anon', 'storage_gc_backlog', 'select'),
  false, 'and so does the backlog view over it');

select test.section('what an operator must still be able to do');

-- The other half of the same rule: revoke too much and the dashboard breaks in
-- a way that only shows up in a browser.
select test.eq(has_table_privilege('authenticated', 'events', 'select'), true,
               'an operator reads their own events');
select test.eq(has_table_privilege('authenticated', 'events', 'insert'), true,
               'and creates them');
select test.eq(has_table_privilege('authenticated', 'photos', 'select'), true,
               'sees the photographs in them');
select test.eq(has_table_privilege('authenticated', 'photos', 'delete'), true,
               'and can remove one');
select test.eq(has_table_privilege('authenticated', 'faces', 'select'), true,
               'sees how each face was graded');
select test.eq(has_table_privilege('authenticated', 'ingest_jobs', 'select'), true,
               'and can watch the queue drain');
select test.eq(has_table_privilege('anon', 'jurisdictions', 'select'), true,
               'the jurisdiction list stays public reference data');

select test.section('the jurisdiction gate still fires after the revoke');

-- A trigger function is executed by the system rather than by the invoking
-- role, so revoking EXECUTE from the browser roles must not disarm it. This is
-- the assertion that says so rather than assuming it.
insert into auth.users (id, email) values
  ('88888888-8888-8888-8888-888888888888', 'grants@example.com');

set local role authenticated;
select set_config('request.jwt.claims',
                  '{"sub":"88888888-8888-8888-8888-888888888888","role":"authenticated"}',
                  true) \gset dummy_

select test.rejects(
  $q$insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
     values ('88888888-8888-8888-8888-888888888888', 'Chicago wedding',
             'chicago-wedding-grants', now() + interval '30 days', 'US-IL')$q$,
  'not accepted',
  'Illinois is still refused, as the authenticated role, with no EXECUTE grant');

insert into events (operator_id, name, slug, delete_after, jurisdiction_code)
values ('88888888-8888-8888-8888-888888888888', 'Tel Aviv wedding',
        'tel-aviv-wedding-grants', now() + interval '30 days', 'IL');
select test.ok(true, 'and an allowed jurisdiction still inserts');

reset role;

rollback;
