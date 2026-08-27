"""Ingestion worker and ML service.

Separate from `faceapp_ml` on purpose: that package is the model and the maths,
and stays importable with numpy alone so CI can test the quality gate without
downloading weights. This package is the plumbing — Postgres, object storage,
HTTP — and is allowed to have opinions about all three.
"""
