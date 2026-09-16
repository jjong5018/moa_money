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
from datetime import datetime
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

import requests

from bot.config import Config

logger = logging.getLogger(__name__)

TOKEN_CACHE_PATH = Path(__file__).resolve().parent.parent / ".token_cache.json"
REQUEST_INTERVAL_SECONDS = 1.2
REQUEST_TIMEOUT_SECONDS = 10
MAX_QUERY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 1.0
ORDER_STATUS_CHECK_ATTEMPTS = 3

OrderSide = Literal["buy", "sell"]


class OrderStatusUnknownError(RuntimeError):
    """Raised when an order request timed out and its final state is unknown."""


class KISClient:
    def __init__(self, config: Config):
        self.config = config
        self._session = requests.Session()
        self._access_token: str | None = None
        self._token_expires_at: float = 0.0
        self._last_request_at: float = 0.0
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

        resp = self._request_with_retries(
            "post",
            f"{self.config.base_url}/oauth2/tokenP",
            json={
                "grant_type": "client_credentials",
                "appkey": self.config.app_key,
                "appsecret": self.config.app_secret,
            },
        )
        data = resp.json()
        self._access_token = data["access_token"]
        self._token_expires_at = time.time() + int(data["expires_in"])
        self._save_cached_token()
        logger.info("Issued new KIS access token, expires in %ss", data["expires_in"])
        return self._access_token

    def _wait_for_request_slot(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < REQUEST_INTERVAL_SECONDS:
            time.sleep(REQUEST_INTERVAL_SECONDS - elapsed)
        self._last_request_at = time.monotonic()

    def _headers(self, tr_id: str) -> dict:
        return {
            "content-type": "application/json; charset=utf-8",
            "authorization": f"Bearer {self._ensure_token()}",
            "appkey": self.config.app_key,
            "appsecret": self.config.app_secret,
            "tr_id": tr_id,
        }

    def _request_with_retries(self, method: str, url: str, **kwargs) -> requests.Response:
        """Retry only idempotent KIS requests after transient transport failures."""
        last_error: requests.RequestException | None = None
        for attempt in range(1, MAX_QUERY_ATTEMPTS + 1):
            self._wait_for_request_slot()
            try:
                response = getattr(self._session, method)(
                    url,
                    timeout=REQUEST_TIMEOUT_SECONDS,
                    **kwargs,
                )
                response.raise_for_status()
                return response
            except (requests.Timeout, requests.ConnectionError) as error:
                last_error = error
            except requests.HTTPError as error:
                status_code = error.response.status_code if error.response is not None else None
                if status_code != 429 and (status_code is None or status_code < 500):
                    raise
                last_error = error

            if attempt < MAX_QUERY_ATTEMPTS:
                delay = RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
                logger.warning(
                    "KIS %s request failed (attempt %d/%d): %s; retrying in %.1fs",
                    method.upper(), attempt, MAX_QUERY_ATTEMPTS, last_error, delay,
                )
                time.sleep(delay)

        assert last_error is not None
        raise last_error

    # -- market data ------------------------------------------------------

    def get_current_price(self, stock_code: str) -> dict:
        """stock_code: 6-digit KRX code, e.g. '005930' for 삼성전자."""
        headers = self._headers("FHKST01010100")
        resp = self._request_with_retries(
            "get",
            f"{self.config.base_url}/uapi/domestic-stock/v1/quotations/inquire-price",
            headers=headers,
            params={
                "FID_COND_MRKT_DIV_CODE": "J",
                "FID_INPUT_ISCD": stock_code,
            },
        )
        body = resp.json()
        if body.get("rt_cd") != "0":
            raise RuntimeError(f"KIS API error: {body.get('msg1')}")
        return body["output"]

    # -- account ----------------------------------------------------------

    def get_balance(self) -> dict:
        tr_id = "VTTC8434R" if self.config.is_paper else "TTTC8434R"
        headers = self._headers(tr_id)
        resp = self._request_with_retries(
            "get",
            f"{self.config.base_url}/uapi/domestic-stock/v1/trading/inquire-balance",
            headers=headers,
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
        )
        body = resp.json()
        if body.get("rt_cd") != "0":
            raise RuntimeError(f"KIS API error: {body.get('msg1')}")
        return {"positions": body["output1"], "summary": body["output2"]}

    def get_today_orders(self, stock_code: str, side: OrderSide) -> list[dict]:
        """Return today's orders for one stock, used to confirm an uncertain order."""
        tr_id = "VTTC0081R" if self.config.is_paper else "TTTC0081R"
        headers = self._headers(tr_id)
        today = datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y%m%d")
        resp = self._request_with_retries(
            "get",
            f"{self.config.base_url}/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
            headers=headers,
            params={
                "CANO": self.config.account_no,
                "ACNT_PRDT_CD": self.config.account_product_cd,
                "INQR_STRT_DT": today,
                "INQR_END_DT": today,
                "SLL_BUY_DVSN_CD": "02" if side == "buy" else "01",
                "PDNO": stock_code,
                "CCLD_DVSN": "00",
                "INQR_DVSN": "00",
                "INQR_DVSN_3": "00",
                "ORD_GNO_BRNO": "",
                "ODNO": "",
                "INQR_DVSN_1": "",
                "CTX_AREA_FK100": "",
                "CTX_AREA_NK100": "",
                "EXCG_ID_DVSN_CD": "KRX",
            },
        )
        body = resp.json()
        if body.get("rt_cd") != "0":
            raise RuntimeError(f"KIS API error: {body.get('msg1')}")
        return body.get("output1", [])

    @staticmethod
    def _order_number(order: dict) -> str:
        return str(order.get("ODNO") or order.get("odno") or "")

    def _confirm_order(
        self,
        stock_code: str,
        side: OrderSide,
        prior_order_numbers: set[str],
        submitted_order_number: str = "",
    ) -> dict | None:
        """Find the submitted order without ever submitting it again."""
        for attempt in range(1, ORDER_STATUS_CHECK_ATTEMPTS + 1):
            orders = self.get_today_orders(stock_code, side)
            for order in orders:
                order_number = self._order_number(order)
                if submitted_order_number and order_number == submitted_order_number:
                    return order
                if order_number and order_number not in prior_order_numbers:
                    return order
            if attempt < ORDER_STATUS_CHECK_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
        return None

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
        # A POST can reach KIS even if its response times out.  Capture the
        # pre-existing orders, then query instead of blindly sending it again.
        prior_order_numbers = {
            self._order_number(order)
            for order in self.get_today_orders(stock_code, side)
            if self._order_number(order)
        }
        headers = self._headers(tr_id)
        try:
            self._wait_for_request_slot()
            resp = self._session.post(
                f"{self.config.base_url}/uapi/domestic-stock/v1/trading/order-cash",
                headers=headers,
                json={
                    "CANO": self.config.account_no,
                    "ACNT_PRDT_CD": self.config.account_product_cd,
                    "PDNO": stock_code,
                    "ORD_DVSN": order_division,
                    "ORD_QTY": str(quantity),
                    "ORD_UNPR": str(price),
                },
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            resp.raise_for_status()
        except (requests.Timeout, requests.ConnectionError) as error:
            confirmed = self._confirm_order(stock_code, side, prior_order_numbers)
            if confirmed:
                logger.warning("Order response timed out but order was confirmed: %s", confirmed)
                return {"order": confirmed, "status_verified": True, "recovered_after_timeout": True}
            raise OrderStatusUnknownError(
                "Order response timed out and no new order was found. Do not submit it again; "
                "check the KIS order history manually."
            ) from error

        body = resp.json()
        if body.get("rt_cd") != "0":
            raise RuntimeError(f"KIS order rejected: {body.get('msg1')}")
        output = body["output"]
        submitted_order_number = self._order_number(output)
        confirmed = self._confirm_order(
            stock_code, side, prior_order_numbers, submitted_order_number,
        )
        if confirmed is None:
            logger.warning("Order accepted but status could not be confirmed: %s", output)
            return {"order": output, "status_verified": False}
        logger.info(
            "Order placed: %s %s x%d @ %s (paper=%s) -> %s",
            side, stock_code, quantity, price or "market",
            self.config.is_paper, confirmed,
        )
        return {"order": confirmed, "status_verified": True}
