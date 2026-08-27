-- Row Level Security.
--
-- Two roles matter here:
--
--   authenticated  an operator signed in through Supabase Auth. Sees their own
--                  events and nothing else.
--   anon           an attendee's browser. Sees the jurisdiction list and
--                  nothing else. Attendee search runs server-side through a
--                  service-role route handler with rate limiting; the attendee
--                  client never touches the database directly.
--
-- RLS is ENABLED but deliberately not FORCEd. Forcing would apply these
-- policies to the table owner too, and run_retention() is SECURITY DEFINER
-- running as the owner — it would then be unable to see the events it exists to
-- delete. service_role carries BYPASSRLS for the same reason.
--
-- Privileges are granted explicitly rather than leaning on Supabase's default
-- privileges, because RLS is only meaningful for a role that has table
-- privileges in the first place. A missing GRANT and a working policy look
-- identical in a passing test and very different in production.

grant usage on schema public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- jurisdictions — public reference data
-- ---------------------------------------------------------------------------
alter table jurisdictions enable row level security;
grant select on jurisdictions to anon, authenticated;

create policy jurisdictions_read_all on jurisdictions
  for select to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- events — the ownership root. Every other policy hangs off this one.
-- ---------------------------------------------------------------------------
alter table events enable row level security;
grant select, insert, update, delete on events to authenticated;

create policy events_select_own on events
  for select to authenticated
  using (operator_id = (select auth.uid()));

create policy events_insert_own on events
  for insert to authenticated
  with check (operator_id = (select auth.uid()));

create policy events_update_own on events
  for update to authenticated
  using (operator_id = (select auth.uid()))
  with check (operator_id = (select auth.uid()));

create policy events_delete_own on events
  for delete to authenticated
  using (operator_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- photos — readable and removable by the owning operator. Writes come from the
-- ingestion worker under service_role, not from the browser.
-- ---------------------------------------------------------------------------
alter table photos enable row level security;
grant select, delete on photos to authenticated;

create policy photos_select_own on photos
  for select to authenticated
  using (exists (
    select 1 from events e
    where e.id = photos.event_id
      and e.operator_id = (select auth.uid())
  ));

create policy photos_delete_own on photos
  for delete to authenticated
  using (exists (
    select 1 from events e
    where e.id = photos.event_id
      and e.operator_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- faces — read-only for the operator.
--
-- The operator can see that a face was detected and how it was graded, which is
-- what the ingestion dashboard needs. Only the worker writes here.
-- ---------------------------------------------------------------------------
alter table faces enable row level security;
grant select on faces to authenticated;

create policy faces_select_own on faces
  for select to authenticated
  using (exists (
    select 1 from events e
    where e.id = faces.event_id
      and e.operator_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- clusters — read-only. Powers the "N distinct people in this album" view.
-- ---------------------------------------------------------------------------
alter table clusters enable row level security;
grant select on clusters to authenticated;

create policy clusters_select_own on clusters
  for select to authenticated
  using (exists (
    select 1 from events e
    where e.id = clusters.event_id
      and e.operator_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- search_logs — read-only, for the operator's analytics.
-- ---------------------------------------------------------------------------
alter table search_logs enable row level security;
grant select on search_logs to authenticated;

create policy search_logs_select_own on search_logs
  for select to authenticated
  using (exists (
    select 1 from events e
    where e.id = search_logs.event_id
      and e.operator_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- deletion_audit — the operator can read the proof of deletion for their own
-- events, which is what they will need to answer their own attendees.
--
-- No FK to events means no join to authorise against once the event is gone, so
-- the policy matches on operator ownership while the event exists and falls
-- back to denying rows for events that have been deleted. Post-deletion audit
-- rows are reachable through support, not through the dashboard; that is the
-- correct trade — the alternative is denormalising operator_id into the audit
-- table, which would keep an operator identifier alive after the event that
-- justified holding it has been erased.
-- ---------------------------------------------------------------------------
alter table deletion_audit enable row level security;
grant select on deletion_audit to authenticated;

create policy deletion_audit_select_own on deletion_audit
  for select to authenticated
  using (exists (
    select 1 from events e
    where e.id = deletion_audit.event_id
      and e.operator_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- exclusions — no policy, on purpose.
--
-- RLS is on and nothing is granted, so `authenticated` and `anon` are denied
-- outright. An opt-out embedding belongs to a person who asked not to be found;
-- the operator has no reason to read it and every reason not to be able to. The
-- opt-out flow runs entirely under service_role.
-- ---------------------------------------------------------------------------
alter table exclusions enable row level security;

-- ---------------------------------------------------------------------------
-- storage_gc_queue — no policy. Worker-only.
-- ---------------------------------------------------------------------------
alter table storage_gc_queue enable row level security;
