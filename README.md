# Event photo face search

An operator uploads an event album. An attendee opens a link, captures a selfie,
and gets back only the photographs they appear in. No app, no signup, no account.

Photographs and face data are deleted automatically at a date fixed when the
album is created.

## Status

| Phase | | |
|---|---|---|
| 0 | Foundations — schema, RLS, retention, compliance docs | **done, tested** |
| 1 | ML core and evaluation harness | **done; awaiting a real labeled album** |
| 2 | Ingestion pipeline | not started |
| 3 | Attendee search | not started |
| 4 | Delivery and operator tooling | not started |
| 5 | Hardening | not started |

Match thresholds are **not yet set**. They are derived from a labeled evaluation
set, not chosen by hand, and the loader refuses to run until that has happened.
See [Thresholds](#thresholds).

## Layout

```
src/                    Next.js app (TypeScript strict)
supabase/migrations/    Schema. Additive only.
supabase/tests/         Acceptance tests — RLS, retention, constraints. Plain psql.
ml/                     Python worker and evaluation harness. Own dependencies.
docs/COMPLIANCE.md      Data flow, retention matrix, deletion jobs
docs/DPA-template.md    Controller/processor agreement for operators
CLAUDE.md               Standing context: assumptions, stack, non-negotiables
```

## Getting started

### Web app

```bash
pnpm install
pnpm dev
```

### Database

Against a Supabase project:

```bash
supabase link --project-ref <ref>
supabase db push
```

Against a local Postgres with pgvector, which is what the tests use:

```bash
./supabase/tests/run.sh
```

That rebuilds a scratch database, applies every migration in order, and runs the
acceptance tests. It needs nothing but `psql` and a Postgres with the `vector`
extension available.

### ML worker and evaluation

```bash
cd ml
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"          # add ".[insightface]" for the real model
pytest
```

## Thresholds

Cosine similarity on ArcFace embeddings usually operates somewhere around
0.35–0.55, and quoting that range is as far as anyone should go without data.
The correct number depends on the detector, the model and the photographic
conditions of the specific event, and getting it wrong in the permissive
direction means returning a stranger's photographs to someone — which in the EU
is a reportable personal data breach, not a bad search result.

So the number is measured, not chosen:

```bash
cd ml
python -m eval.run --dataset eval/datasets/<name>
python -m eval.select_thresholds --report eval/reports/<report>.json --write
```

`select_thresholds` takes `T_high` at the lowest value where precision reaches
0.99, takes `T_low` where recall reaches about 0.95 for the secondary "maybe"
bucket, and writes both to `ml/config/thresholds.toml` together with the
provenance of the report that justified them. Nothing else writes that file, and
`load_thresholds(strict=True)` raises `UntunedThresholdError` rather than falling
back to a plausible-looking default.

See `ml/eval/README.md` for how to assemble a labeled set.

## Testing

```bash
./supabase/tests/run.sh   # schema, RLS, retention
cd ml && pytest           # ML core, metrics, threshold selection
pnpm typecheck && pnpm lint
```

## Reading order for a new contributor

1. `CLAUDE.md` — the assumptions the architecture rests on, and the six things
   that must not be broken.
2. `docs/COMPLIANCE.md` — what is stored, for how long, and which code enforces it.
3. `supabase/migrations/` — the schema, with the reasoning in the comments.
4. `ml/eval/README.md` — why thresholds are measured rather than chosen.
