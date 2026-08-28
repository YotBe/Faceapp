# Deployment

This is four services, not one. A serverless host runs the web app; it cannot
run the other three, and pretending otherwise is how you end up with a
deployment that looks live and loses every photograph uploaded to it.

| Component | What it is | Where it can go |
|---|---|---|
| Web app | Next.js route handlers and pages | Vercel, or any Node host |
| Database | Postgres **with pgvector** | Supabase, Neon, RDS, your own |
| Enrollment service | Python, onnxruntime, ~400MB resident | A container. Fly.io, Railway, Render |
| Ingestion worker | Long-running queue consumer | The same container image, different role |
| Object storage | Originals, previews, thumbnails | Supabase Storage, Cloudflare R2 |

The web app degrades honestly: with anything missing, the home page names what
is absent instead of returning a 500, and `/setup` probes every dependency for
real — it connects, queries, signs and calls, rather than checking whether a
variable happens to be set.

**For the click-by-click version of all of this — Supabase, Railway and Vercel,
with every value named — see [`DEPLOY_WALKTHROUGH.md`](DEPLOY_WALKTHROUGH.md).**
This document is the reasoning behind it.

---

## 1. Database

Any Postgres 16 with pgvector. On Supabase, `vector` is available out of the box.

```bash
supabase link --project-ref <ref>
supabase db push
```

Or against any other Postgres, apply `supabase/migrations/*.sql` in filename
order. They are plain SQL and reference `auth.users` and `auth.uid()`; if you
are not using Supabase Auth, apply `supabase/tests/lib/local_shim.sql` first,
which creates the minimum those references need.

**pgvector 0.8 or newer is strongly preferred.** Below that there is no
`hnsw.iterative_scan`, and an approximate index scan combined with a per-event
filter can return fewer matches than exist — an attendee silently loses
photographs. The app detects the version and adapts, but the older behaviour is
a real recall loss, not a warning to ignore.

Set a region in the EU or Israel for EU events. It cannot be changed later.

**Supabase's default privileges are wider than this schema wants.** A managed
project ships `alter default privileges ... grant all` in the public schema to
`anon` and `authenticated`, so every table these migrations create arrives with
INSERT, UPDATE, DELETE and TRUNCATE granted to the role a browser runs as. RLS
holds the line on the tables — enabled everywhere, so SELECT without a policy
reads nothing — but it does not apply to a SECURITY DEFINER function, and
Supabase publishes every function in the schema at `/rest/v1/rpc/<name>`.
`run_retention`, `log_selfie_deletion` and both queue pairs were therefore one
POST away for anyone holding the public anon key.

`20260828060000_grants.sql` revokes all of it and grants back exactly the set
`20260827090300_rls.sql` intended. `revoke ... from public` in the earlier
migrations does not do this: PUBLIC and a named role are different grantees.
Run the dashboard's security advisor after applying migrations, and check
`has_function_privilege('anon', 'run_retention(int)', 'execute')` is false.

## 2. Object storage

Anything that speaks S3. Supabase Storage and Cloudflare R2 are both first-class;
one driver covers both.

```
S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
S3_REGION=eu-central-1
S3_BUCKET=faceapp-photos
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

The `R2_*` names are accepted as aliases, so an existing R2 configuration keeps
working unchanged:

```
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=faceapp-photos
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

Region is configuration rather than a constant because the two providers
disagree: R2 has no regions and wants the literal `auto`, while Supabase signs
with the project's real region and rejects `auto`. The default is `auto`, which
is right for R2 and wrong for everyone else.

All of them, or none. A partially configured bucket falls back to the local
filesystem driver, and on a serverless host that filesystem is read-only or
discarded between requests — the upload succeeds, no error is logged anywhere,
and the photograph is gone. `env.s3Configured` is what makes that impossible;
both the web app and the worker refuse to start in a half-configured state
rather than fall back.

Attendees get presigned URLs straight from the bucket, so photographs never
transit the web app and never touch its egress bill. R2 becomes worth the extra
account somewhere past ~200GB, where its lack of egress charges starts to
matter; below that, keeping storage in the same Supabase project as the database
is one fewer vendor and one fewer DPA.

Do **not** make the bucket public. Every URL the product hands out expires,
which is the whole point.

## 3. ML container

One image, two roles.

```bash
docker build -t faceapp-ml ml/

docker run -d --name faceapp-service -p 8000:8000 \
  -e DATABASE_URL=... -e ML_SERVICE_TOKEN=... \
  -e S3_ENDPOINT=... -e S3_REGION=... -e S3_BUCKET=... \
  -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
  faceapp-ml service

docker run -d --name faceapp-worker \
  -e DATABASE_URL=... -e ML_SERVICE_TOKEN=... \
  -e S3_ENDPOINT=... -e S3_REGION=... -e S3_BUCKET=... \
  -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
  faceapp-ml worker
```

The buffalo_l model is baked into the image, so a deploy does not download
280MB on its first request, and the model cannot change under a running
deployment — which is what lets an eval report stay a statement about what is
actually deployed.

**Sizing.** One shared vCPU indexes a photograph in roughly
`130ms + 145ms per face that survives the quality gate`. A 5,000-photo album
averaging three surviving faces is about 45 minutes on one worker, or under ten
on eight. The worker holds the whole image in memory while it works, so 2GB per
replica is comfortable and 1GB is tight for 24-megapixel originals.

The enrollment service is memory-bound, not CPU-bound: one process, ~1GB, and
scale with replicas. `--workers 2` doubles the memory because uvicorn workers do
not share the model.

**`/enroll` requires `Authorization: Bearer $ML_SERVICE_TOKEN`.** What that
endpoint does is turn face photographs into biometric templates, and Railway,
Render and Fly all hand a container a public URL — advice to "keep it off the
internet" is advice to do something the platform does not offer. So the service
refuses to start without a token of at least 16 characters, rather than
defaulting to open. `/health` stays unauthenticated and returns no detail,
because the platform's health check needs it.

Still prefer a private network where one exists — a Fly `.internal` address or a
Railway private domain — and set the token as well. The token is what makes a
public URL survivable, not a reason to choose one.

## 4. Web app

Set on the host, not in a file:

```
DATABASE_URL=postgres://...
APP_SECRET=<openssl rand -base64 48>
IP_HASH_SECRET=<a different one>
ML_SERVICE_URL=http://faceapp-service.internal:8000
ML_SERVICE_TOKEN=<the same value as the container>
S3_ENDPOINT=...
S3_REGION=...
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
SEARCH_RATE_LIMIT_PER_HOUR=3
```

`APP_SECRET` signs session cookies and local storage URLs. It has no default and
never will: one that quietly falls back to a constant lets anyone mint signed
URLs for a stranger's photographs.

`IP_HASH_SECRET` salts the hash in `search_logs`. Separate so it can be rotated
on its own, which is the point of salting.

`ML_SERVICE_TOKEN` must be byte-identical here and on both containers.
Copy it rather than retyping; a trailing newline from a shell is the usual
cause of a search that fails with a token error against a token that looks
right.

There is **no environment variable that turns on untuned thresholds**. There
used to be, and it was the wrong shape: it applied to every event in a
deployment at once. The gate is now per event — see §6 — so a demonstration and
a real wedding can live on the same deployment with only one of them able to
search.

## 5. Scheduled jobs

**Retention** — hourly. `20260827090200_retention.sql` schedules it via
pg_cron where that extension can be installed, and prints a notice where it
cannot. Which of the two happened is worth checking rather than assuming:

```sql
select jobname, schedule, active from cron.job;   -- errors if pg_cron is absent
```

Where it is absent, run `select run_retention(500);` from an external scheduler
and confirm it is actually running. A retention job that silently stopped looks
exactly like one that has nothing to do.

**Storage GC** — every 15 minutes or so, after retention:

```bash
docker run --rm -e DATABASE_URL=... \
  -e S3_ENDPOINT=... -e S3_REGION=... -e S3_BUCKET=... \
  -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
  faceapp-ml storage-gc
```

It exits when the queue drains, so it suits a scheduled job; `--forever` makes
it a long-running service instead.

**Monitor it.** The process exits non-zero while any row is dead-lettered, and
`select * from storage_gc_backlog` reports the state. Alert on
`oldest_pending_age` above an hour and on `dead_lettered` above zero — those are
photographs still in the bucket after their event was erased. A queue depth
alone will not tell you: a stalled queue and a busy one look the same.

```bash
docker run --rm -e DATABASE_URL=... faceapp-ml storage-gc --status
```

**Clustering** — after an album finishes indexing:
`docker run faceapp-ml cluster --all-ready`. Optional below ~50k photographs.

## 6. Thresholds, and demonstration events

Search refuses to run until `ml/config/thresholds.toml` carries numbers
traceable to an eval report. A deployed instance therefore answers `503
search_unavailable` on every event, which is correct and also makes it
impossible to demonstrate — so there is exactly one way through it.

An event created with **"This is a demonstration"** ticked searches on
placeholder numbers. Nothing else does. That event:

- is capped at 30 days' retention by a CHECK constraint, not by the application;
- records who ticked the box and when (`demo_acknowledged_by`,
  `demo_acknowledged_at`);
- is labelled on the dashboard and on the event page;
- puts a banner on the attendee page;
- returns `thresholdsTrusted: false` in the search response.

This is a tighter rule than the environment variable it replaced, not a looser
one: that variable turned untuned thresholds on for every event in a
deployment, invisibly. This is per event, opted into, recorded and labelled.

A demonstration event is still a demonstration. Do not point one at a real
album, and check before an event goes live:

```sql
select slug, is_demo, delete_after from events where is_demo;
```

## 7. Before a paying customer

- [ ] **Thresholds measured on a labeled album.** Search refuses to run without
      them, and it should. See `ml/eval/README.md`. Nothing else on this list
      matters until this is done.
- [ ] Storage GC scheduled, and `storage_gc_backlog` wired to an alert.
- [ ] The DPA in `docs/DPA-template.md` reviewed by a lawyer and signed by the
      organizer.
- [ ] Region confirmed EU or Israel for EU events.
- [ ] `ML_SERVICE_TOKEN` set, and `POST /enroll` without it confirmed to
      return 401 from outside.
- [ ] No event in the database with `is_demo = true` that anyone might mistake
      for a real one: `select slug, is_demo, delete_after from events;`
- [ ] A backup restored, not merely configured.
- [ ] Load tested at the concurrency you expect.

## Cost, roughly

Per 50,000-photo event, ~300k faces:

- Indexing: ~7 core-hours at three surviving faces per photograph. A few dollars
  of shared CPU. (The spec's model assumed 250ms per photograph; measured, it is
  closer to 550ms for a three-face shot. Budget about twice the spec.)
- Storage: 200GB — ~$3/month on R2 with no egress charge, or ~$4/month plus
  egress on Supabase Storage.
- Vectors: 300k × 512 × 4 bytes ≈ 600MB plus index overhead. A small Postgres.
- Search: negligible once clustered.

Single-digit dollars per event. The constraint on this business is legal and
go-to-market, not infrastructure — which is why most of the effort in this
repository is in the quality gate, the threshold provenance and the deletion
machinery rather than in the matching.
