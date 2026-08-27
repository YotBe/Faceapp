-- Operator credentials and event branding.
--
-- On a real Supabase project, operator identity is Supabase Auth's job and
-- `operator_credentials` stays empty — `src/lib/auth.ts` is the seam, and
-- swapping it for `@supabase/ssr` is the whole migration. The table exists so
-- the application can be run, developed and tested against a plain Postgres
-- without standing up a Supabase project first, which matters more than it
-- sounds: an app you cannot run locally is an app whose tests are all mocks.
--
-- Passwords are scrypt hashes with a per-row salt, stored as one
-- `scrypt$N$r$p$salt$hash` string so the parameters travel with the digest and
-- can be raised later without invalidating existing rows.

create table operator_credentials (
  user_id        uuid primary key references auth.users on delete cascade,
  email          text unique not null check (position('@' in email) > 1),
  password_hash  text not null,
  created_at     timestamptz not null default now()
);

comment on table operator_credentials is
  'Local/self-hosted operator login. Unused when Supabase Auth is the identity provider.';

-- Never readable from a browser session under any policy: RLS on with no
-- policy and no grant. The login route runs under the service role.
alter table operator_credentials enable row level security;

-- ---------------------------------------------------------------------------
-- Branding, and the attendee-facing copy an organizer is responsible for.
-- ---------------------------------------------------------------------------
alter table events
  add column brand_color text
    check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  add column brand_logo_key text,
  -- Shown on the attendee page above the camera. The organizer is the
  -- controller; this is where they say who they are and what they collected.
  add column welcome_message text check (length(welcome_message) <= 500);
