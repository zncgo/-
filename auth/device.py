"""Stable per-installation device identity for containers."""

from __future__ import annotations

import hashlib
import os
import secrets
from pathlib import Path

FINGERPRINT_DOMAIN = b"rsshub/netverify-installation/v1"


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temp.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp, 0o600)
        except OSError:
            pass
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def installation_id(storage_dir: Path) -> str:
    """Load or create one opaque stable ID; deleting the volume creates a device."""

    path = storage_dir / "installation-id"
    try:
        value = path.read_text(encoding="ascii").strip()
    except (FileNotFoundError, OSError, UnicodeError):
        value = ""
    if value and len(value) == 64:
        try:
            int(value, 16)
            return value
        except ValueError:
            pass
    value = secrets.token_hex(32)
    _atomic_write(path, value.encode("ascii"))
    return value


def fingerprint(raw_id: str) -> str:
    """Return the only device identifier allowed in browser payloads/logs."""

    if not raw_id:
        raise ValueError("device identity unavailable")
    return hashlib.sha256(FINGERPRINT_DOMAIN + raw_id.encode("ascii")).hexdigest()[:12]

