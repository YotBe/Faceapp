from __future__ import annotations

import numpy as np
import pytest

from faceapp_ml.embeddings import (
    average_embeddings,
    cosine_similarity,
    cosine_similarity_matrix,
    l2_normalize,
)


def test_normalize_produces_a_unit_vector() -> None:
    v = l2_normalize(np.array([3.0, 4.0]))
    assert np.linalg.norm(v) == pytest.approx(1.0)
    assert v.dtype == np.float32


def test_normalize_refuses_a_zero_vector() -> None:
    """Silently returning NaNs here would poison an index without erroring anywhere."""
    with pytest.raises(ValueError, match="zero-length"):
        l2_normalize(np.zeros(512))


def test_averaging_normalizes_before_it_averages() -> None:
    """Otherwise the frames are weighted by their norms rather than equally.

    Two frames pointing the same way but scaled differently must contribute the
    same amount. A raw mean would let a frame that happened to come back with a
    larger magnitude dominate the enrollment.
    """
    a = np.array([1.0, 0.0] + [0.0] * 510)
    b = np.array([0.0, 1.0] + [0.0] * 510)

    balanced = average_embeddings([a, b])
    lopsided = average_embeddings([a * 100.0, b])

    np.testing.assert_allclose(balanced, lopsided, atol=1e-6)
    assert balanced[0] == pytest.approx(balanced[1])


def test_averaging_identical_frames_changes_nothing() -> None:
    rng = np.random.default_rng(0)
    v = l2_normalize(rng.normal(size=512))
    np.testing.assert_allclose(average_embeddings([v, v, v]), v, atol=1e-6)


def test_averaging_moves_toward_the_identity_centre() -> None:
    """Why three frames beat one.

    Each frame is the true template plus its own noise. Averaging cancels part of
    that noise, so the enrollment sits closer to the person's true direction than
    any single frame does.
    """
    rng = np.random.default_rng(7)
    true = l2_normalize(rng.normal(size=512))
    frames = [l2_normalize(true + 0.6 * rng.normal(size=512)) for _ in range(3)]

    averaged = average_embeddings(frames)
    single = frames[0]

    assert cosine_similarity(averaged, true) > cosine_similarity(single, true)


def test_averaging_rejects_an_empty_enrollment() -> None:
    with pytest.raises(ValueError, match="no frames"):
        average_embeddings([])


def test_averaging_rejects_the_wrong_dimensionality() -> None:
    """A model swap that changes the embedding size must fail loudly, not silently."""
    with pytest.raises(ValueError, match="512"):
        average_embeddings([np.ones(128), np.ones(128)])


def test_cosine_similarity_of_a_vector_with_itself_is_one() -> None:
    rng = np.random.default_rng(1)
    v = rng.normal(size=512)
    assert cosine_similarity(v, v) == pytest.approx(1.0, abs=1e-6)


def test_cosine_similarity_ignores_magnitude() -> None:
    rng = np.random.default_rng(2)
    a, b = rng.normal(size=512), rng.normal(size=512)
    assert cosine_similarity(a, b) == pytest.approx(cosine_similarity(a * 17.0, b), abs=1e-6)


def test_orthogonal_vectors_score_zero() -> None:
    a = np.zeros(512)
    a[0] = 1.0
    b = np.zeros(512)
    b[1] = 1.0
    assert cosine_similarity(a, b) == pytest.approx(0.0, abs=1e-6)


def test_similarity_matrix_shape_and_values() -> None:
    rng = np.random.default_rng(3)
    queries = rng.normal(size=(4, 512))
    gallery = rng.normal(size=(9, 512))

    matrix = cosine_similarity_matrix(queries, gallery)
    assert matrix.shape == (4, 9)

    for i in range(4):
        for j in range(9):
            assert matrix[i, j] == pytest.approx(
                cosine_similarity(queries[i], gallery[j]), abs=1e-5
            )


def test_similarity_matrix_accepts_a_single_query() -> None:
    rng = np.random.default_rng(4)
    assert cosine_similarity_matrix(rng.normal(size=512), rng.normal(size=(3, 512))).shape == (1, 3)


def test_similarity_matrix_rejects_mismatched_dimensions() -> None:
    with pytest.raises(ValueError, match="dimension mismatch"):
        cosine_similarity_matrix(np.ones((1, 512)), np.ones((1, 128)))
