-- Local Supabase shim.
--
-- The migrations reference `auth.users` and `auth.uid()`, and the RLS policies
-- reference the `anon` / `authenticated` / `service_role` roles. On a real
-- Supabase project all of that already exists. This file recreates just enough
-- of it that the same migrations apply unmodified to a plain Postgres, so the
-- acceptance tests exercise the real policies rather than a copy of them.
--
-- TEST FIXTURE ONLY. Never applied to a Supabase project.

-- Roles -----------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- BYPASSRLS matches Supabase: the server-side worker and the attendee
    -- search route handler run as this role and are not filtered by policies.
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

-- auth schema -----------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Supabase derives the current user from the `sub` claim of the request JWT,
-- which PostgREST exposes as the `request.jwt.claims` setting. Same mechanism
-- here, so the policies under test are the ones that will run in production.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
