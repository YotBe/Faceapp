"""The bearer token on /enroll.

This is the only thing standing between a public container URL and an endpoint
that converts face photographs into biometric templates. `docs/DEPLOYMENT.md`
used to say "do not expose this service to the internet", which is advice you
cannot follow: Railway, Render and Fly all hand a container a public hostname.
So it is authenticated instead, and the authentication is tested here rather
than assumed.

The service module is imported without the model. Every case below is settled
during dependency resolution or body validation, so nothing here loads ONNX.
"""

from __future__ import annotations

import importlib

import pytest

pytest.importorskip("fastapi", reason="the service extra is not installed")
pytest.importorskip("httpx", reason="fastapi's TestClient needs httpx")

from fastapi.testclient import TestClient

TOKEN = "a-token-of-adequate-length"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("ML_SERVICE_TOKEN", TOKEN)
    service = importlib.import_module("faceapp_worker.service")
    importlib.reload(service)
    return TestClient(service.app)


def test_no_token_is_refused(client: TestClient) -> None:
    assert client.post("/enroll").status_code == 401


def test_wrong_token_is_refused(client: TestClient) -> None:
    response = client.post("/enroll", headers={"Authorization": f"Bearer {TOKEN}x"})
    assert response.status_code == 401


def test_the_right_token_gets_past_the_gate(client: TestClient) -> None:
    # No frames, so the request still fails — but on the body, not on the
    # credential. That distinction is what the /setup diagnostics probe reads:
    # anything other than 401 means the two halves of the secret agree.
    response = client.post("/enroll", headers={"Authorization": f"Bearer {TOKEN}"})
    assert response.status_code != 401


def test_a_token_in_the_wrong_scheme_is_refused(client: TestClient) -> None:
    for header in (TOKEN, f"Basic {TOKEN}", f"bearer{TOKEN}", "Bearer "):
        response = client.post("/enroll", headers={"Authorization": header})
        assert response.status_code == 401, header


def test_bearer_is_case_insensitive(client: TestClient) -> None:
    # RFC 7235 makes the scheme case-insensitive, and some proxies normalise it.
    # Rejecting `bearer` would be a failure nobody could diagnose from the
    # error message.
    response = client.post("/enroll", headers={"Authorization": f"bearer {TOKEN}"})
    assert response.status_code != 401


def test_it_refuses_to_start_without_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    # Not "runs unauthenticated" and not "logs a warning". A security control
    # with a default is a security control that silently is not there.
    monkeypatch.delenv("ML_SERVICE_TOKEN", raising=False)
    service = importlib.import_module("faceapp_worker.service")

    with pytest.raises(SystemExit) as raised:
        service._token()
    assert "ML_SERVICE_TOKEN" in str(raised.value)


def test_a_short_token_is_refused_as_well(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ML_SERVICE_TOKEN", "hunter2")
    service = importlib.import_module("faceapp_worker.service")

    with pytest.raises(SystemExit):
        service._token()


def test_health_needs_no_token(client: TestClient) -> None:
    # The container host's health check cannot hold a credential. It does no
    # work and reveals only which model is configured, which is in the
    # repository anyway.
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_health_does_not_load_the_model(client: TestClient, monkeypatch) -> None:
    """It used to, and that was two problems at once.

    The health check took the better part of a minute, which is most of a
    platform's patience; and a caller could not tell a container that was warming
    up from one that was dead, because both simply failed to answer. Now the
    process answers immediately and says which it is.
    """
    service = importlib.import_module("faceapp_worker.service")
    monkeypatch.setattr(
        service, "engine", lambda: pytest.fail("/health must not load the model")
    )

    body = client.get("/health").json()

    assert body["model_loaded"] is False
    assert body["engine"]
