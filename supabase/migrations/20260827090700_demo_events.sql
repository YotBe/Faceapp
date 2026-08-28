-- Demonstration events.
--
-- Moves the "untuned thresholds are refused" gate from the *deployment* to the
-- *event*, which is where the risk actually lives.
--
-- The rule protects against returning a stranger's photographs to a real
-- attendee at a real event. That is a property of the event, not of the server
-- it happens to run on — one deployment can host a demonstration and a real
-- wedding at the same time. Gating on NODE_ENV was a proxy for the real thing,
-- and a poor one: it made every deployed instance unable to search at all,
-- while a development instance searched every event on placeholder numbers with
-- nothing recorded about which.
--
-- After this, a demo event is a deliberate, per-event, recorded decision, and a
-- real event is still refused until thresholds have been measured. The rule is
-- narrower than before, not looser.

alter table events
  add column is_demo boolean not null default false,
  -- Who ticked the box and when. A claim that somebody had the right to use
  -- these photographs should be attributable, not ambient.
  add column demo_acknowledged_at timestamptz,
  add column demo_acknowledged_by text;

-- A demonstration is not a place to leave biometric data lying around, and it
-- has no contract behind it. Four weeks, hard.
alter table events
  add constraint events_demo_retention_is_short check (
    not is_demo or delete_after <= created_at + interval '30 days'
  );

alter table events
  add constraint events_demo_is_acknowledged check (
    is_demo = (demo_acknowledged_at is not null)
  );

alter table events
  add constraint events_demo_acknowledgement_complete check (
    (demo_acknowledged_at is null) = (demo_acknowledged_by is null)
  );

comment on column events.is_demo is
  'Searchable on untuned placeholder thresholds. Results are not trustworthy and every surface says so.';
