"""Demo fixtures.

Builds a small event album and a set of selfie frames from the sample
photograph that ships with InsightFace, so the whole application can be run and
demonstrated end to end without anyone's real event photographs.

None of it is committed. `make_demo_album` writes into a directory you name and
`.gitignore` keeps generated images out of the repository — the same rule that
applies to eval datasets applies here.
"""
