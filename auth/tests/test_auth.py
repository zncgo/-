from __future__ import annotations

import json
from pathlib import Path

import pytest

from auth import config
from auth.device import fingerprint, installation_id
from auth.gateway import AuthGateway
from auth.netverify import AuthSession, AuthState, NetVerifyAdapter, NetVerifyError
from auth.secure_store import CredentialRecord, EncryptedCredentialStore, SecureStoreError
from auth.session import SESSION_ID_BYTES, SessionError, SessionManager


class Clock:
    def __init__(self, value: float = 1_000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class FakeTransport:
    def __init__(self, private_key: str | None = None) -> None:
        self.token: str | None = None
        self.rsa_private_key = private_key or f"rsa-key-created-for-this-login-{id(self)}"
        self.login_result = {"code": 20000, "data": {"user": {"username": "alice", "max_devices": 2}, "is_valid": True, "expire_time": "2099-01-01T00:00:00Z", "heart_interval": 60}}
        self.heartbeat_results: list[object] = [{"code": 20000, "data": {"is_active": True, "username": "alice", "expire_time": "2099-01-01T00:00:00Z", "interval": 60, "commands": []}}]
        self.recharge_result = {"code": 20000, "data": {"new_expire_time": "2099-01-01T00:00:00Z"}}
        self.update_result = {"code": 20000, "data": {}}
        self.login_calls: list[tuple[str, str, str]] = []
        self.heartbeat_calls = 0
        self.clear_calls = 0

    def login(self, username: str, password: str, hwid: str, device_name: str | None = None):
        self.login_calls.append((username, password, hwid))
        if isinstance(self.login_result, BaseException):
            raise self.login_result
        self.token = "token-login"
        return self.login_result

    def heartbeat(self, hwid: str, device_name: str | None = None):
        self.heartbeat_calls += 1
        result = self.heartbeat_results[min(self.heartbeat_calls - 1, len(self.heartbeat_results) - 1)]
        if isinstance(result, BaseException):
            raise result
        if isinstance(result, tuple):
            self.token = result[0]
            return result[1]
        return result

    def recharge(self, code: str, hwid: str | None = None):
        return self.recharge_result

    def check_update(self, current_version: str):
        return self.update_result

    def clear_token(self) -> None:
        self.clear_calls += 1
        self.token = None


class Factory:
    def __init__(self) -> None:
        self.instances: list[FakeTransport] = []
        self.keys: list[str | None] = []
        self.expected_key: str | None = None

    def __call__(self, private_key: str | None = None) -> FakeTransport:
        if self.expected_key is not None and private_key != self.expected_key:
            raise ValueError("RSA pairing mismatch")
        self.keys.append(private_key)
        transport = FakeTransport(private_key)
        self.instances.append(transport)
        return transport


def gateway(tmp_path: Path, factory: Factory | None = None, store=None, clock: Clock | None = None) -> AuthGateway:
    if store is None:
        key_file = tmp_path / "master-key"
        key_file.write_bytes(b"k" * 32)
        store = EncryptedCredentialStore(tmp_path / "auth-store", key_file)
    return AuthGateway(
        store=store,
        transport_factory=factory or Factory(),
        storage_dir=tmp_path / "state",
        clock=clock or Clock(),
    )


def real_store(tmp_path: Path) -> EncryptedCredentialStore:
    key_file = tmp_path / "gateway-master-key"
    key_file.write_bytes(b"k" * 32)
    return EncryptedCredentialStore(tmp_path / "gateway-store", key_file)


def login(gateway_app: AuthGateway, username: str = "alice", password: str = "correct"):
    return gateway_app.handle("POST", "/api/auth/login", {"Content-Type": "application/json"}, json.dumps({"username": username, "password": password}).encode(), "127.0.0.1")


def cookie_from(headers: dict[str, str]) -> str:
    return headers["Set-Cookie"].split(";", 1)[0]


def assert_state(response, state: AuthState) -> dict:
    status, _, body = response
    payload = json.loads(body)
    assert status == 200
    assert payload["state"] == state.value
    return payload


def test_nine_states_are_explicit():
    assert [state.value for state in AuthState] == ["signedOut", "signedInUnlicensed", "active", "expired", "deviceLimit", "upgradeRequired", "appDisabled", "networkError", "forcedOut"]


def test_public_session_payload_is_whitelist_only():
    payload = AuthSession(AuthState.ACTIVE, username="alice", device_fingerprint="abc123").to_public_dict()
    assert set(payload) == {"state", "username", "deviceFingerprint", "expireTime", "remainingSeconds", "maxDevices", "boundDevices", "heartbeatIntervalS", "message", "upgradeUrl", "latestVersion", "canEnterStudio"}


def test_public_payload_contains_no_raw_hwid_password_token_or_config():
    payload = json.dumps(AuthSession(AuthState.ACTIVE, username="alice", device_fingerprint="abc123").to_public_dict())
    assert "token" not in payload.lower()
    assert "password" not in payload.lower()
    assert "app_id" not in payload.lower()
    assert "raw-hwid" not in payload


def test_session_id_has_256_bits():
    manager = SessionManager()
    adapter = NetVerifyAdapter(FakeTransport(), hwid="device", app_version="0.1.0")
    value = manager.start(adapter)
    assert len(value) >= 43
    assert SESSION_ID_BYTES == 32


def test_session_rejects_wrong_cookie():
    manager = SessionManager()
    manager.start(NetVerifyAdapter(FakeTransport(), hwid="device", app_version="0.1.0"))
    with pytest.raises(SessionError):
        manager.adapter("wrong-cookie")


def test_installation_id_is_stable(tmp_path: Path):
    first = installation_id(tmp_path)
    second = installation_id(tmp_path)
    assert first == second
    assert len(first) == 64


def test_deleting_installation_volume_creates_new_device(tmp_path: Path):
    first = installation_id(tmp_path)
    (tmp_path / "installation-id").unlink()
    assert installation_id(tmp_path) != first


def test_fingerprint_is_short_and_not_raw():
    value = fingerprint("a" * 64)
    assert len(value) == 12
    assert value != "a" * 64


def test_encrypted_store_round_trip(tmp_path: Path):
    key_file = tmp_path / "master"
    key_file.write_bytes(b"k" * 32)
    store = EncryptedCredentialStore(tmp_path / "store", key_file)
    record = CredentialRecord("secret-token", "matching-rsa-key", 1000.0, "2099-01-01", "alice")
    store.save(record)
    assert store.load() == record
    assert b"secret-token" not in (tmp_path / "store" / "credentials.enc").read_bytes()


def test_encrypted_store_requires_256_bit_master_key(tmp_path: Path):
    key_file = tmp_path / "master"
    key_file.write_bytes(b"short")
    with pytest.raises(SecureStoreError):
        EncryptedCredentialStore(tmp_path / "store", key_file)


def test_encrypted_store_rejects_unpaired_credentials(tmp_path: Path):
    key_file = tmp_path / "master"
    key_file.write_bytes(b"k" * 32)
    store = EncryptedCredentialStore(tmp_path / "store", key_file)
    with pytest.raises(SecureStoreError):
        store.save(CredentialRecord("token", "", 0, None))


def test_orphan_credential_files_are_removed(tmp_path: Path):
    key_file = tmp_path / "master"
    key_file.write_bytes(b"k" * 32)
    root = tmp_path / "store"
    root.mkdir()
    (root / "token.enc").write_text("orphan")
    store = EncryptedCredentialStore(root, key_file)
    assert store.load() is None
    assert not (root / "token.enc").exists()


def test_corrupt_envelope_is_deleted(tmp_path: Path):
    key_file = tmp_path / "master"
    key_file.write_bytes(b"k" * 32)
    root = tmp_path / "store"
    root.mkdir()
    (root / "credentials.enc").write_text("not-json")
    store = EncryptedCredentialStore(root, key_file)
    assert store.load() is None
    assert not (root / "credentials.enc").exists()


def test_login_active_state_and_persistence(tmp_path: Path):
    store = real_store(tmp_path)
    app = gateway(tmp_path, store=store)
    status, headers, body = login(app)
    assert status == 200
    assert json.loads(body)["state"] == "active"
    assert "Set-Cookie" in headers
    assert store.load() is not None


def test_login_unlicensed_state(tmp_path: Path):
    transport = FakeTransport()
    transport.login_result = {"code": 20000, "data": {"user": {"username": "alice"}, "is_valid": False, "expire_time": None}}
    factory = Factory()
    factory.instances.append(transport)
    app = gateway(tmp_path, factory=lambda key: transport)
    assert_state(login(app), AuthState.SIGNED_IN_UNLICENSED)


def test_login_expired_state(tmp_path: Path):
    transport = FakeTransport()
    transport.login_result = {"code": 20000, "data": {"user": {"username": "alice"}, "is_valid": False, "expire_time": "2020-01-01T00:00:00Z"}}
    app = gateway(tmp_path, factory=lambda key: transport)
    assert_state(login(app), AuthState.EXPIRED)


def test_login_app_disabled_state(tmp_path: Path):
    transport = FakeTransport()
    transport.login_result = {"code": 20000, "data": {"user": {"username": "alice"}, "is_valid": False, "is_active": False, "valid_message": "应用已下线"}}
    app = gateway(tmp_path, factory=lambda key: transport)
    assert_state(login(app), AuthState.APP_DISABLED)


def test_login_device_limit_state(tmp_path: Path):
    transport = FakeTransport()
    transport.login_result = NetVerifyError(400, "设备绑定数量超限", 409)
    app = gateway(tmp_path, factory=lambda key: transport)
    assert_state(login(app), AuthState.DEVICE_LIMIT)


def test_enter_studio_upgrade_required():
    transport = FakeTransport()
    transport.update_result = {"code": 20000, "data": {"force_upgrade": True, "latest_version": "2.0.0"}}
    adapter = NetVerifyAdapter(transport, hwid="device", app_version="0.1.0")
    adapter.login("alice", "correct")
    assert adapter.enter_studio().state is AuthState.UPGRADE_REQUIRED


def test_network_error_retries_at_most_three_times():
    calls = 0

    def operation():
        nonlocal calls
        calls += 1
        raise ConnectionError("offline")

    with pytest.raises(ConnectionError):
        NetVerifyAdapter._call_with_retry(operation, retries=3, sleep=lambda _: None)
    assert calls == 3


def test_business_error_is_not_retried():
    calls = 0

    def operation():
        nonlocal calls
        calls += 1
        raise NetVerifyError(401, "bad credentials")

    with pytest.raises(NetVerifyError):
        NetVerifyAdapter._call_with_retry(operation, retries=3, sleep=lambda _: None)
    assert calls == 1


def test_heartbeat_network_error_keeps_token_and_identity():
    clock = Clock()
    transport = FakeTransport()
    adapter = NetVerifyAdapter(transport, hwid="device", app_version="0.1.0", clock=clock, retry_sleep=lambda _: None)
    adapter.login("alice", "correct")
    transport.heartbeat_results = [ConnectionError("offline")]
    assert adapter.heartbeat().state is AuthState.NETWORK_ERROR
    assert adapter.token_present
    assert adapter.session.username == "alice"


def test_network_grace_includes_exact_30_minutes():
    clock = Clock(1000)
    adapter = NetVerifyAdapter(FakeTransport(), hwid="device", app_version="0.1.0", clock=clock)
    adapter.login("alice", "correct")
    adapter._session = AuthSession(AuthState.NETWORK_ERROR, username="alice", device_fingerprint=fingerprint("device"))
    clock.value = 1000 + 1800
    assert adapter.within_grace()


def test_network_grace_expires_after_30_minutes():
    clock = Clock(1000)
    adapter = NetVerifyAdapter(FakeTransport(), hwid="device", app_version="0.1.0", clock=clock)
    adapter.login("alice", "correct")
    adapter._session = AuthSession(AuthState.NETWORK_ERROR, username="alice", device_fingerprint=fingerprint("device"))
    clock.value = 1000 + 1800.01
    assert not adapter.within_grace()


def test_forced_out_clears_credentials_and_preserves_work():
    preserved = []
    cleared = []
    transport = FakeTransport()
    adapter = NetVerifyAdapter(transport, hwid="device", app_version="0.1.0", on_clear_credentials=lambda: cleared.append(True), on_preserve_work=lambda: preserved.append(True))
    adapter.login("alice", "correct")
    transport.heartbeat_results = [{"code": 20000, "data": {"commands": ["force_logout"]}}]
    assert adapter.heartbeat().state is AuthState.FORCED_OUT
    assert transport.clear_calls == 1
    assert cleared == [True]
    assert preserved == [True]


def test_activation_transitions_to_active():
    adapter = NetVerifyAdapter(FakeTransport(), hwid="device", app_version="0.1.0")
    adapter._session = AuthSession(AuthState.SIGNED_IN_UNLICENSED, username="alice", device_fingerprint=fingerprint("device"))
    adapter._transport.token = "token"
    assert adapter.activate("card-code").state is AuthState.ACTIVE


def test_fixed_connection_config_ignores_environment(monkeypatch):
    monkeypatch.setenv("AUTOCUT_NETVERIFY_BASE_URL", "https://attacker.invalid")
    monkeypatch.setenv("AUTOCUT_NETVERIFY_APP_ID", "999")
    monkeypatch.setenv("AUTOCUT_NETVERIFY_APP_SECRET", "secret")
    assert config.NETVERIFY_BASE_URL == "https://yz.ledougc.com/api"
    assert config.NETVERIFY_APP_ID == 96
    assert config.NETVERIFY_APP_SECRET is None


def test_registration_endpoint_is_not_provided(tmp_path: Path):
    app = gateway(tmp_path)
    status, _, _ = app.handle("POST", "/api/auth/register", {}, b"{}")
    assert status == 404


def test_login_rate_limit_is_five_per_minute(tmp_path: Path):
    app = gateway(tmp_path)
    results = [login(app, password="bad") for _ in range(6)]
    assert [result[0] for result in results[:5]] == [200] * 5
    assert results[5][0] == 429


def test_session_cookie_is_http_only_strict_and_opaque(tmp_path: Path):
    _, headers, _ = login(gateway(tmp_path))
    cookie = headers["Set-Cookie"]
    assert "HttpOnly" in cookie
    assert "SameSite=Strict" in cookie
    assert "Path=/" in cookie
    assert "alice" not in cookie


def test_https_forwarded_request_sets_secure_cookie(tmp_path: Path):
    app = gateway(tmp_path)
    _, headers, _ = app.handle("POST", "/api/auth/login", {"x-forwarded-proto": "https", "content-type": "application/json"}, json.dumps({"username": "alice", "password": "correct"}).encode())
    assert "Secure" in headers["Set-Cookie"]


@pytest.mark.parametrize("path", ["/api/query", "/api/cookies", "/api/cookies/import", "/api/status", "/rsshub/fallback"])
def test_all_functional_routes_require_auth(tmp_path: Path, path: str):
    app = gateway(tmp_path)
    method = "POST" if path.endswith("import") else "GET"
    status, _, _ = app.handle(method, path, {}, b"{}")
    assert status == 401


def test_authorized_functional_route_is_proxied(tmp_path: Path):
    app = gateway(tmp_path)
    _, headers, _ = login(app)
    app._proxy = lambda method, path, request_headers, body: (200, {"Content-Type": "application/json"}, b'{"ok":true}')
    status, _, body = app.handle("GET", "/api/status", {"cookie": cookie_from(headers)})
    assert status == 200
    assert body == b'{"ok":true}'


def test_restart_without_cookie_recovers_with_heartbeat(tmp_path: Path):
    store = real_store(tmp_path)
    factory = Factory()
    first = gateway(tmp_path, factory, store)
    _, old_headers, _ = login(first)
    old_key = store.load().rsa_private_key
    second_factory = Factory()
    second_factory.expected_key = old_key
    second = gateway(tmp_path, second_factory, store)
    status, headers, body = second.handle("GET", "/api/auth/session", {})
    assert status == 200
    assert json.loads(body)["state"] == "active"
    assert "Set-Cookie" in headers
    assert second_factory.keys == [old_key]
    assert cookie_from(headers) != cookie_from(old_headers)


def test_login_protected_request_restart_recovery_and_protected_request(tmp_path: Path):
    store = real_store(tmp_path)
    first_factory = Factory()
    first = gateway(tmp_path, first_factory, store)
    _, old_headers, _ = login(first)
    first._proxy = lambda method, path, request_headers, body: (200, {}, b"protected-ok")
    assert first.handle("GET", "/api/query", {"cookie": cookie_from(old_headers)})[0] == 200

    second_factory = Factory()
    second = gateway(tmp_path, second_factory, store)
    status, new_headers, body = second.handle("GET", "/api/auth/session", {})
    assert status == 200
    assert json.loads(body)["state"] == "active"
    second._proxy = lambda method, path, request_headers, body: (200, {}, b"protected-ok")
    assert second.handle("GET", "/api/query", {"cookie": cookie_from(new_headers)})[0] == 200


def test_recovery_network_error_within_grace_keeps_session(tmp_path: Path):
    clock = Clock(1000)
    store = real_store(tmp_path)
    first_factory = Factory()
    first = gateway(tmp_path, first_factory, store, clock)
    login(first)
    recovery_factory = Factory()
    recovery_factory.instances = []

    def factory(private_key):
        transport = FakeTransport(private_key)
        transport.heartbeat_results = [ConnectionError("offline")]
        recovery_factory.instances.append(transport)
        return transport

    second = AuthGateway(store=store, transport_factory=factory, storage_dir=tmp_path / "state", clock=clock)
    status, headers, body = second.handle("GET", "/api/auth/session", {})
    assert status == 200
    assert json.loads(body)["state"] == "networkError"
    second._proxy = lambda method, path, request_headers, body: (200, {}, b"ok")
    assert second.handle("GET", "/api/query", {"cookie": cookie_from(headers)})[0] == 200


def test_recovery_network_error_after_grace_blocks_new_requests(tmp_path: Path):
    clock = Clock(1000)
    store = real_store(tmp_path)
    first = gateway(tmp_path, Factory(), store, clock)
    login(first)
    clock.value = 1000 + 1800.01

    def factory(private_key):
        transport = FakeTransport(private_key)
        transport.heartbeat_results = [ConnectionError("offline")]
        return transport

    second = AuthGateway(store=store, transport_factory=factory, storage_dir=tmp_path / "state", clock=clock)
    _, headers, body = second.handle("GET", "/api/auth/session", {})
    assert json.loads(body)["state"] == "networkError"
    assert second.handle("GET", "/api/query", {"cookie": cookie_from(headers)})[0] == 403


def test_token_rotation_is_persisted_immediately(tmp_path: Path):
    store = real_store(tmp_path)
    factory = Factory()
    app = gateway(tmp_path, factory, store)
    _, headers, _ = login(app)
    transport = factory.instances[-1]
    transport.heartbeat_results = [("token-rotated", {"code": 20000, "data": {"is_active": True, "username": "alice", "commands": []}})]
    app.handle("POST", "/api/auth/heartbeat", {"cookie": cookie_from(headers)})
    assert store.load() is not None
    assert store.load().token == "token-rotated"


def test_fresh_password_login_does_not_reuse_old_private_key(tmp_path: Path):
    store = real_store(tmp_path)
    first_factory = Factory()
    first = gateway(tmp_path, first_factory, store)
    _, headers, _ = login(first)
    old_key = store.load().rsa_private_key
    second_factory = Factory()
    second = gateway(tmp_path, second_factory, store)
    login(second)
    assert second_factory.keys == [None]
    assert second_factory.instances[0].rsa_private_key != old_key


def test_expired_authorization_is_forbidden(tmp_path: Path):
    app = gateway(tmp_path)
    _, headers, _ = login(app)
    adapter = app.sessions.adapter(cookie_from(headers).split("=", 1)[1])
    adapter._session = AuthSession(AuthState.EXPIRED, username="alice", device_fingerprint=fingerprint("device"))
    assert app.handle("GET", "/api/query", {"cookie": cookie_from(headers)})[0] == 403
