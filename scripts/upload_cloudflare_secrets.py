"""Upload only the required KIS paper-trading values from .env to Wrangler."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from dotenv import dotenv_values


SECRET_NAMES = ("KIS_APP_KEY", "KIS_APP_SECRET", "KIS_ACCOUNT_NO")


def main() -> None:
    values = dotenv_values(Path(__file__).resolve().parent.parent / ".env")
    if values.get("TRADING_MODE", "paper").strip().lower() != "paper":
        raise SystemExit("TRADING_MODE must be paper before uploading Cloudflare secrets.")
    secrets = {name: values.get(name, "") for name in SECRET_NAMES}
    missing = [name for name, value in secrets.items() if not value]
    if missing:
        raise SystemExit(f"Missing .env values: {', '.join(missing)}")

    descriptor, path = tempfile.mkstemp(prefix="moa-cloudflare-secrets-", suffix=".json")
    try:
        os.chmod(path, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(secrets, handle)
        subprocess.run(["npx", "wrangler", "secret", "bulk", path], check=True)
    finally:
        Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
