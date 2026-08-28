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
| Object storage | Originals, previews, thumbnails | Cloudflare R2 |

The web app degrades honestly: with anything missing, the home page names what
is absent instead of returning a 500.

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

## 2. Object storage (Cloudflare R2)

Create a bucket. Then an R2 API token with **Object Read & Write** scoped to it.

```
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=faceapp-photos
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

All four, or none. A partially configured R2 falls back to the local filesystem
driver, and on a serverless host that filesystem is read-only or discarded
between requests — the upload succeeds, no error is logged anywhere, and the
photograph is gone. Both the web app and the worker refuse to start in that
state rather than fall back.

Attendees get presigned URLs straight from R2, so photographs never transit the
web app and never touch its egress bill. That is most of why R2 is here rather
than Supabase Storage; the difference is real once an album passes ~200GB.

Do **not** make the bucket public. Every URL the product hands out expires,
which is the whole point.

## 3. ML container

One image, two roles.

```bash
docker build -t faceapp-ml ml/

docker run -d --name faceapp-service -p 8000:8000 \
  -e DATABASE_URL=... -e R2_ENDPOINT=... -e R2_BUCKET=... \
  -e R2_ACCESS_KEY_ID=... -e R2_SECRET_ACCESS_KEY=... \
  faceapp-ml service

docker run -d --name faceapp-worker \
  -e DATABASE_URL=... -e R2_ENDPOINT=... -e R2_BUCKET=... \
  -e R2_ACCESS_KEY_ID=... -e R2_SECRET_ACCESS_KEY=... \
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

**The service must not be internet-facing.** It has no authentication — it
answers to whoever can reach it, and what it does is turn face photographs into
biometric templates. Put it on a private network and let only the web app reach
it. On Fly.io that is a `.internal` address; on Railway, a private domain.

## 4. Web app

Set on the host, not in a file:

```
DATABASE_URL=postgres://...
APP_SECRET=<openssl rand -base64 48>
IP_HASH_SECRET=<a different one>
ML_SERVICE_URL=http://faceapp-service.internal:8000
R2_ENDPOINT=...
R2_BUCKET=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
SEARCH_RATE_LIMIT_PER_HOUR=3
```

`APP_SECRET` signs session cookies and local storage URLs. It has no default and
never will: one that quietly falls back to a constant lets anyone mint signed
URLs for a stranger's photographs.

`IP_HASH_SECRET` salts the hash in `search_logs`. Separate so it can be rotated
on its own, which is the point of salting.

**Do not set `FACEAPP_DEV_THRESHOLDS`.** It is refused when
`NODE_ENV=production` anyway, but it should not be in a production environment's
variable list at all.

## 5. Scheduled jobs

**Retention** — hourly. On Supabase this is already scheduled by
`20260827090200_retention.sql` via pg_cron. Elsewhere, run
`select run_retention(500);` on a schedule and check it is actually running: a
retention job that silently stopped looks exactly like one that has nothing to do.

**Storage GC** — every 15 minutes or so, after retention:

```bash
docker run --rm -e DATABASE_URL=... -e R2_ENDPOINT=... -e R2_BUCKET=... \
  -e R2_ACCESS_KEY_ID=... -e R2_SECRET_ACCESS_KEY=... \
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

## 6. Before a paying customer

- [ ] **Thresholds measured on a labeled album.** Search refuses to run without
      them, and it should. See `ml/eval/README.md`. Nothing else on this list
      matters until this is done.
- [ ] Storage GC scheduled, and `storage_gc_backlog` wired to an alert.
- [ ] The DPA in `docs/DPA-template.md` reviewed by a lawyer and signed by the
      organizer.
- [ ] Region confirmed EU or Israel for EU events.
- [ ] The ML service confirmed unreachable from the internet.
- [ ] A backup restored, not merely configured.
- [ ] Load tested at the concurrency you expect.

## Cost, roughly

Per 50,000-photo event, ~300k faces:

- Indexing: ~7 core-hours at three surviving faces per photograph. A few dollars
  of shared CPU. (The spec's model assumed 250ms per photograph; measured, it is
  closer to 550ms for a three-face shot. Budget about twice the spec.)
- Storage: 200GB on R2, ~$3/month, no egress charge.
- Vectors: 300k × 512 × 4 bytes ≈ 600MB plus index overhead. A small Postgres.
- Search: negligible once clustered.

Single-digit dollars per event. The constraint on this business is legal and
go-to-market, not infrastructure — which is why most of the effort in this
repository is in the quality gate, the threshold provenance and the deletion
machinery rather than in the matching.
