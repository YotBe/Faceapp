# Evaluation harness

**You cannot tune a threshold without ground truth.** This is the step everyone
skips, and skipping it is the most common way this category of product fails —
not loudly, but by returning somebody else's photographs to a user, occasionally,
in a way nobody notices until they complain.

So the threshold is measured here, and `faceapp_ml.config.load_thresholds`
refuses to run until it has been.

---

## Quick check that the harness works

No album needed. Generates one statistically:

```bash
cd ml
python -m eval.run --synthetic
```

This proves the arithmetic and the wiring. It cannot set a threshold, and
`eval.select_thresholds` will refuse a synthetic report — the generator knows
nothing about backlight, motion blur, sunglasses or a face turned sixty degrees
away, which is where the answer actually comes from.

## Building a real labeled set

This is the tedious part. Do it once, properly.

**1. Get an album.** 300–1,000 photographs from a real event, with the mixed
conditions you actually expect: wide crowd shots, backlight, dancing, people
turned away. An album of clean portraits will tell you a threshold that falls
apart at the first festival.

Use your own photographs, or a friend's wedding album with their written
permission. Delete it when you are finished — you are holding other people's
biometric data on a laptop, and the same rules in `docs/COMPLIANCE.md` apply to
you.

**2. Group and label it, with help.**

```bash
cd ml
python -m eval.label init ~/albums/wedding --out eval/datasets/wedding-2026-05
python -m eval.label review --dataset eval/datasets/wedding-2026-05
python -m eval.label export --dataset eval/datasets/wedding-2026-05
```

`init` detects every face, applies the real quality gate, embeds what survives
and groups the results. `review` opens a page on 127.0.0.1 with three screens —
name the groups, find the misses, pick three enrolment frames each — and saves
as you go. `export` writes the CSVs below.

The photographs are not copied. `photos.csv` points back at your album where it
already sits, so there is one copy of other people's faces on your laptop rather
than two. Delete the album, the dataset directory and `eval/cache/` when you are
done; `docs/COMPLIANCE.md` applies to the copy on your machine too.

### Why the "find the misses" screen is not optional

The grouping comes from the same model the evaluation is about to measure. Left
at that, the exercise is circular: labels derived from detections cannot contain
the faces the detector missed or the quality gate rejected, so recall comes out
high no matter what the model is worth. **A threshold measured that way is worse
than no threshold, because it carries a number that looks earned.**

So the tool proposes and you decide. The misses screen shows, for each person,
the photographs the grouping did *not* give them — closest first, where the
near-misses concentrate, then a random sample including photographs where no
face survived the gate at all. Those last ones are the whole point: an
appearance the detector never saw is invisible everywhere else.

Every (photo, person) pair records whether it came from the grouping or from
you. `export` refuses if you corrected nothing, `eval.run` refuses to score such
a dataset, and `select_thresholds` refuses the resulting report. Three refusals
for one mistake, because it is the mistake that quietly invalidates everything
downstream of it.

### Enrolment frames

Three per person, because that is what the product enrolls — evaluating a
one-frame enrolment measures a system you do not ship.

If you have real selfies, put them in `selfies/<person>/` inside the dataset
directory before exporting and they are used as they are. Otherwise the tool
cuts them from the album at full resolution, and **holds the source photographs
out of the evaluation entirely**. Scoring a query against the image it was cut
from returns a similarity of essentially 1.0 and a guaranteed hit, which would
flatter precision and recall at exactly the thresholds being chosen. Losing
three photographs out of six hundred costs nothing; leaving the leak in would
invalidate the number.

**3. Or do it by hand.** The format below is plain CSV and nothing requires the
tool. A hand-written dataset carries no `[labelling]` section and none of the
gates above apply to it, because it is wholly human already.

**4. Either way, this is the layout:**

```
ml/eval/datasets/wedding-2026-05/
    dataset.toml
    photos.csv
    labels.csv
    selfies.csv
    photos/...
    selfies/...
```

`dataset.toml`

```toml
id = "wedding-2026-05"
kind = "real"                 # "real" or "synthetic" — decides whether thresholds may be set
description = "R & M wedding, 620 photos, mixed indoor/outdoor, two photographers"

# Written by eval.label. Omit it entirely for a hand-written dataset.
[labelling]
tool = "eval.label"
engine = "insightface/buffalo_l"
eps = 0.45
from_clusters = 812        # pairs the grouping proposed
human_added = 96           # pairs you added that it missed  <- the one that matters
human_removed = 14
held_out_photos = 18       # enrolment sources, dropped from the album
```

`human_added` is read by `eval.run` and by `select_thresholds`. Zero means the
labels describe what the model already believed, and both refuse.

`photos.csv` — `lighting` is optional and gives you a slice in the report

```csv
photo_id,path,lighting
p0001,photos/DSC_0001.jpg,daylight
p0002,photos/DSC_0002.jpg,backlit
```

`selfies.csv` — one row per frame

```csv
person_id,path
dana,selfies/dana-0.jpg
dana,selfies/dana-1.jpg
dana,selfies/dana-2.jpg
```

`labels.csv` — the ground truth, one row per (photograph, person)

```csv
photo_id,person_id
p0001,dana
p0001,yotam
p0002,dana
```

The loader is strict about this on purpose. A typo in a photo id, a person with
a selfie but no labels, a label for someone who has no selfie — each of those
produces a *plausible* evaluation rather than an error, and a wrong threshold
costs far more than a rejected CSV.

## Running it

```bash
cd ml
python -m eval.run --dataset eval/datasets/wedding-2026-05
```

Indexing is cached under `eval/cache/`, keyed by dataset, engine *and* quality
policy — so changing `min_face_px` correctly invalidates it. Sweeps after the
first are instant. `--no-cache` forces a re-index.

Two reports land in `eval/reports/`: JSON for the tooling, Markdown for people.

## Reading the report

**The two recall ceilings, first.** Before looking at any threshold:

- *Never indexed* — the appearance had no face in the index at all. Too small,
  too blurred, turned too far, or the detector never saw it. **No threshold
  recovers these.** This is the number to put in front of an operator during
  onboarding.
- *Out of confident reach* — the appearance has only tier-1 faces, so it can
  appear in the "maybe" bucket but never in the confident set. This is what caps
  the recall column of the confident sweep, and without it that column looks
  inexplicably bad.

**Then the sweep.**

```
threshold  precision  recall   F1     n_tp  n_fp  n_fn
0.42       0.981      0.874    0.924  1247    24   180
0.45       0.994      0.831    0.905  1186     7   241
0.47       0.999      0.792    0.884  1130     1   296   <- T_high
```

The unit is a (person, photograph) pair, not a face: the attendee sees a grid of
photographs and judges the product by how many of theirs are missing and whether
any belong to somebody else. Scoring faces would produce prettier numbers and
predict nothing.

**Then the slices.** Recall by face size, by head pose, by lighting. You need to
know it is 0.92 for large frontal faces and 0.41 for small profile ones, because
that is the difference between a customer who was told what to expect and one
who thinks the product is broken.

One caveat, stated in the report too: labels are per photograph, not per face, so
attributing a (person, photo) pair to a face uses the highest-scoring one.
Reliable for hits, approximate for misses. Read the shape, not the third decimal.

## Setting the thresholds

```bash
python -m eval.select_thresholds --report eval/reports/<name>.json          # dry run
python -m eval.select_thresholds --report eval/reports/<name>.json --write
```

- `T_high` — the **lowest** threshold whose measured precision reaches 0.99.
  Lowest, because once the floor is met every further step only discards true
  positives.
- `T_low` — the **highest** threshold still reaching about 0.95 recall, capped at
  `T_high`. Highest, because within the recall requirement we want as few false
  positives in the "maybe" bucket as we can get.

Why 0.99 and not 0.95: at 0.95, a user with forty photographs receives two
belonging to somebody else. In the EU that is an unauthorised disclosure of
personal data — a reportable breach, not a bad search result. The floor lives in
`faceapp_ml/config.py` and cannot be lowered from a command-line flag.

`--write` rewrites `ml/config/thresholds.toml` including the SHA-256 of the
report. **Commit the report alongside it**: `load_thresholds()` re-checks that
digest, so editing a threshold by hand afterwards fails on load rather than
quietly shipping.

If `T_high` is unreachable anywhere in the swept range, the harness refuses
rather than settling. Usually that means either look-alikes in the album, or too
many marginal faces reaching the confident set — in which case the quality gate
needs tightening before any threshold can help.

## Regression gating

```bash
python -m eval.gate --report eval/reports/new.json --baseline eval/reports/baseline.json
```

Fails on a recall drop at `T_high`, on precision falling below the floor, or on
the recall ceiling getting worse — that last one catching a quality gate quietly
tightened without anyone noticing what it cost. Re-run the eval on every model
or preprocessing change; a model bump that costs 8% of recall is exactly the
change that looks harmless in review and is discovered by a customer.

## What is safe to commit

**Reports.** Counts, scores and aggregate metrics. There is a test asserting no
report contains an embedding or a filename.

**Never the datasets or the cache.** Both hold real photographs and face
templates of named people. Git is permanent, replicated and in practice
un-deletable, which is the exact opposite of every retention guarantee in
`docs/COMPLIANCE.md`. Committing them would be a personal data breach on its own.
Both paths are in `.gitignore`; leave them there.
