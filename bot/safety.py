"""Local safety checks that must pass before the dashboard submits an order."""

from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


SEOUL = ZoneInfo("Asia/Seoul")


class OrderLimitExceeded(ValueError):
    """Raised when a proposed order would exceed a configured daily limit."""


@dataclass
class DailyOrderUsage:
    date: str
    order_count: int = 0
    buy_amount: int = 0


class DailyOrderGuard:
    """Persist and reserve the dashboard's daily order budget before submission.

    A reservation is intentionally retained even when KIS cannot confirm an
    order. This fail-closed behavior prevents a timeout from causing a later
    order to exceed the user-selected limit.
    """

    def __init__(self, daily_buy_limit: int, daily_order_limit: int, state_path: Path):
        self.daily_buy_limit = daily_buy_limit
        self.daily_order_limit = daily_order_limit
        self.state_path = state_path
        self._lock = threading.Lock()

    @staticmethod
    def _today() -> str:
        return datetime.now(SEOUL).strftime("%Y-%m-%d")

    def _load_usage(self, today: str) -> DailyOrderUsage:
        try:
            saved = json.loads(self.state_path.read_text())
            usage = DailyOrderUsage(
                date=str(saved["date"]),
                order_count=int(saved["order_count"]),
                buy_amount=int(saved["buy_amount"]),
            )
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            usage = DailyOrderUsage(date=today)
        return usage if usage.date == today else DailyOrderUsage(date=today)

    def _save_usage(self, usage: DailyOrderUsage) -> None:
        self.state_path.write_text(json.dumps(asdict(usage), indent=2))

    def usage(self) -> DailyOrderUsage:
        with self._lock:
            return self._load_usage(self._today())

    def reserve(self, side: str, amount: int) -> DailyOrderUsage:
        """Reserve one order and its buy value before calling the KIS API."""
        if side not in ("buy", "sell"):
            raise ValueError("side must be 'buy' or 'sell'")
        if amount < 1:
            raise ValueError("order amount must be positive")

        with self._lock:
            usage = self._load_usage(self._today())
            if usage.order_count >= self.daily_order_limit:
                raise OrderLimitExceeded(
                    f"일일 주문 횟수 한도({self.daily_order_limit}회)에 도달했습니다."
                )
            if side == "buy" and usage.buy_amount + amount > self.daily_buy_limit:
                remaining = self.daily_buy_limit - usage.buy_amount
                raise OrderLimitExceeded(
                    f"일일 매수 한도({self.daily_buy_limit:,}원)를 초과합니다. "
                    f"남은 한도: {max(remaining, 0):,}원"
                )

            usage.order_count += 1
            if side == "buy":
                usage.buy_amount += amount
            self._save_usage(usage)
            return usage
