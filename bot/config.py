import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    app_key: str
    app_secret: str
    account_no: str
    account_product_cd: str
    is_paper: bool

    @property
    def base_url(self) -> str:
        return (
            "https://openapivts.koreainvestment.com:29443"
            if self.is_paper
            else "https://openapi.koreainvestment.com:9443"
        )


def load_config() -> Config:
    mode = os.environ.get("TRADING_MODE", "paper").strip().lower()
    if mode not in ("paper", "real"):
        raise ValueError(f"TRADING_MODE must be 'paper' or 'real', got: {mode!r}")

    app_key = os.environ.get("KIS_APP_KEY", "")
    app_secret = os.environ.get("KIS_APP_SECRET", "")
    account_no = os.environ.get("KIS_ACCOUNT_NO", "")
    account_product_cd = os.environ.get("KIS_ACCOUNT_PRODUCT_CD", "01")

    missing = [
        name
        for name, value in (
            ("KIS_APP_KEY", app_key),
            ("KIS_APP_SECRET", app_secret),
            ("KIS_ACCOUNT_NO", account_no),
        )
        if not value
    ]
    if missing:
        raise ValueError(
            f"Missing required environment variables: {', '.join(missing)}. "
            "Copy .env.example to .env and fill in your KIS Developers credentials."
        )

    return Config(
        app_key=app_key,
        app_secret=app_secret,
        account_no=account_no,
        account_product_cd=account_product_cd,
        is_paper=(mode == "paper"),
    )
