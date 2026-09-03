"""AES-256-GCM atomic persistence for the complete NetVerify credential pair."""

from __future__ import annotations

import base64
import json
import os
import secrets
from dataclasses import asdict, dataclass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_AAD = b"rsshub/netverify-credentials/v1"
_FILE_NAME = "credentials.enc"


class SecureStoreError(RuntimeError):
    """Encrypted storage is unavailable or invalid."""


@dataclass(frozen=True, slots=True)
class CredentialRecord:
    token: str
    rsa_private_key: str
    last_success_heartbeat: float
    expires_at: str | None
    username: str = ""


class EncryptedCredentialStore:
    """One encrypted envelope makes partial writes and token/key mismatches impossible."""

    def __init__(self, root: Path, master_key_file: Path) -> None:
        self.root = root
        self.path = root / _FILE_NAME
        self.master_key_file = master_key_file
        self.root.mkdir(parents=True, exist_ok=True)
        self._key = self._read_key(master_key_file)

    @staticmethod
    def _read_key(path: Path) -> bytes:
        try:
            key = path.read_bytes()
        except OSError as exc:
            raise SecureStoreError("授权加密主密钥不可用") from exc
        if len(key) != 32:
            raise SecureStoreError("授权加密主密钥长度无效")
        return key

    def clear_orphans(self) -> None:
        """Remove legacy split credential files, including one-sided orphans."""

        for name in ("token.enc", "rsa-private-key.enc", "private-key.enc"):
            (self.root / name).unlink(missing_ok=True)

    def save(self, record: CredentialRecord) -> None:
        if not record.token or not record.rsa_private_key:
            raise SecureStoreError("token 与 RSA 私钥必须成对保存")
        plain = json.dumps(asdict(record), ensure_ascii=False, separators=(",", ":")).encode()
        nonce = secrets.token_bytes(12)
        encrypted = AESGCM(self._key).encrypt(nonce, plain, _AAD)
        envelope = {
            "version": 1,
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(encrypted).decode("ascii"),
        }
        data = json.dumps(envelope, separators=(",", ":")).encode("ascii")
        temp = self.root / f".{_FILE_NAME}.{secrets.token_hex(8)}.tmp"
        try:
            with temp.open("xb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.chmod(temp, 0o600)
            except OSError:
                pass
            os.replace(temp, self.path)
        finally:
            temp.unlink(missing_ok=True)

    def load(self) -> CredentialRecord | None:
        self.clear_orphans()
        try:
            envelope = json.loads(self.path.read_text(encoding="ascii"))
            nonce = base64.b64decode(envelope["nonce"], validate=True)
            ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
            plain = AESGCM(self._key).decrypt(nonce, ciphertext, _AAD)
            data = json.loads(plain)
            record = CredentialRecord(
                token=str(data["token"]),
                rsa_private_key=str(data["rsa_private_key"]),
                last_success_heartbeat=float(data["last_success_heartbeat"]),
                expires_at=data.get("expires_at"),
                username=str(data.get("username", "")),
            )
            if not record.token or not record.rsa_private_key:
                raise ValueError("incomplete credential pair")
            return record
        except FileNotFoundError:
            return None
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            self.path.unlink(missing_ok=True)
            return None

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)
        self.clear_orphans()

    def __repr__(self) -> str:
        return f"EncryptedCredentialStore(path={self.path!s}, present={self.path.exists()})"

