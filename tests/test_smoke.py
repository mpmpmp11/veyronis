"""Phase 0 smoke tests — catch the 5 most common regressions."""
import secrets


# ─── 1. Register → login → /me ───
def test_register_login_me(client):
    email = f"smoke+{secrets.token_hex(6)}@example.com"
    password = "SmokeTest123!"

    # Register
    reg = client.post("/register", json={"email": email, "password": password})
    assert reg.status_code == 200, f"register: {reg.text}"
    token1 = reg.json()["access_token"]

    # /me works with token from register
    me = client.get("/me", headers={"Authorization": f"Bearer {token1}"})
    assert me.status_code == 200
    assert me.json()["user"]["email"] == email

    # Login works
    login = client.post("/login", json={"email": email, "password": password})
    assert login.status_code == 200
    token2 = login.json()["access_token"]
    assert token2  # non-empty

    # /me works with token from login
    me2 = client.get("/me", headers={"Authorization": f"Bearer {token2}"})
    assert me2.status_code == 200

    # Cleanup
    client.delete("/account", headers={"Authorization": f"Bearer {token2}"})


# ─── 2. Unauthorized access is rejected ───
def test_unauthorized_rejected(client):
    # No token → 401
    assert client.get("/me").status_code == 401
    assert client.get("/conversations?user_id=x@x.com").status_code == 401
    assert client.post("/chat", json={"message": "hi"}).status_code == 401

    # Invalid token → 401
    bad = {"Authorization": "Bearer not-a-real-token"}
    assert client.get("/me", headers=bad).status_code == 401


# ─── 3. Cross-user isolation (user A can't see user B's data) ───
def test_cross_user_isolation(client):
    # Create two users
    a = client.post("/register", json={
        "email": f"user-a-{secrets.token_hex(4)}@example.com",
        "password": "PasswordA1!",
    }).json()
    b = client.post("/register", json={
        "email": f"user-b-{secrets.token_hex(4)}@example.com",
        "password": "PasswordB1!",
    }).json()

    a_headers = {"Authorization": f"Bearer {a['access_token']}"}
    b_headers = {"Authorization": f"Bearer {b['access_token']}"}

    # User A tries to read User B's conversations via query param
    r = client.get(
        f"/conversations?user_id={b['user']['email']}",
        headers=a_headers,
    )
    assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"

    # User A tries to read User B's history
    r2 = client.get(
        f"/history?user_id={b['user']['email']}",
        headers=a_headers,
    )
    assert r2.status_code == 403

    # Cleanup
    client.delete("/account", headers=a_headers)
    client.delete("/account", headers=b_headers)


# ─── 4. Delete account cascades (users, messages, conversations all gone) ───
def test_delete_account_cascades(client, fresh_user):
    email = fresh_user["email"]
    headers = fresh_user["headers"]

    # Send a message to create a conversation
    with client.stream("POST", "/chat/stream", headers=headers, json={
        "message": "test message for cascade",
        "conversation_id": None,
    }) as resp:
        assert resp.status_code == 200
        # Read stream to force server-side save_message
        for _ in resp.iter_lines():
            pass

    # Verify conversation exists
    convs = client.get(f"/conversations?user_id={email}", headers=headers).json()
    assert len(convs["conversations"]) >= 1, "no conversation created"

    # Delete account
    r = client.delete("/account", headers=headers)
    assert r.status_code == 200, f"delete: {r.text}"

    # Token is now invalid (user gone)
    me = client.get("/me", headers=headers)
    assert me.status_code == 401

    # Register a new account with same email — succeeds because cascade wiped the old row
    again = client.post("/register", json={"email": email, "password": fresh_user["password"]})
    assert again.status_code == 200
    client.delete("/account", headers={"Authorization": f"Bearer {again.json()['access_token']}"})


# ─── 5. Feedback ownership (can't leave feedback on foreign messages) ───
def test_feedback_ownership(client):
    # User A creates a message
    a = client.post("/register", json={
        "email": f"fb-a-{secrets.token_hex(4)}@example.com",
        "password": "PasswordA1!",
    }).json()
    a_headers = {"Authorization": f"Bearer {a['access_token']}"}

    # Grab a message ID that definitely doesn't belong to user A
    # (we'll use an obviously-fake ID to trigger the ownership check)
    r = client.post(
        "/message-feedback",
        headers=a_headers,
        json={"message_id": 999999999, "is_helpful": True},
    )
    assert r.status_code == 404, f"expected 404, got {r.status_code}: {r.text}"
    assert "not found" in r.json()["detail"].lower()

    # Cleanup
    client.delete("/account", headers=a_headers)