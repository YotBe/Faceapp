-- Minimal assertion helpers.
--
-- Deliberately not pgTAP: these tests have to run in CI with nothing but psql,
-- and a failed assertion raising an exception under `ON_ERROR_STOP=1` is all the
-- reporting we need.
--
-- Each helper returns its label as text rather than raising a NOTICE, so that
-- `psql -t -A` prints one clean line per assertion.
--
-- TEST FIXTURE ONLY. Never applied to a Supabase project.

create schema if not exists test;

-- The tests run as `authenticated` and `anon` for most of their length, so those
-- roles need to be able to reach the helpers themselves. Without this every
-- assertion under an impersonated role fails on the schema, not on the thing
-- being tested.
grant usage on schema test to public;

create or replace function test.ok(cond boolean, what text)
returns text
language plpgsql
as $$
begin
  if cond is not true then
    raise exception E'\n  FAIL  %', what;
  end if;
  return '  ok    ' || what;
end;
$$;

create or replace function test.eq(got anyelement, want anyelement, what text)
returns text
language plpgsql
as $$
begin
  if got is distinct from want then
    raise exception E'\n  FAIL  %\n        got:  %\n        want: %', what, got, want;
  end if;
  return '  ok    ' || what;
end;
$$;

-- Asserts that a statement is rejected, and that the failure is the one we
-- meant to provoke rather than a typo in the fixture.
create or replace function test.rejects(stmt text, expect_substring text, what text)
returns text
language plpgsql
as $$
declare
  msg text;
begin
  begin
    execute stmt;
  exception when others then
    msg := sqlerrm;
    if position(lower(expect_substring) in lower(msg)) = 0 then
      raise exception E'\n  FAIL  %\n        rejected, but for the wrong reason: %', what, msg;
    end if;
    return '  ok    ' || what;
  end;
  raise exception E'\n  FAIL  %\n        statement was accepted but should have been rejected', what;
end;
$$;

-- Runs a statement and reports how many rows it touched.
--
-- This is how "RLS made the write a no-op" is distinguished from "RLS raised":
-- a policy that filters rows out of an UPDATE or DELETE does not error, it
-- silently affects nothing, and that distinction is the whole point of the
-- cross-operator write tests. Invoker-rights, so it runs as whichever role the
-- test has assumed.
create or replace function test.affected(stmt text)
returns int
language plpgsql
as $$
declare
  n int;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- A deterministic 512-dim vector, so fixtures do not need a 512-element literal.
-- Not normalized and not meaningful as a face — these tests are about access
-- control and deletion, not about matching.
create or replace function test.vec(seed double precision)
returns vector
language sql
immutable
as $$
  select (
    select array_agg(sin(seed * (i + 1))::real order by i)
    from generate_series(0, 511) as i
  )::vector;
$$;

-- Impersonation is done inline in the test files with plain
--   set local request.jwt.claims = '{"sub":"..."}';
--   set local role authenticated;
-- rather than through a helper: `SET LOCAL` issued inside a function can be
-- unwound at function exit, which would silently leave the test running as
-- superuser and passing for the wrong reason.

create or replace function test.section(title text)
returns text
language sql
immutable
as $$
  select E'\n' || title;
$$;
