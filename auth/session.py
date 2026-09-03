"""In-memory mapping from an opaque browser cookie to one adapter."""

from __future__ import annotations

import secrets
import threading
from dataclasses import dataclass

from .netverify import AuthSession, AuthState, NetVerifyAdapter

SESSION_ID_BYTES = 32


class SessionError(RuntimeError):
    """Cookie is missing or no longer maps to a live session."""


@dataclass(slots=True)
class _Entry:
    session_id: str
    adapter: NetVerifyAdapter


class SessionManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._entry: _Entry | None = None

    def start(self, adapter: NetVerifyAdapter) -> str:
        session_id = secrets.token_urlsafe(SESSION_ID_BYTES)
        with self._lock:
            self._entry = _Entry(session_id, adapter)
        return session_id

    def adapter(self, session_id: str | None) -> NetVerifyAdapter:
        with self._lock:
            entry = self._entry
        if entry is None or not session_id or not secrets.compare_digest(entry.session_id, session_id):
            raise SessionError("会话不存在或已失效")
        return entry.adapter

    def current(self) -> AuthSession:
        with self._lock:
            entry = self._entry
        return entry.adapter.session if entry else AuthSession(state=AuthState.SIGNED_OUT)

    def end(self) -> None:
        with self._lock:
            entry, self._entry = self._entry, None
        if entry is not None:
            entry.adapter.logout()

    def clear_without_logout(self) -> None:
        with self._lock:
            self._entry = None

