"""The only public HTTP entry point for the RSSHub UI and functional APIs."""

from __future__ import annotations

import http.client
import json
import logging
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import urlsplit

from . import config
from .device import installation_id
from .netverify import AuthSession, AuthState, NetVerifyAdapter, NetVerifyError, NetVerifyTransport, load_sdk_transport
from .secure_store import CredentialRecord, EncryptedCredentialStore, SecureStoreError
from .session import SessionError, SessionManager

logger = logging.getLogger("rsshub.auth")
MAX_BODY = 128 * 1024
PUBLIC_STATIC = {
    "/",
    "/core.mjs",
    "/workbook.mjs",
    "/workbook-runner.mjs",
    "/workbook-ui.mjs",
    "/vendor/jszip-3.10.1.min.js",
}


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _public(session: AuthSession) -> bytes:
    return _json_bytes(session.to_public_dict())


class LoginRateLimiter:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._attempts: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, address: str) -> bool:
        now = self._clock()
        with self._lock:
            attempts = self._attempts[address]
            while attempts and now - attempts[0] >= 60:
                attempts.popleft()
            if len(attempts) >= 5:
                return False
            attempts.append(now)
            return True


class AuthGateway:
    """Testable request dispatcher; the HTTP adapter below contains no auth logic."""

    def __init__(
        self,
        *,
        store: Any | None = None,
        transport_factory: Callable[[str | None], NetVerifyTransport] | None = None,
        storage_dir: Any = config.STORAGE_DIR,
        clock: Callable[[], float] = time.time,
        ui_upstream: str = config.UI_UPSTREAM,
        preserve_work: Callable[[], None] | None = None,
    ) -> None:
        self.storage_dir = storage_dir
        self.clock = clock
        self.ui_upstream = ui_upstream.rstrip("/")
        self.transport_factory = transport_factory
        self.store = store if store is not None else EncryptedCredentialStore(config.STORAGE_DIR, config.MASTER_KEY_FILE)
        self.sessions = SessionManager()
        self.rate_limiter = LoginRateLimiter(clock)
        self.raw_device_id = installation_id(storage_dir)
        self.preserve_work = preserve_work

    def _make_transport(self, private_key: str | None = None) -> NetVerifyTransport:
        if self.transport_factory is not None:
            return self.transport_factory(private_key)
        return load_sdk_transport(
            config.NETVERIFY_BASE_URL,
            config.NETVERIFY_APP_ID,
            config.NETVERIFY_APP_SECRET,
            str(config.SDK_DIR),
            rsa_private_key=private_key,
        )

    @staticmethod
    def _private_key(transport: NetVerifyTransport) -> str | None:
        direct = getattr(transport, "rsa_private_key", None)
        if isinstance(direct, str) and direct:
            return direct
        decryptor = getattr(transport, "_decryptor", None)
        key = getattr(decryptor, "private_key", None)
        if key is None:
            return None
        try:
            from cryptography.hazmat.primitives import serialization

            value = key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
            return value.decode("utf-8")
        except (AttributeError, TypeError, ValueError):
            return None

    def _persist(self, adapter: NetVerifyAdapter) -> None:
        token = getattr(adapter._transport, "token", None)  # noqa: SLF001
        private_key = self._private_key(adapter._transport)  # noqa: SLF001
        if not isinstance(token, str) or not token or not private_key:
            # Never retain a token without its matching response-decryption key.
            self.store.clear()
            return
        self.store.save(CredentialRecord(
            token=token,
            rsa_private_key=private_key,
            last_success_heartbeat=adapter.last_success_heartbeat or self.clock(),
            expires_at=adapter.session.expire_time,
            username=adapter.session.username,
        ))

    def _adapter(self, record: CredentialRecord | None = None) -> NetVerifyAdapter:
        private_key = record.rsa_private_key if record else None
        transport = self._make_transport(private_key)
        if record is not None:
            transport.token = record.token
        adapter = NetVerifyAdapter(
            transport,
            hwid=self.raw_device_id,
            app_version=config.APP_VERSION,
            clock=self.clock,
            on_persist_state=self._persist,
            on_clear_credentials=self.store.clear,
            on_preserve_work=self.preserve_work,
        )
        if record is not None:
            adapter.restore_metadata(record.username, record.expires_at, record.last_success_heartbeat)
        return adapter

    @staticmethod
    def _cookie(headers: dict[str, str]) -> str | None:
        raw = headers.get("cookie", "")
        for piece in raw.split(";"):
            name, separator, value = piece.strip().partition("=")
            if separator and name == config.SESSION_COOKIE:
                return value
        return None

    def _set_cookie(self, session_id: str, response_headers: dict[str, str], request_headers: dict[str, str] | None = None) -> None:
        secure = (request_headers or {}).get("x-forwarded-proto", "").lower() == "https"
        flags = [f"{config.SESSION_COOKIE}={session_id}", "Path=/", "HttpOnly", "SameSite=Strict"]
        if secure:
            flags.append("Secure")
        response_headers["Set-Cookie"] = "; ".join(flags)

    @staticmethod
    def _delete_cookie(headers: dict[str, str]) -> None:
        headers["Set-Cookie"] = f"{config.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"

    @staticmethod
    def _error(status: int, message: str) -> tuple[int, dict[str, str], bytes]:
        return status, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}, _json_bytes({"ok": False, "error": message})

    def _read_json(self, body: bytes) -> dict[str, Any] | None:
        if len(body) > MAX_BODY:
            return None
        try:
            value = json.loads(body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def _issue(self, adapter: NetVerifyAdapter, headers: dict[str, str], request_headers: dict[str, str] | None = None) -> None:
        self._persist(adapter)
        self._set_cookie(self.sessions.start(adapter), headers, request_headers)

    def _resolve_adapter(self, headers: dict[str, str]) -> NetVerifyAdapter:
        try:
            return self.sessions.adapter(self._cookie(headers))
        except SessionError as exc:
            raise exc

    def _auth_request(self, method: str, path: str, headers: dict[str, str], body: bytes, client_ip: str) -> tuple[int, dict[str, str], bytes]:
        if path == "/api/auth/login" and method == "POST":
            if not self.rate_limiter.allow(client_ip):
                return self._error(429, "登录请求过于频繁")
            data = self._read_json(body)
            if not data or not isinstance(data.get("username"), str) or not isinstance(data.get("password"), str) or not data["username"] or not data["password"]:
                return self._error(400, "登录参数无效")
            try:
                adapter = self._adapter()
                session = adapter.login(data["username"], data["password"])
            except (NetVerifyError, SecureStoreError, OSError):
                return self._error(503, "授权服务暂时不可用")
            response_headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
            if session.state in (AuthState.ACTIVE, AuthState.SIGNED_IN_UNLICENSED):
                self._issue(adapter, response_headers, headers)
            return 200, response_headers, _public(session)

        if path == "/api/auth/session" and method == "GET":
            try:
                adapter = self._resolve_adapter(headers)
                return 200, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}, _public(adapter.session)
            except SessionError:
                pass
            try:
                record = self.store.load()
            except SecureStoreError:
                return self._error(503, "授权存储不可用")
            if record is None:
                return 200, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}, _public(AuthSession(AuthState.SIGNED_OUT))
            try:
                adapter = self._adapter(record)
                session = adapter.heartbeat()
            except Exception:  # noqa: BLE001 - recovery must not expose SDK details
                self.store.clear()
                return 200, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}, _public(AuthSession(AuthState.SIGNED_OUT))
            response_headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
            if session.state in (AuthState.SIGNED_OUT, AuthState.FORCED_OUT):
                self.store.clear()
                self._delete_cookie(response_headers)
            else:
                self._issue(adapter, response_headers, headers)
            return 200, response_headers, _public(session)

        if path in ("/api/auth/activate", "/api/auth/enter-studio", "/api/auth/heartbeat", "/api/auth/logout"):
            response_headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
            try:
                adapter = self._resolve_adapter(headers)
            except SessionError:
                return self._error(401, "需要登录")
            if path == "/api/auth/activate" and method == "POST":
                data = self._read_json(body)
                if not data or not isinstance(data.get("code"), str) or not data["code"]:
                    return self._error(400, "卡密参数无效")
                try:
                    session = adapter.activate(data["code"])
                except NetVerifyError:
                    return self._error(400, "激活失败")
                self._persist(adapter)
                return 200, response_headers, _public(session)
            if path == "/api/auth/enter-studio" and method == "POST":
                return 200, response_headers, _public(adapter.enter_studio())
            if path == "/api/auth/heartbeat" and method == "POST":
                session = adapter.heartbeat()
                if session.state in (AuthState.SIGNED_OUT, AuthState.FORCED_OUT):
                    self.store.clear()
                    self._delete_cookie(response_headers)
                return 200, response_headers, _public(session)
            if path == "/api/auth/logout" and method == "POST":
                adapter.logout()
                self.sessions.clear_without_logout()
                self.store.clear()
                self._delete_cookie(response_headers)
                return 200, response_headers, _public(AuthSession(AuthState.SIGNED_OUT))
            return self._error(405, "方法不允许")

        if path == "/api/auth/events" and method == "GET":
            try:
                adapter = self._resolve_adapter(headers)
            except SessionError:
                return self._error(401, "需要登录")
            return 200, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}, _json_bytes({**adapter.session.to_public_dict(), "pollAfterS": adapter.session.heartbeat_interval_s})

        if path.startswith("/api/auth/"):
            return self._error(404, "授权接口不存在")
        return self._error(404, "授权接口不存在")

    def _authorize(self, headers: dict[str, str]) -> tuple[NetVerifyAdapter | None, tuple[int, dict[str, str], bytes] | None]:
        try:
            adapter = self._resolve_adapter(headers)
        except SessionError:
            return None, self._error(401, "需要登录")
        if adapter.state is AuthState.ACTIVE or adapter.within_grace(self.clock()):
            return adapter, None
        if adapter.state is AuthState.NETWORK_ERROR:
            return adapter, self._error(403, "授权状态暂时无法确认")
        if adapter.state is AuthState.SIGNED_OUT:
            return adapter, self._error(401, "需要登录")
        return adapter, self._error(403, "授权无效")

    def _proxy(self, method: str, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict[str, str], bytes]:
        target = urlsplit(self.ui_upstream)
        connection_class = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(target.hostname, target.port, timeout=30)
        upstream_path = path
        if target.path:
            upstream_path = f"{target.path.rstrip('/')}{path}"
        forward_headers = {key: value for key, value in headers.items() if key.lower() not in {"host", "content-length", "connection"}}
        forward_headers["Host"] = target.netloc
        if body:
            forward_headers["Content-Length"] = str(len(body))
        try:
            connection.request(method, upstream_path, body=body or None, headers=forward_headers)
            upstream = connection.getresponse()
            response_body = upstream.read(MAX_BODY * 8)
            response_headers = {key: value for key, value in upstream.getheaders() if key.lower() not in {"connection", "transfer-encoding", "content-length", "set-cookie"}}
            response_headers["Content-Length"] = str(len(response_body))
            return upstream.status, response_headers, response_body
        finally:
            connection.close()

    def handle(self, method: str, path: str, headers: dict[str, str] | None = None, body: bytes = b"", client_ip: str = "local") -> tuple[int, dict[str, str], bytes]:
        headers = {key.lower(): value for key, value in (headers or {}).items()}
        route = urlsplit(path).path
        try:
            if route == "/healthz" and method == "GET":
                return 200, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}, _json_bytes({"ok": True})
            if route.startswith("/api/auth/"):
                return self._auth_request(method, route, headers, body, client_ip)
            if route in PUBLIC_STATIC and method == "GET":
                return self._proxy(method, path, headers, body)
            _, denied = self._authorize(headers)
            if denied is not None:
                return denied
            return self._proxy(method, path, headers, body)
        except Exception:  # noqa: BLE001
            # Never serialize SDK exception text: it may contain request details.
            logger.error("gateway request failed")
            return self._error(502, "上游服务暂时不可用")


class _Handler(BaseHTTPRequestHandler):
    server: "_GatewayServer"

    def do_GET(self) -> None: self._dispatch()
    def do_POST(self) -> None: self._dispatch()
    def do_PATCH(self) -> None: self._dispatch()
    def do_DELETE(self) -> None: self._dispatch()

    def _dispatch(self) -> None:
        length = min(int(self.headers.get("Content-Length", "0") or 0), MAX_BODY + 1)
        body = self.rfile.read(length) if length else b""
        status, response_headers, response_body = self.server.app.handle(
            self.command,
            self.path,
            dict(self.headers.items()),
            body,
            self.client_address[0],
        )
        self.send_response(status)
        for key, value in response_headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class _GatewayServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], app: AuthGateway) -> None:
        self.app = app
        super().__init__(address, _Handler)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    app = AuthGateway()
    server = _GatewayServer((config.LISTEN_HOST, config.LISTEN_PORT), app)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
