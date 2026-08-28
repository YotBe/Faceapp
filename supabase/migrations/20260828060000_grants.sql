-- Privileges on a managed Supabase project.
--
-- This exists because of something the linter found on the first real
-- deployment, which no local test could have caught: Supabase ships default
-- privileges that `grant all on tables` and `grant all on functions` in the
-- public schema to `anon` and `authenticated`. Every table created by
-- `20260827090100_core_schema.sql` therefore arrived with INSERT, UPDATE,
-- DELETE and TRUNCATE granted to the role that a browser holding the public
-- anon key runs as.
--
-- Two of the consequences differ enormously in severity.
--
-- The table grants were survivable: RLS is enabled on every table, so `anon`
-- with SELECT and no policy still reads nothing. That is the design working —
-- but it is one layer deep, and the day somebody adds a table and forgets
-- `enable row level security`, it becomes a public read/write endpoint.
--
-- **The function grants were not survivable.** A SECURITY DEFINER function runs
-- as its owner and is not filtered by RLS at all — that is the entire point of
-- it. Supabase exposes every function in the public schema at
-- `/rest/v1/rpc/<name>`. So `run_retention`, `log_selfie_deletion`,
-- `claim_ingest_jobs`, `finish_ingest_job`, `claim_storage_gc` and
-- `finish_storage_gc` were all callable by anyone holding the anon key, which
-- is published in the browser. Deleting events, forging deletion-audit rows,
-- and starving both workers were one POST away.
--
-- `revoke all ... from public` in the earlier migrations did not prevent this:
-- PUBLIC and a named role are different grantees, and revoking from one does
-- nothing to the other.
--
-- So: revoke everything, grant back exactly what the RLS migration intended,
-- and turn off the default privileges so the next table does not inherit the
-- problem. `supabase/tests/lib/local_shim.sql` now reproduces Supabase's
-- defaults, so the acceptance tests fail if this file is ever lost.

-- ---------------------------------------------------------------------------
-- Stop the bleeding
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- And on anything created from here on.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grant back precisely what 20260827090300_rls.sql intended, and nothing else.
--
-- Every one of these is a table with a matching policy. A grant without a
-- policy is a table `authenticated` cannot read anyway; a policy without a
-- grant is a policy that never runs. They come in pairs or they are a bug.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on jurisdictions to anon, authenticated;

grant select, insert, update, delete on events to authenticated;
grant select, delete                 on photos to authenticated;
grant select on faces          to authenticated;
grant select on clusters       to authenticated;
grant select on search_logs    to authenticated;
grant select on deletion_audit to authenticated;
grant select on ingest_jobs    to authenticated;

-- exclusions, operator_credentials, storage_gc_queue: deliberately nothing. An
-- opt-out embedding belongs to someone who asked not to be found, a password
-- hash belongs to nobody's browser, and the GC queue is the worker's.

-- ---------------------------------------------------------------------------
-- storage_gc_backlog
--
-- A view created by `postgres` runs with the *creator's* rights unless it says
-- otherwise, so it reads through RLS rather than being subject to it. It counts
-- rows in a table nobody but the worker may see, so it must not be a way around
-- that. security_invoker makes it obey the caller's policies, and the revoke
-- above already means no browser role can select from it at all.
-- ---------------------------------------------------------------------------
alter view storage_gc_backlog set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Pin the trigger function's search_path
--
-- Every other function here pins it; this one was missed. A function with a
-- mutable search_path can be made to resolve `jurisdictions` to something the
-- caller controls, and this particular function is the gate that refuses events
-- in Illinois and Texas.
-- ---------------------------------------------------------------------------
alter function assert_jurisdiction_allowed() set search_path = public, pg_catalog;

-- Not addressed on purpose: the `vector` extension lives in the public schema,
-- which the linter also flags. Moving it would rewrite the type name in every
-- column and index in `faces`, `clusters` and `exclusions` for no security
-- benefit — the risk it describes is a search_path attack, and every function
-- here now pins one.
