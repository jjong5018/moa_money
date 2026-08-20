"""Thin wrapper around the Korea Investment & Securities (KIS) Open API.

Docs: https://apiportal.koreainvestment.com
Covers only what the trading bot needs: auth, quote lookup, balance lookup,
and cash order placement (buy/sell). Works against either the paper trading
domain (모의투자) or the real trading domain, selected via Config.is_paper.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Literal

import requests

from bot.config import Config

logger = logging.getLogger(__name__)

TOKEN_CACHE_PATH = Path(__file__).resolve().parent.parent / ".token_cache.json"

OrderSide = Literal["buy", "sell"]


class KISClient:
    def __init__(self, config: Config):
        self.config = config
        self._session = requests.Session()
        self._access_token: str | None = None
        self._token_expires_at: float = 0.0
        self._load_cached_token()

    # -- auth -----------------------------------------------------------

    def _load_cached_token(self) -> None:
        if not TOKEN_CACHE_PATH.exists():
            return
        try:
            cached = json.loads(TOKEN_CACHE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return
        if cached.get("base_url") != self.config.base_url:
            return
        if cached.get("expires_at", 0) > time.time() + 60:
            self._access_token = cached["access_token"]
            self._token_expires_at = cached["expires_at"]

    def _save_cached_token(self) -> None:
        TOKEN_CACHE_PATH.write_text(
            json.dumps(
                {
                    "base_url": self.config.base_url,
                    "access_token": self._access_token,
                    "expires_at": self._token_expires_at,
                }
            )
        )

    def _ensure_token(self) -> str:
        if self._access_token and time.time() < self._token_expires_at - 60:
            return self._access_token

        resp = self._session.post(
            f"{self.config.base_url}/oauth2/tokenP",
            json={
                "grant_type": "client_credentials",
                "appkey": self.config.app_key,
                "appsecret": self.config.app_secret,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_token = data["access_token"]
        self._token_expires_at = time.time() + int(data["expires_in"])
        self._save_cached_token()
        logger.info("Issued new KIS access token, expires in %ss", data["expires_in"])
        return self._access_token

    def _headers(self, tr_id: str) -> dict:
        return {
            "content-type": "application/json; charset=utf-8",
            "authorization": f"Bearer {self._ensure_token()}",
            "appkey": self.config.app_key,
            "appsecret": self.config.app_secret,
            "tr_id": tr_id,
            "custtype": "P",
        }

    # -- market data ------------------------------------------------------

    def get_current_price(self, stock_code: str) -> dict:
        """stock_code: 6-digit KRX code, e.g. '005930' for 삼성전자."""
        resp = self._session.get(
            f"{self.config.base_url}/uapi/domestic-stock/v1/quotations/inquire-price",
            headers=self._headers("FHKST01010100"),
            params={
                "FID_COND_MRKT_DIV_CODE": "J",
                "FID_INPUT_ISCD": stock_code,
            },
            timeout=10,
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("rt_cd") != "0":
            raise RuntimeError(f"KIS API error: {body.get('msg1')}")
        return body["output"]

    # -- account ----------------------------------------------------------

    def get_balance(self) -> dict:
        tr_id = "VTTC8434R" if self.config.is_paper else "TTTC8434R"
        resp = self._session.get(
            f"{self.config.base_url}/uapi/domestic-stock/v1/trading/inquire-balance",
            headers=self._headers(tr_id),
            params={
                "CANO": self.config.account_no,
                "ACNT_PRDT_CD": self.config.account_product_cd,
                "AFHR_FLPR_YN": "N",
                "OFL_YN": "",
                "INQR_DVSN": "02",
                "UNPR_DVSN": "01",
                "FUND_STTL_ICLD_YN": "N",
                "FNCG_AMT_AUTO_RDPT_YN": "N",
                "PRCS_DVSN": "01",
                "CTX_AREA_FK100": "",
                "CTX_AREA_NK100": "",
            },
            timeout=10,
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("rt_cd") != "0":
            raise RuntimeError(f"KIS API error: {body.get('msg1')}")
        return {"positions": body["output1"], "summary": body["output2"]}

    # -- orders -------------------------------------------------------------

    def place_order(
        self,
        stock_code: str,
        quantity: int,
        side: OrderSide,
        price: int = 0,
    ) -> dict:
        """price=0 places a market order (시장가); otherwise a limit order (지정가)."""
        if side == "buy":
            tr_id = "VTTC0802U" if self.config.is_paper else "TTTC0802U"
        else:
            tr_id = "VTTC0801U" if self.config.is_paper else "TTTC0801U"

        order_division = "01" if price == 0 else "00"  # 01=시장가, 00=지정가
        resp = self._session.post(
            f"{self.config.base_url}/uapi/domestic-stock/v1/trading/order-cash",
            headers=self._headers(tr_id),
            json={
                "CANO": self.config.account_no,
                "ACNT_PRDT_CD": self.config.account_product_cd,
                "PDNO": stock_code,
                "ORD_DVSN": order_division,
                "ORD_QTY": str(quantity),
                "ORD_UNPR": str(price),
            },
            timeout=10,
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("rt_cd") != "0":
            raise RuntimeError(f"KIS order rejected: {body.get('msg1')}")
        logger.info(
            "Order placed: %s %s x%d @ %s (paper=%s) -> %s",
            side, stock_code, quantity, price or "market",
            self.config.is_paper, body["output"],
        )
        return body["output"]
