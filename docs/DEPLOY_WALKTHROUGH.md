# Deploying this, click by click

`docs/DEPLOYMENT.md` explains *why* the pieces are shaped the way they are. This
one is the recipe: every screen, every value, in the order that works. It uses
Supabase for the database **and** the photo storage, Railway for the two Python
services, and Vercel for the web app. Roughly 40 minutes, and about $0 until an
album gets large.

You are deploying **four things**, not one:

| # | Thing | Where | Why it cannot go elsewhere |
|---|---|---|---|
| 1 | Postgres + pgvector | Supabase | Vector search needs the extension |
| 2 | Object storage | Supabase Storage | A serverless filesystem does not persist |
| 3 | Enrollment service + ingestion worker | Railway | onnxruntime, ~1GB resident, long-running |
| 4 | Web app | Vercel | — |

Skipping #3 gives you a site where uploads queue forever and search never
answers. Skipping #2 gives you a site where uploads *appear* to work and the
photographs are gone by the next request. Both failure modes are silent, which
is why both are on this list.

---

## Before you start: generate three secrets

Do this once, in a terminal, and keep the output somewhere you can paste from.
Every one of them gets used in two or three different places, and they must
match exactly.

```bash
echo "APP_SECRET=$(openssl rand -base64 48)"
echo "IP_HASH_SECRET=$(openssl rand -base64 48)"
echo "ML_SERVICE_TOKEN=$(openssl rand -base64 32)"
```

- `APP_SECRET` signs session cookies and local storage URLs. Changing it later
  logs every operator out.
- `IP_HASH_SECRET` salts the IP hash in `search_logs`. Separate from
  `APP_SECRET` so it can be rotated on its own — that is the point of salting.
- `ML_SERVICE_TOKEN` is the shared secret between the web app and the enrollment
  service. It must be **byte-identical** in three places: Vercel, and both
  Railway services. Anything shorter than 16 characters is refused at startup.

---

## 1. Supabase — database

1. <https://supabase.com/dashboard> → **New project**.
2. Name it anything. **Region: choose one in the EU** (`eu-central-1` Frankfurt,
   `eu-west-2` London, `eu-west-3` Paris). This cannot be changed afterwards, and
   for EU events the data must not leave. Israel has no Supabase region; the EU
   is the correct choice for an Israeli operator serving EU attendees.
3. Set a database password and save it. You need it in the next step and Supabase
   will not show it again.
4. Wait for the project to finish provisioning (~2 minutes).

### Apply the schema

Project settings → **Database** → **Connection string** → **URI**, and pick the
**Session pooler** (port `5432`) entry. Substitute your password for
`[YOUR-PASSWORD]`.

```bash
export DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'

for f in supabase/migrations/*.sql; do
  echo "-- $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

Filename order is the correct order; the loop above gives you that for free.

Two notices are expected and are not errors:

- `pg_cron` may report that it could not be set up. Retention then needs an
  external schedule — see §6 below.
- `NOTICE: extension "vector" already exists` on a fresh Supabase project.

Check it took:

```bash
psql "$DATABASE_URL" -c "select extversion from pg_extension where extname='vector'"
psql "$DATABASE_URL" -c "select to_regclass('public.storage_gc_backlog')"
```

You want a version **0.8.0 or newer** and a non-null second answer. Below 0.8
there is no `hnsw.iterative_scan`, and an approximate index scan combined with a
per-event filter can return fewer matches than exist — an attendee silently
loses photographs. The app detects this and adapts, but it is a real recall
loss.

Then check the privileges, because Supabase's defaults and this schema disagree:

```bash
psql "$DATABASE_URL" -c "select has_function_privilege('anon','run_retention(int)','execute')"
```

It must be `f`. Supabase grants `anon` and `authenticated` everything in the
public schema by default, and a SECURITY DEFINER function is published at
`/rest/v1/rpc/<name>` and is not filtered by RLS — so `run_retention` was
callable by anyone holding the anon key that ships in the browser.
`20260828060000_grants.sql` revokes it and grants back only what the RLS
migration intended. If that answer is `t`, that migration did not run.

Afterwards, the dashboard's **Advisors → Security** page should show only three
"RLS enabled, no policy" notices (`exclusions`, `operator_credentials`,
`storage_gc_queue` — deliberate: RLS on with no policy denies everyone, which is
the point) and one about `vector` living in the public schema, which is left
alone on purpose.

## 2. Supabase — photo storage

### Create the bucket

Dashboard → **Storage** → **New bucket**.

- Name: `faceapp-photos`
- **Public bucket: off.** Leave it off. Every URL this product hands out
  expires; a public bucket makes that pointless.

### Create S3 access keys

Dashboard → **Storage** → **S3 Access Keys** (under Settings) → **New access
key**. Copy both halves — the secret is shown once.

**This is the one step in this document with no API.** It cannot be scripted or
done for you.

You now have four values:

```
S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
S3_REGION=eu-central-1          # your project's actual region, not "auto"
S3_BUCKET=faceapp-photos
S3_ACCESS_KEY_ID=<from above>
S3_SECRET_ACCESS_KEY=<from above>
```

`<project-ref>` is the string in your dashboard URL. `S3_REGION` must be the
project's real region: Supabase includes it in the signature and rejects
`auto`, which is Cloudflare R2's convention.

> Using Cloudflare R2 instead? The `R2_*` names still work as aliases —
> `R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com` and region `auto`.
> Everything below is otherwise identical.

## 3. Railway — the two Python services

Both run the same image from `ml/Dockerfile` with a different command. The
buffalo_l weights are baked into the image, so the first request does not
download 280MB and the model cannot change under a running deployment.

### 3a. `faceapp-ml` — the enrollment service

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → this
   repository.
2. Service **Settings**:
   - **Root Directory**: `ml`
   - **Builder**: Dockerfile (`ml/railway.json` already selects this)
   - **Networking** → **Generate Domain**. Note the `https://…up.railway.app`
     URL.
3. **Variables** — paste this block, with your values:

   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
   ML_SERVICE_TOKEN=<the token you generated>
   S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
   S3_REGION=eu-central-1
   S3_BUCKET=faceapp-photos
   S3_ACCESS_KEY_ID=<...>
   S3_SECRET_ACCESS_KEY=<...>
   ```

4. Deploy. First build is slow (~10 minutes) because of the model weights.

Check it:

```bash
curl https://<your-service>.up.railway.app/health
# {"status":"ok",...}

curl -X POST https://<your-service>.up.railway.app/enroll
# {"detail":"..."} with HTTP 401 — no token
```

A 401 there is the point. The service is publicly addressable — Railway, Render
and Fly all work that way — and unauthenticated it would be an open endpoint
that converts face photographs into biometric templates for anyone who finds
it. Prefer a private network where the platform offers one; the token is what
makes a public URL survivable.

### 3b. `faceapp-worker` — the ingestion worker

In the same Railway project: **New** → **GitHub Repo** → the same repository.

- **Root Directory**: `ml`
- **Settings → Deploy → Custom Start Command**:
  `/app/docker-entrypoint.sh worker`
- **Networking**: no public domain. It consumes a queue; nothing calls it.
- **Variables**: the same block as above.

Without this service, uploads sit in `ingest_jobs` at `pending` forever and the
event never leaves "indexing". That is the most common way this deployment looks
broken.

### 3c. Storage GC (optional now, required before a real event)

Railway → **New** → **Cron**, same repo, root `ml`, schedule `*/15 * * * *`,
command `/app/docker-entrypoint.sh storage-gc`, same variables.

Deleting a row in Postgres does not delete a 4MB JPEG in a bucket. Retention
enqueues the keys; this drains them. Without it, an event is erased from the
database and every photograph stays in storage.

## 4. Vercel — the web app

Project → **Settings** → **Environment Variables**. All environments.

```
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
APP_SECRET=<generated above>
IP_HASH_SECRET=<generated above>
ML_SERVICE_URL=https://<your-service>.up.railway.app
ML_SERVICE_TOKEN=<the same token as Railway>
S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
S3_REGION=eu-central-1
S3_BUCKET=faceapp-photos
S3_ACCESS_KEY_ID=<...>
S3_SECRET_ACCESS_KEY=<...>
SEARCH_RATE_LIMIT_PER_HOUR=3
```

Use the **Session pooler** connection string, not the direct one: serverless
functions open a connection per invocation and will exhaust a direct Postgres
long before they exhaust the pooler.

Then **Deployments** → ⋯ → **Redeploy**. Environment variables are read at
runtime, but a deployment built before they existed still needs to be re-run to
pick them up.

## 5. Check it, at `/setup`

Open `https://<your-app>.vercel.app/setup`. It does not check whether variables
are *set* — it connects, queries, signs, and calls. Each row is a live probe:

| Row | What a failure means |
|---|---|
| Database reachable | Wrong password, wrong host, or IP restrictions on the project |
| Migrations applied | The `psql` loop in §1 did not run, or ran against a different database |
| pgvector / version | Extension missing, or older than 0.8 (a warning, not a failure) |
| Face matching service | `ML_SERVICE_URL` wrong, or the Railway service is asleep or crashed |
| Service token | The two halves of `ML_SERVICE_TOKEN` are not identical |
| Photo storage writable / readable | Wrong keys, wrong bucket name, or a partially set S3 block |
| Signed URLs | Region mismatch — Supabase needs its real region, not `auto` |
| Match thresholds | Expected to warn. See §7 |

The page is visible while the deployment is unconfigured, and after that only to
a signed-in operator — a working deployment should not publish its own
infrastructure state.

## 6. Scheduled jobs

**Retention**, hourly. If the `pg_cron` block in §1 printed a notice rather than
scheduling itself, run it from outside instead:

```sql
select run_retention(500);
```

A Railway cron with `psql "$DATABASE_URL" -c 'select run_retention(500);'` does
the job. Verify that it actually runs: a retention job that silently stopped
looks exactly like one with nothing to do.

**Storage GC**, §3c above. Alert on it:

```sql
select * from storage_gc_backlog;
```

`oldest_pending_age` above an hour, or `dead_lettered` above zero, means
photographs are still in the bucket after their event was erased. Queue depth
alone will not tell you — a stalled queue and a busy one look identical.

## 7. First event

Search is gated on measured thresholds, so a normal event returns **503** until
they exist. That is deliberate: returning a stranger's photographs to someone is
a reportable personal data breach under GDPR, not a bad search result.

To see the product work before you have measured them, tick **"This is a
demonstration"** when creating the event. That event, and only that event, runs
on placeholder numbers. It is capped at 30 days' retention by a database
constraint, it is labelled on the dashboard, the attendee page carries a banner,
and the search response says `thresholdsTrusted: false`.

1. Sign up at `/signup`.
2. **New event** — name it, jurisdiction, retention, and tick the demonstration
   box.
3. Upload photographs. Watch the dashboard: pending → running → done.
4. Open the attendee link on a phone, take a selfie, and you should get back the
   photographs you appear in.
5. Confirm the selfie was destroyed:

   ```sql
   select details from deletion_audit where kind = 'selfie' order by created_at desc limit 1;
   ```

   `within_sla` true, `elapsed_ms` in the low thousands.

Or seed the whole thing at once, from a checkout with the Python venv built:

```bash
BASE_URL=https://<your-app>.vercel.app ./scripts/seed-demo.sh
```

It builds an album from the group photograph bundled with InsightFace — six real
faces, ten derived shots, with a manifest of who is in which — creates the event
with the demonstration box ticked, uploads, and waits for indexing. So the
search has a ground truth to be right or wrong about.

## 8. What is still missing

**Measured thresholds.** Until `ml/config/thresholds.toml` has numbers traceable
to an eval report, this is a demonstration and not something to run a paid event
on. It needs a labelled album and a couple of hours:
[`ml/eval/README.md`](../ml/eval/README.md).

**Cold starts.** A free Railway instance sleeps. The first search after a quiet
period waits roughly a minute while the model loads. Upgrade the plan, or accept
it for a demonstration.

The rest of the pre-customer checklist is §6 of
[`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## When it does not work

**`/setup` says the database is unreachable, but the credentials are right.**
You are probably on the direct connection string. Use the Session pooler one.

**Uploads succeed, the event never indexes.** The `faceapp-worker` service is
not running, or has different variables from the enrollment service. Check its
Railway logs; check `select state, count(*) from ingest_jobs group by state`.

**Search returns 503 with `search_unavailable`.** Working as designed on a
non-demo event. Tick the demonstration box, or measure the thresholds.

**Search returns 502 or a token error.** `ML_SERVICE_TOKEN` differs between
Vercel and Railway. Copy it from one to the other rather than retyping — a
trailing newline from a shell is the usual culprit.

**Photographs upload but never appear.** The S3 block is partially set. It is
all-five-or-none on purpose; with any missing, the local filesystem driver takes
over, and on Vercel that filesystem is discarded between requests. `/setup` says
so explicitly.

**The attendee page shows a black camera preview.** A `<video>` reports 0x0
until its first frame arrives. The capture component waits for a non-zero
`videoWidth`; if you are seeing this on a modified build, that is what regressed.
