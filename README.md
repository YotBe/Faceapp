# Event photo search

An operator uploads an event album. An attendee opens a link, captures a selfie,
and gets back only the photographs they appear in. No app, no signup, no account.

Photographs and face data delete themselves on a date fixed when the album is
created.

## Status

| Phase | | |
|---|---|---|
| 0 | Foundations — schema, RLS, retention, compliance docs | done, tested |
| 1 | ML core and evaluation harness | done |
| 2 | Ingestion — resumable upload, job queue, derivatives, dashboard | done |
| 3 | Attendee search — camera capture, matching, deletion, clustering | done |
| 4 | Delivery — zip download, opt-out, share link and QR | done |
| — | Retention closed end to end: storage GC drains the bucket | done |
| 5 | Hardening — load test, monitoring, legal pages, backup drill | not started |

**The match thresholds are not set, and search is gated on them.** They come
from a labeled album, not from judgement, and until one exists the search path
refuses to run. See [Thresholds](#thresholds) — this is the one thing standing
between the current state and a product you could sell.

## Run it

Needs Postgres 16 with pgvector, Node 22, pnpm, and Python 3.11.

```bash
pnpm install

cd ml
python -m venv .venv
.venv/bin/pip install -e ".[dev,service,insightface]"   # ~300MB of model weights on first run
cd ..

cp .env.example .env.local        # then fill in APP_SECRET
./scripts/dev-db.sh               # create the database, apply migrations
./scripts/dev-all.sh              # postgres + enrollment service + worker + web app
./scripts/seed-demo.sh            # an operator, an event, an indexed album
```

`seed-demo.sh` prints the operator login and the attendee link. The demo album is
built from the group photograph bundled with InsightFace — six real faces, ten
derived shots, with a manifest recording who is in which, so the search has a
ground truth to be right or wrong about.

`seed-demo.sh` ticks the demonstration box when it creates the event, which is
what lets the search run at all: matching is gated on measured thresholds, and a
demonstration event is the one exception — capped at 30 days, labelled
everywhere it appears, and answering `thresholdsTrusted: false`. A normal event
returns 503 until the thresholds exist.

## What is where

```
src/app/                Next.js app — operator pages, attendee pages, route handlers
src/lib/                db, auth, storage, thresholds, search, ML client
supabase/migrations/    Schema. Additive only.
supabase/tests/         Acceptance tests — RLS, retention, queue. Plain psql.
ml/faceapp_ml/          FaceEngine, quality gating, embeddings, threshold loading
ml/faceapp_worker/      Ingestion worker, enrollment service, clustering
ml/eval/                Threshold evaluation harness
e2e/                    Browser smoke test, camera included
docs/COMPLIANCE.md      Data flow, retention matrix, deletion jobs
docs/DPA-template.md    Controller/processor agreement
```

## How it works

**Ingestion.** Files upload in concurrent batches; each batch is independently
retried and the server side is idempotent, so re-uploading a folder is a no-op.
Each photograph gets a job in `ingest_jobs`. The worker claims jobs under
`FOR UPDATE SKIP LOCKED` with a time-limited lease, so several workers share the
queue and a worker that is killed releases its work when the lease expires. It
writes a watermarked preview and thumbnail, detects faces, applies the quality
gate, and embeds only what survives.

**Search.** Three frames from the camera go to the Python service, which returns
one averaged 512-d template. pgvector finds the nearest faces in that event,
opt-outs are subtracted, thresholds split the results into confident and maybe,
and the results are grouped per photograph. Then the template is destroyed and an
audit row records how long it lived.

**Retention.** An hourly job deletes expired events and queues every object key
they owned; the storage GC worker then removes the bytes. Both halves are
needed — deleting a row in Postgres does not delete a 4MB JPEG in a bucket, and
a retention job that only touches the database leaves every photograph exactly
where it was. Proof of deletion survives both, in a table with no foreign key to
what it recorded.

## Thresholds

Cosine similarity on ArcFace embeddings usually operates somewhere around
0.35–0.55, and quoting that range is as far as anyone should go without data. The
right value depends on the detector, the model, and the photographic conditions
of the specific album. Getting it wrong in the permissive direction means
returning a stranger's photographs to someone, which in the EU is a reportable
personal data breach rather than a bad search result.

So it is measured:

```bash
cd ml
python -m eval.run --dataset eval/datasets/<name>
python -m eval.select_thresholds --report eval/reports/<report>.json --write
```

`T_high` is taken at the lowest threshold where measured precision reaches 0.99;
`T_low` where recall reaches about 0.95, for the secondary bucket. Both are
written with the SHA-256 of the report that justified them, and both loaders —
Python and TypeScript — re-check that digest. A hand-edited threshold fails on
load rather than shipping quietly.

Building the labeled album is a couple of hours of work, once:
[`ml/eval/README.md`](ml/eval/README.md).

## Testing

```bash
./supabase/tests/run.sh                  # schema, RLS, retention, queue
cd ml && pytest                          # ML core, metrics, worker, threshold provenance
pnpm test                                # signed URLs, ranking, slugs
pnpm typecheck && pnpm lint
DEMO_SLUG=<slug> node e2e/smoke.mjs      # the whole product in a browser
```

The browser test drives the real camera path using a synthetic video device —
there is no upload fallback to test through, because that fallback is the
impersonation hole the design closes. See [`e2e/README.md`](e2e/README.md).

## Deploying

Click-by-click, with every value named:
[`docs/DEPLOY_WALKTHROUGH.md`](docs/DEPLOY_WALKTHROUGH.md). The reasoning behind
it: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**This is four services, not one.** A serverless host runs the web app; it
cannot run the other three, and pretending otherwise produces a deployment that
looks live and loses every photograph uploaded to it.

| Component | Where |
|---|---|
| Web app | Vercel, or any Node host |
| Postgres + pgvector | Supabase, Neon, RDS |
| Enrollment service | `ml/Dockerfile`, role `service` — Fly.io, Railway, Render |
| Ingestion worker | Same image, role `worker` |
| Object storage | Supabase Storage or Cloudflare R2 — one S3 driver, both |

The web app degrades honestly: with anything missing, the home page names what
is absent rather than returning a 500, and `/setup` probes each dependency for
real — it connects, queries, signs a URL and calls the service, because knowing
that a variable is set tells you nothing about whether the password is right.

Two seams keep this from being tied to any vendor. `src/lib/auth.ts` is replaced
wholesale by `@supabase/ssr` on a Supabase deployment. `src/lib/storage.ts` is an
interface with two drivers — local filesystem for development, S3 for deployment
— chosen by configuration, all-or-nothing so a half-configured bucket cannot
silently fall back to a filesystem that does not persist.

The enrollment service requires a bearer token. Every container host gives it a
public URL, so "keep it off the internet" is advice you cannot follow; it
refuses to start without a token instead.

Still missing before a paid event: **measured thresholds** (search refuses to run
without them, and should), WhatsApp delivery, a load test, and the legal pages.
See §7 of the deployment guide and §10 of `docs/COMPLIANCE.md`.

## Reading order

1. `CLAUDE.md` — the assumptions the architecture rests on, and the six things
   that must not be broken.
2. `docs/COMPLIANCE.md` — what is stored, for how long, and which code enforces it.
3. `supabase/migrations/` — the schema, with the reasoning in the comments.
4. `ml/eval/README.md` — why thresholds are measured rather than chosen.
