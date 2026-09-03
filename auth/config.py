"""固定的 NetVerify 连接配置与部署路径。

Base URL 和 App ID 来源于参考项目的 `.env`。它们是发布配置，不从环境变量
读取；环境变量只能选择本地卷、上游地址和监听参数，不能替换授权服务。
"""

from __future__ import annotations

import os
from pathlib import Path

NETVERIFY_BASE_URL = "https://yz.ledougc.com/api"
NETVERIFY_APP_ID = 96
NETVERIFY_APP_SECRET = None
APP_VERSION = "0.1.0"
AUTH_GRACE_SECONDS = 30 * 60
SESSION_COOKIE = "rsshub_session"

STORAGE_DIR = Path(os.environ.get("AUTH_STORAGE_DIR", "/var/lib/rsshub-auth"))
MASTER_KEY_FILE = Path(os.environ.get("AUTH_MASTER_KEY_FILE", "/run/secrets/auth-master-key"))
UI_UPSTREAM = os.environ.get("UI_UPSTREAM", "http://ui:3000").rstrip("/")
LISTEN_HOST = os.environ.get("AUTH_GATEWAY_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("AUTH_GATEWAY_PORT", "8080"))
SDK_DIR = Path(__file__).resolve().parent / "vendor" / "netverify-sdk" / "client"


def fixed_configuration() -> dict[str, object]:
    """Return only non-secret configuration metadata used by diagnostics."""

    return {
        "base_url": NETVERIFY_BASE_URL,
        "app_id": NETVERIFY_APP_ID,
        "app_secret": None,
    }
