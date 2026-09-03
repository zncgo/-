"""NetVerify transport adapter and nine-state authorization state machine."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Protocol

from .device import fingerprint

logger = logging.getLogger(__name__)
NETVERIFY_OK = 20000
FORCE_LOGOUT = "force_logout"
GRACE_SECONDS = 30 * 60


class AuthState(str, Enum):
    SIGNED_OUT = "signedOut"
    SIGNED_IN_UNLICENSED = "signedInUnlicensed"
    ACTIVE = "active"
    EXPIRED = "expired"
    DEVICE_LIMIT = "deviceLimit"
    UPGRADE_REQUIRED = "upgradeRequired"
    APP_DISABLED = "appDisabled"
    NETWORK_ERROR = "networkError"
    FORCED_OUT = "forcedOut"


class NetVerifyError(Exception):
    def __init__(self, code: int, message: str, http_status: int | None = None) -> None:
        self.code = code
        self.message = message
        self.http_status = http_status
        super().__init__("授权服务错误")

    @property
    def is_device_limit(self) -> bool:
        text = self.message.lower()
        return self.http_status == 409 or any(mark in text for mark in ("设备绑定数量超限", "设备数量超限", "device limit"))

    @property
    def is_app_disabled(self) -> bool:
        text = self.message.lower()
        return self.http_status == 403 and ("下线" in text or "disabled" in text or "应用" in text)


class NetVerifyTransport(Protocol):
    token: str | None

    def login(self, username: str, password: str, hwid: str, device_name: str | None = ...) -> dict[str, Any]: ...
    def heartbeat(self, hwid: str, device_name: str | None = ...) -> dict[str, Any]: ...
    def recharge(self, code: str, hwid: str | None = ...) -> dict[str, Any]: ...
    def check_update(self, current_version: str) -> dict[str, Any]: ...
    def clear_token(self) -> None: ...


@dataclass(frozen=True, slots=True)
class AuthSession:
    state: AuthState
    username: str = ""
    device_fingerprint: str = ""
    expire_time: str | None = None
    remaining_seconds: int | None = None
    max_devices: int | None = None
    bound_devices: int | None = None
    heartbeat_interval_s: int = 60
    message: str | None = None
    upgrade_url: str | None = None
    latest_version: str | None = None

    @property
    def can_enter_studio(self) -> bool:
        return self.state is AuthState.ACTIVE

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "state": self.state.value,
            "username": self.username,
            "deviceFingerprint": self.device_fingerprint,
            "expireTime": self.expire_time,
            "remainingSeconds": self.remaining_seconds,
            "maxDevices": self.max_devices,
            "boundDevices": self.bound_devices,
            "heartbeatIntervalS": self.heartbeat_interval_s,
            "message": self.message,
            "upgradeUrl": self.upgrade_url,
            "latestVersion": self.latest_version,
            "canEnterStudio": self.can_enter_studio,
        }

    def __repr__(self) -> str:
        return f"AuthSession(state={self.state.value!r}, device={self.device_fingerprint!r})"


def _parse_expire(value: str | None) -> datetime | None:
    if not value:
        return None


def _is_sdk_business_error(exc: BaseException) -> bool:
    return isinstance(exc, NetVerifyError) or (isinstance(getattr(exc, "code", None), int) and isinstance(getattr(exc, "message", None), str))


def _is_network_error(exc: BaseException) -> bool:
    if isinstance(exc, (TimeoutError, ConnectionError, OSError)):
        return True
    try:
        import requests

        return isinstance(exc, requests.exceptions.RequestException)
    except ImportError:
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class NetVerifyAdapter:
    def __init__(
        self,
        transport: NetVerifyTransport,
        *,
        hwid: str,
        app_version: str,
        clock: Callable[[], float] = time.time,
        retry_sleep: Callable[[float], None] = time.sleep,
        on_persist_state: Callable[["NetVerifyAdapter"], None] | None = None,
        on_clear_credentials: Callable[[], None] | None = None,
        on_preserve_work: Callable[[], None] | None = None,
    ) -> None:
        self._transport = transport
        self._hwid = hwid
        self._fingerprint = fingerprint(hwid)
        self._app_version = app_version
        self._clock = clock
        self._retry_sleep = retry_sleep
        self._on_persist_state = on_persist_state
        self._on_clear_credentials = on_clear_credentials
        self._on_preserve_work = on_preserve_work
        self.last_success_heartbeat: float | None = None
        self._session = AuthSession(state=AuthState.SIGNED_OUT, device_fingerprint=self._fingerprint)

    @property
    def state(self) -> AuthState:
        return self._session.state

    @property
    def session(self) -> AuthSession:
        return self._session

    @property
    def token_present(self) -> bool:
        return bool(getattr(self._transport, "token", None))

    def restore_metadata(self, username: str, expires_at: str | None, last_success_heartbeat: float) -> None:
        """Seed only non-secret session metadata before a restart heartbeat."""

        self._session = AuthSession(
            state=AuthState.ACTIVE,
            username=username,
            device_fingerprint=self._fingerprint,
            expire_time=expires_at,
        )
        self.last_success_heartbeat = last_success_heartbeat

    @staticmethod
    def _call_with_retry(fn: Callable[..., Any], *args: Any, retries: int = 3, sleep: Callable[[float], None] = time.sleep) -> Any:
        last: BaseException | None = None
        for attempt in range(retries):
            try:
                return fn(*args)
            except (TimeoutError, ConnectionError, OSError) as exc:
                last = exc
                if attempt + 1 < retries:
                    sleep(2**attempt)
            except NetVerifyError:
                raise
            except Exception as exc:  # noqa: BLE001 - classify SDK boundary errors
                if _is_sdk_business_error(exc):
                    raise
                if not _is_network_error(exc):
                    raise
                last = exc
                if attempt + 1 < retries:
                    sleep(2**attempt)
        assert last is not None
        raise last

    @staticmethod
    def _require_ok(result: dict[str, Any]) -> dict[str, Any]:
        code = result.get("code", NETVERIFY_OK)
        if code != NETVERIFY_OK:
            raise NetVerifyError(int(code), str(result.get("message", "授权服务返回失败")), result.get("status"))
        return result.get("data") if isinstance(result.get("data"), dict) else {}

    @staticmethod
    def _state_from_error(exc: BaseException) -> tuple[AuthState, str]:
        if _is_sdk_business_error(exc):
            business = exc if isinstance(exc, NetVerifyError) else NetVerifyError(getattr(exc, "code"), getattr(exc, "message"), getattr(exc, "http_status", None))
            if business.is_app_disabled:
                return AuthState.APP_DISABLED, "应用已下线"
            if business.is_device_limit:
                return AuthState.DEVICE_LIMIT, "设备数量已达上限"
            return AuthState.SIGNED_OUT, "登录失败，请检查账号或密码"
        if _is_network_error(exc):
            return AuthState.NETWORK_ERROR, "无法连接授权服务器"
        return AuthState.NETWORK_ERROR, "授权服务暂时不可用"

    def _failed(self, exc: BaseException, keep_identity: bool = False) -> AuthSession:
        state, message = self._state_from_error(exc)
        previous = self._session if keep_identity else AuthSession(state=state, device_fingerprint=self._fingerprint)
        self._session = AuthSession(
            state=state,
            username=previous.username,
            device_fingerprint=self._fingerprint,
            expire_time=previous.expire_time,
            remaining_seconds=previous.remaining_seconds,
            max_devices=previous.max_devices,
            bound_devices=previous.bound_devices,
            heartbeat_interval_s=previous.heartbeat_interval_s,
            message=message,
        )
        return self._session

    def _persist(self) -> None:
        if self._on_persist_state:
            self._on_persist_state(self)

    def login(self, username: str, password: str) -> AuthSession:
        try:
            data = self._require_ok(self._call_with_retry(
                self._transport.login, username, password, self._hwid, retries=3, sleep=self._retry_sleep
            ))
        except Exception as exc:  # noqa: BLE001
            return self._failed(exc)
        user = data.get("user") or {}
        expire = data.get("expire_time") or user.get("expire_time")
        parsed = _parse_expire(expire)
        self._session = AuthSession(
            state=self._licence_state(data),
            username=str(user.get("username", "")),
            device_fingerprint=self._fingerprint,
            expire_time=expire,
            remaining_seconds=max(0, int((parsed - datetime.now(UTC)).total_seconds())) if parsed else None,
            max_devices=user.get("max_devices"),
            heartbeat_interval_s=int(data.get("heart_interval") or 60),
            message=data.get("valid_message") or ("未激活，请输入卡密" if not data.get("is_valid") else None),
        )
        self.last_success_heartbeat = self._clock()
        self._persist()
        return self._session

    @staticmethod
    def _licence_state(data: dict[str, Any]) -> AuthState:
        if data.get("is_active") is False and ("下线" in str(data.get("valid_message", ""))):
            return AuthState.APP_DISABLED
        if data.get("is_valid"):
            return AuthState.ACTIVE
        if not data.get("expire_time"):
            return AuthState.SIGNED_IN_UNLICENSED
        return AuthState.EXPIRED

    def activate(self, code: str) -> AuthSession:
        if self.state is AuthState.SIGNED_OUT:
            raise NetVerifyError(40001, "请先登录再激活")
        try:
            data = self._require_ok(self._call_with_retry(
                self._transport.recharge, code, self._hwid, retries=3, sleep=self._retry_sleep
            ))
        except Exception as exc:  # noqa: BLE001
            return self._failed(exc, keep_identity=True)
        expire = data.get("new_expire_time") or data.get("expire_time")
        self._session = AuthSession(
            state=AuthState.ACTIVE,
            username=self._session.username,
            device_fingerprint=self._fingerprint,
            expire_time=expire,
            max_devices=self._session.max_devices,
            heartbeat_interval_s=self._session.heartbeat_interval_s,
            message="激活成功",
        )
        self.last_success_heartbeat = self._clock()
        self._persist()
        return self._session

    def enter_studio(self) -> AuthSession:
        if self.state in (AuthState.SIGNED_OUT, AuthState.FORCED_OUT):
            return self._session
        try:
            update = self._require_ok(self._call_with_retry(
                self._transport.check_update, self._app_version, retries=3, sleep=self._retry_sleep
            ))
        except Exception:
            return self._session
        if update.get("force_upgrade"):
            self._session = AuthSession(
                state=AuthState.UPGRADE_REQUIRED,
                username=self._session.username,
                device_fingerprint=self._fingerprint,
                expire_time=self._session.expire_time,
                message="当前版本必须升级",
                upgrade_url=update.get("download_url"),
                latest_version=update.get("latest_version"),
            )
        return self._session

    def heartbeat(self) -> AuthSession:
        if not self.token_present:
            return self._session
        try:
            data = self._require_ok(self._call_with_retry(
                self._transport.heartbeat, self._hwid, retries=3, sleep=self._retry_sleep
            ))
        except Exception as exc:  # noqa: BLE001
            return self._failed(exc, keep_identity=True)
        if FORCE_LOGOUT in (data.get("commands") or []):
            return self._force_out("服务器要求重新登录")
        message = str(data.get("valid_message") or "")
        if data.get("app_disabled") or "下线" in message:
            self._session = AuthSession(state=AuthState.APP_DISABLED, username=self._session.username, device_fingerprint=self._fingerprint, message="应用已下线")
        else:
            active = bool(data.get("is_active", True))
            self._session = AuthSession(
                state=AuthState.ACTIVE if active else AuthState.EXPIRED,
                username=str(data.get("username") or self._session.username),
                device_fingerprint=self._fingerprint,
                expire_time=data.get("expire_time") or self._session.expire_time,
                max_devices=data.get("max_devices", self._session.max_devices),
                bound_devices=data.get("bound_devices"),
                heartbeat_interval_s=int(data.get("interval") or self._session.heartbeat_interval_s),
                message=None if active else "授权已过期",
            )
        self.last_success_heartbeat = self._clock()
        self._persist()
        return self._session

    def _force_out(self, message: str) -> AuthSession:
        if self._on_preserve_work:
            try:
                self._on_preserve_work()
            except Exception:
                logger.warning("强退前保存工作状态失败")
        try:
            self._transport.clear_token()
        finally:
            if self._on_clear_credentials:
                self._on_clear_credentials()
        self._session = AuthSession(state=AuthState.FORCED_OUT, username=self._session.username, device_fingerprint=self._fingerprint, message=message)
        return self._session

    def logout(self) -> AuthSession:
        try:
            self._transport.clear_token()
        finally:
            if self._on_clear_credentials:
                self._on_clear_credentials()
        self._session = AuthSession(state=AuthState.SIGNED_OUT, device_fingerprint=self._fingerprint)
        return self._session

    def within_grace(self, now: float | None = None) -> bool:
        if self.state is AuthState.ACTIVE:
            return True
        if self.state is not AuthState.NETWORK_ERROR or self.last_success_heartbeat is None:
            return False
        return (self._clock() if now is None else now) - self.last_success_heartbeat <= GRACE_SECONDS


def load_sdk_transport(base_url: str, app_id: int, app_secret: str | None, sdk_dir: str, rsa_private_key: str | None = None) -> NetVerifyTransport:
    """Load the unmodified vendored SDK only at the external transport boundary."""

    import importlib.util
    import sys
    from pathlib import Path

    module_file = Path(sdk_dir) / "netverify_client.py"
    spec = importlib.util.spec_from_file_location("rsshub_netverify_sdk", module_file)
    if spec is None or spec.loader is None:
        raise NetVerifyError(50000, "授权 SDK 不可用")
    module = importlib.util.module_from_spec(spec)
    sys.modules["rsshub_netverify_sdk"] = module
    spec.loader.exec_module(module)
    return module.NetVerifyClient(base_url, app_id, app_secret, rsa_private_key=rsa_private_key, timeout=30)
