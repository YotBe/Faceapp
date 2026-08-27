# CLAUDE.md — Event Photo Face-Search

Operator uploads an event album. Attendee opens a link, captures a selfie, gets back
only the photos they appear in.

This file is the standing context for every session. Read it before writing code.

---

## 1. Assumptions this architecture is built on

Change these first if they are wrong — several of them are load-bearing.

| Assumption | Value | If wrong |
|---|---|---|
| Album size | 5,000–100,000 photos per event | <2k: skip clustering entirely. >500k: sharded vector index |
| Faces per photo | 1–30 (festival/wedding crowds) | Portrait-only events are much easier |
| Who pays | Event organizer / photographer | Attendee-pays needs Stripe + watermark-unlock from day one |
| Attendee volume | 200–5,000 searches per event | >50k needs a real queue and cached centroids |
| Primary market | Israel / EU | US market means BIPA/CUBI exposure — see `docs/COMPLIANCE.md` |
| Retention | Auto-delete 30–90 days after the event | Permanent storage massively increases legal risk |

## 2. Non-negotiables

These are not style preferences. Breaking one of them is either a privacy incident
or a product that does not work.

1. **Never hardcode a face-matching threshold.** `T_high` and `T_low` come from
   `ml/config/thresholds.toml`, and that file is only ever written by
   `ml/eval/select_thresholds.py` from a real eval report. The loader raises
   `UntunedThresholdError` rather than falling back to a plausible-looking
   number. If you find yourself typing `0.45`, stop.
2. **Precision beats recall in the confident set.** `T_high` is chosen at
   precision ≥ 0.99 on the eval set. Returning a stranger's photos is a
   reportable personal data breach under GDPR, not a bad search result.
3. **No cross-event identity graph, ever.** Embeddings are scoped to one
   `event_id` and are never joined across events, never linked to a name, never
   retained past the event's `delete_after`. This single line is the difference
   between a photo tool and Clearview.
4. **Selfies and selfie embeddings are transient.** They exist for the duration
   of one search request and are deleted within 60 seconds, with an audit row
   proving it. They are never written to a table.
5. **No biometric data in the repo.** See the block in `.gitignore`. Eval
   datasets stay on disk, off git.
6. **No ONNX inference inside a Next.js route handler.** The Python worker in
   `ml/` owns all model execution and has its own dependencies.

## 3. Stack

```
Frontend      Next.js (App Router) + TypeScript strict + Tailwind, on Vercel
Backend/API   Next.js route handlers for CRUD + signed URLs
DB            Supabase Postgres + pgvector (HNSW)
Storage       Supabase Storage, or Cloudflare R2 once an album exceeds ~200GB
Queue         Supabase pg_cron + a jobs table; Redis/BullMQ only if throughput demands
ML worker     Python 3.11 + InsightFace (buffalo_l) + onnxruntime, CPU-only container
Auth          Supabase Auth for operators. Attendees have NO account — per-event slug
Delivery      Signed URLs + optional WhatsApp via Twilio
Payments      none in v1 (organizer-pays)
```

**Deviation from the original spec:** the spec named Next.js 15; `create-next-app`
installs 16.x, which is the current stable major. We took the newer one rather than
pinning a greenfield project to an older major.

**Why InsightFace and not Rekognition:** Rekognition bills per image indexed and
per search, which caps the margin permanently at festival scale. `buffalo_l` runs
on CPU, costs nothing per operation, and keeps biometric data inside our own
infrastructure — a much easier compliance story. `FaceEngine`
(`ml/faceapp_ml/engine/base.py`) exists so this stays swappable; no vendor's data
model may leak into the schema.

**Measured cost, one shared vCPU:** detection 129ms per photograph, then 37ms
pose + 105ms embedding per face that *survives the quality gate*. So roughly
`130ms + 145ms x surviving faces`: about 400ms for a two-face shot, 1.3s for a
crowded six-face one. The spec's cost model assumes 250ms per photograph, which
holds for portraits and is optimistic for festival crowds — size ingestion
accordingly. It also means the tier-0 gate is the biggest performance lever as
well as the compliance one, since rejecting a face before embedding saves 145ms.

## 4. Layout

```
src/                    Next.js app (TypeScript strict)
supabase/migrations/    Schema. Additive only — never edit an applied migration.
supabase/tests/         SQL acceptance tests (RLS, retention). Run with psql.
ml/                     Python worker. Separate dependencies, separate venv.
  faceapp_ml/engine/    FaceEngine interface + implementations
  faceapp_ml/quality.py Quality gating (§6 below)
  eval/                 Threshold sweep harness — build and run this before any UI
  config/thresholds.toml  Written by eval only
docs/COMPLIANCE.md      Data-flow, retention matrix, deletion jobs
docs/DPA-template.md    Controller/processor agreement for operators
```

## 5. Data model

Full DDL lives in `supabase/migrations/`. Shape:

- `events` — operator-owned. `delete_after` is the enforced retention deadline.
  `jurisdiction` is CHECK-constrained; US-IL and US-TX are refused at the database.
- `photos` — one row per uploaded image. `(event_id, storage_key)` is unique so
  re-ingest is idempotent.
- `faces` — one row per detected face. `embedding vector(512)` L2-normalized,
  HNSW `vector_cosine_ops`, plus `bbox`, `det_score`, `face_px`, pose, blur,
  `quality_tier`, and a Phase 3 `cluster_id`.
- `clusters` — Phase 3 centroids, so search hits ~2k centroids instead of ~800k faces.
- `search_logs` — audit trail. Salted `ip_hash`, never a raw IP, never an embedding.
- `exclusions` — opt-out registry. Holds an embedding *only* to enforce exclusion.
- `deletion_audit` — deliberately has **no** foreign key to `events`, so the
  proof of deletion outlives the thing it deleted.
- `storage_gc_queue` — deleting a DB row does not delete the object in R2/Supabase
  Storage. Retention enqueues keys here and the worker does the real deletion.

RLS is on for every table. Operators reach their own events and nothing else.
Attendee search runs through a service-role route handler with per-event rate
limiting; the attendee client never touches the database.

## 6. Quality gates (index time)

Constants live in `ml/config/quality.toml`, not in code.

| Condition | Tier |
|---|---|
| `face_px < 40` or `det_score < 0.5` | 0 — reject, never stored |
| `face_px` 40–70, or `abs(yaw) > 40°`, or blurry | 1 — weak, "maybe" pass only |
| `face_px > 70`, `det_score > 0.7`, `abs(yaw) < 40°` | 2 — good |

Tier-0 rejection is what stops background faces from generating false matches. If
more than 60% of detections are rejected the photographer is shooting wide crowds
and the operator needs to be warned about expected recall up front.

## 7. Current thresholds

```
STATUS: UNTUNED — no labeled dataset has been evaluated yet.
```

`ml/config/thresholds.toml` ships with no numeric values and the loader refuses
to run in `strict` mode. To set them:

```bash
cd ml
python -m eval.run --dataset eval/datasets/<name>
python -m eval.select_thresholds --report eval/reports/<report>.json --write
```

`select_thresholds` picks `T_high` = the lowest threshold with precision ≥ 0.99,
and `T_low` = the threshold where recall ≈ 0.95, and writes both together with the
provenance of the report that justified them. When it has run, replace this
section with the numbers and the report filename.

## 8. Working agreements

- Acceptance criteria are the spec. Write the test, show it failing, then implement.
- Migrations are additive. Never edit one that has been applied.
- Re-run the eval harness on any model or preprocessing change. A recall
  regression fails CI (`ml/eval/gate.py`).
- Effort budget, from the original spec, is worth re-reading when scoping:
  20% detection/embedding/search, 30% quality gates and threshold tuning,
  20% ingestion, 20% legal and abuse prevention, 10% UI.
