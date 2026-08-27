-- Core schema.
--
-- Everything here is scoped to a single event. There is deliberately no table,
-- column or index that would let you join a face embedding across two events —
-- that constraint is what keeps this a photo tool rather than an identity
-- database. See docs/COMPLIANCE.md.

-- ---------------------------------------------------------------------------
-- Jurisdiction allow-list
--
-- Illinois BIPA carries a private right of action with statutory damages per
-- violation and has produced nine-figure settlements; Texas CUBI and Washington
-- have their own regimes. Until counsel has signed off on a per-state gate we
-- refuse those events at the database, not in a form validator that the next
-- refactor can quietly drop.
-- ---------------------------------------------------------------------------
create table jurisdictions (
  code        text primary key,          -- ISO 3166-1 alpha-2, or 'US-IL' style for subdivisions
  name        text not null,
  allowed     boolean not null default false,
  reason      text not null              -- why it is or is not allowed; shown to the operator
);

comment on table jurisdictions is
  'Where we will accept events. Rows with allowed = false are refused by assert_jurisdiction_allowed().';

insert into jurisdictions (code, name, allowed, reason) values
  ('IL',    'Israel',         true,  'Primary market. Privacy Protection Law; database registration and DPO thresholds reviewed per docs/COMPLIANCE.md.'),
  ('DE',    'Germany',        true,  'EU/GDPR. Processor role with a signed DPA; controller is the event organizer.'),
  ('FR',    'France',         true,  'EU/GDPR.'),
  ('ES',    'Spain',          true,  'EU/GDPR.'),
  ('IT',    'Italy',          true,  'EU/GDPR.'),
  ('NL',    'Netherlands',    true,  'EU/GDPR.'),
  ('BE',    'Belgium',        true,  'EU/GDPR.'),
  ('PT',    'Portugal',       true,  'EU/GDPR.'),
  ('AT',    'Austria',        true,  'EU/GDPR.'),
  ('PL',    'Poland',         true,  'EU/GDPR.'),
  ('GR',    'Greece',         true,  'EU/GDPR.'),
  ('IE',    'Ireland',        true,  'EU/GDPR.'),
  ('US-IL', 'Illinois, USA',  false, 'BIPA: private right of action, statutory damages per violation. Blocked pending counsel.'),
  ('US-TX', 'Texas, USA',     false, 'CUBI: enforced by the state Attorney General. Blocked pending counsel.'),
  ('US-WA', 'Washington, USA',false, 'Washington biometric statute and My Health My Data Act. Blocked pending counsel.'),
  ('US',    'USA (other)',    false, 'No US events until counsel has reviewed a per-state gate.'),
  ('GB',    'United Kingdom', false, 'UK GDPR. Allowed once the international transfer position is documented.');

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create table events (
  id                    uuid primary key default gen_random_uuid(),
  operator_id           uuid not null references auth.users,
  name                  text not null check (length(btrim(name)) between 1 and 200),

  -- Public URL component. Random, not sequential: sequential slugs would let
  -- anyone walk the list of events. Generated application-side.
  slug                  text unique not null
                          check (slug ~ '^[a-z0-9]([a-z0-9-]{4,62})[a-z0-9]$'),

  event_date            date,
  status                text not null default 'draft'
                          check (status in ('draft', 'indexing', 'ready', 'expired')),

  photo_count           int not null default 0 check (photo_count >= 0),
  face_count            int not null default 0 check (face_count >= 0),

  -- Detections thrown away by the tier-0 gate. If this is a large fraction of
  -- (face_count + faces_rejected) the photographer is shooting wide crowds and
  -- the operator has to be told what recall to expect before the event, not after.
  faces_rejected        int not null default 0 check (faces_rejected >= 0),

  -- Enforced retention deadline. run_retention() deletes the event after this.
  -- The upper bound is a backstop against an operator setting a date so far out
  -- that the album becomes permanent storage of biometric data.
  delete_after          timestamptz not null,

  -- Evidence the organizer posted a photography/biometric notice at the venue.
  -- The organizer is the controller and owes the attendees this notice; we hold
  -- the link so the obligation is on the record.
  consent_notice_url    text,

  jurisdiction_code     text not null references jurisdictions (code),

  -- Minors. Requires a separate attestation from the organizer that parental
  -- consent has been handled before the album can be searched.
  is_youth_event        boolean not null default false,
  youth_attestation_at  timestamptz,
  youth_attestation_by  text,

  created_at            timestamptz not null default now(),

  constraint events_retention_window check (
    delete_after > created_at
    and delete_after <= created_at + interval '180 days'
  ),

  -- A youth event may be drafted and indexed, but cannot become searchable
  -- until the organizer has attested.
  constraint events_youth_attested_before_ready check (
    not is_youth_event
    or status <> 'ready'
    or youth_attestation_at is not null
  ),

  constraint events_youth_attestation_complete check (
    (youth_attestation_at is null) = (youth_attestation_by is null)
  )
);

create index events_operator_idx on events (operator_id);
create index events_retention_idx on events (delete_after) where status <> 'expired';

comment on column events.delete_after is
  'Hard retention deadline. Enforced by run_retention(), not by a promise in a contract.';

create or replace function assert_jurisdiction_allowed()
returns trigger
language plpgsql
as $$
declare
  j jurisdictions%rowtype;
begin
  select * into j from jurisdictions where code = new.jurisdiction_code;

  if not found then
    raise exception 'unknown jurisdiction %', new.jurisdiction_code
      using errcode = 'check_violation';
  end if;

  if not j.allowed then
    raise exception 'events in % are not accepted: %', j.name, j.reason
      using errcode = 'check_violation',
            hint = 'Change the jurisdiction allow-list only with sign-off from counsel.';
  end if;

  return new;
end;
$$;

create trigger events_jurisdiction_gate
  before insert or update of jurisdiction_code on events
  for each row execute function assert_jurisdiction_allowed();

-- ---------------------------------------------------------------------------
-- photos
-- ---------------------------------------------------------------------------
create table photos (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events on delete cascade,

  storage_bucket text not null default 'event-photos',
  storage_key   text not null,
  preview_key   text,                      -- watermarked, what an attendee sees before unlock
  thumb_key     text,

  -- Lets a re-upload of the same file be recognised instead of duplicated.
  content_hash  text,

  width         int check (width  > 0),
  height        int check (height > 0),
  bytes         bigint check (bytes > 0),

  taken_at      timestamptz,               -- from EXIF; enables time-window filtering

  status        text not null default 'pending'
                  check (status in ('pending', 'processing', 'done', 'failed')),
  error         text,

  faces_indexed      int not null default 0 check (faces_indexed >= 0),
  faces_rejected     int not null default 0 check (faces_rejected >= 0),

  created_at    timestamptz not null default now(),

  -- Re-running ingestion for an album must be idempotent (Phase 2 acceptance
  -- criterion). Uniqueness on the storage key is what makes the upsert safe.
  constraint photos_event_storage_key_uniq unique (event_id, storage_key)
);

create index photos_event_status_idx on photos (event_id, status);
create index photos_event_taken_at_idx on photos (event_id, taken_at);
create index photos_content_hash_idx on photos (event_id, content_hash)
  where content_hash is not null;

-- ---------------------------------------------------------------------------
-- faces
--
-- One row per face that survived the quality gate. We store the embedding and
-- the geometry needed to rank results — not the crop, and not the landmarks.
-- Anything we do not need for matching is a liability we would have to defend.
-- ---------------------------------------------------------------------------
create table faces (
  id            uuid primary key default gen_random_uuid(),
  photo_id      uuid not null references photos on delete cascade,
  event_id      uuid not null references events on delete cascade,

  embedding     vector(512) not null,      -- ArcFace w600k_r50, L2-normalized
  bbox          jsonb not null,            -- {x, y, w, h} in pixels

  det_score     real not null check (det_score >= 0 and det_score <= 1),
  face_px       int  not null check (face_px > 0),   -- min(bbox.w, bbox.h)

  yaw           real,
  pitch         real,
  roll          real,
  blur_score    real,

  -- Tier 0 means "rejected"; a tier-0 face is never written, so it is not a
  -- legal value here. The CHECK is the enforcement, the worker is the policy.
  quality_tier  smallint not null check (quality_tier in (1, 2)),

  cluster_id    uuid,                      -- Phase 3, set by the clustering job

  created_at    timestamptz not null default now()
);

-- Vector index.
--
-- Caveat worth knowing before Phase 3: an approximate HNSW scan combined with a
-- `where event_id = $1` filter post-filters, so a top-k query can come back with
-- fewer than k rows for that event even though more exist. pgvector 0.8 added
-- `hnsw.iterative_scan` to fix exactly this; set it in the search path handler.
-- The cluster centroid route in Phase 3 sidesteps the problem for large albums.
create index faces_embedding_hnsw_idx on faces
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

create index faces_event_tier_idx on faces (event_id, quality_tier);
create index faces_photo_idx on faces (photo_id);
create index faces_cluster_idx on faces (cluster_id) where cluster_id is not null;

-- ---------------------------------------------------------------------------
-- clusters (Phase 3)
-- ---------------------------------------------------------------------------
create table clusters (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events on delete cascade,
  centroid    vector(512) not null,
  face_count  int not null check (face_count > 0),
  created_at  timestamptz not null default now()
);

create index clusters_centroid_hnsw_idx on clusters
  using hnsw (centroid vector_cosine_ops) with (m = 16, ef_construction = 64);
create index clusters_event_idx on clusters (event_id);

alter table faces
  add constraint faces_cluster_fk foreign key (cluster_id)
  references clusters (id) on delete set null;

-- ---------------------------------------------------------------------------
-- search_logs
--
-- Audit trail for attendee searches. Contains NO biometric data: no embedding,
-- no crop, no raw IP. The point is to be able to show a regulator that searches
-- were rate-limited and logged, without the log itself becoming the breach.
-- ---------------------------------------------------------------------------
create table search_logs (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events on delete cascade,

  ip_hash           text,                  -- HMAC(ip, rotating server secret). Never a raw IP.
  results_returned  int not null default 0 check (results_returned >= 0),
  maybe_returned    int not null default 0 check (maybe_returned >= 0),
  top_score         real,
  duration_ms       int check (duration_ms >= 0),

  outcome           text not null default 'ok'
                      check (outcome in ('ok', 'no_match', 'rate_limited', 'rejected_quality', 'error')),

  created_at        timestamptz not null default now()
);

create index search_logs_event_created_idx on search_logs (event_id, created_at desc);
-- Supports "3 searches per ip_hash per event per hour".
create index search_logs_rate_limit_idx on search_logs (event_id, ip_hash, created_at desc);

-- ---------------------------------------------------------------------------
-- exclusions
--
-- Someone who does not want to be findable submits a selfie here. We keep the
-- embedding for one reason only: to subtract them from every future search in
-- this event. It is scoped to the event and dies with it.
-- ---------------------------------------------------------------------------
create table exclusions (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events on delete cascade,
  embedding   vector(512) not null,
  created_at  timestamptz not null default now()
);

create index exclusions_event_idx on exclusions (event_id);

comment on table exclusions is
  'Opt-out registry. The embedding is retained solely to enforce the opt-out and is scoped to one event.';
