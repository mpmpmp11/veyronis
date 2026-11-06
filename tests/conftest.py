"""Pytest fixtures — test client, auth helpers, cleanup."""
import os

# MUST be set before importing api, so rate limiting is bypassed
os.environ["VEYRONIS_TEST_MODE"] = "1"

import pytest
import secrets
from fastapi.testclient import TestClient
from api import app


@pytest.fixture(scope="session")
def client():
    """TestClient wraps the FastAPI app for in-process requests."""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def fresh_user(client):
    """Register a throwaway user and return (email, password, token, user_id).
    Auto-deletes the account after the test."""
    email = f"pytest-{secrets.token_hex(6)}@example.com"
    password = "PytestPass123!"

    reg = client.post("/register", json={"email": email, "password": password})
    assert reg.status_code == 200, f"register failed ({reg.status_code}): {reg.text}"
    data = reg.json()
    token = data["access_token"]
    user_id = data["user"]["id"]

    yield {
        "email": email,
        "password": password,
        "token": token,
        "user_id": user_id,
        "headers": {"Authorization": f"Bearer {token}"},
    }

    try:
        client.delete("/account", headers={"Authorization": f"Bearer {token}"})
    except Exception:
        pass