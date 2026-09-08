"""Local web dashboard and paper-trading runner."""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request

from bot.config import Config, load_config
from bot.kis_client import KISClient
from bot.strategies.base import Signal
from bot.strategies.moving_average import MovingAverageCrossStrategy

logger = logging.getLogger(__name__)
SETTINGS_PATH = Path(__file__).resolve().parent.parent / "dashboard_settings.json"


@dataclass
class TradingSettings:
    watchlist: list[str]
    order_budget: int
    short_window: int
    long_window: int
    poll_interval_seconds: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TradingSettings":
        raw_codes = data.get("watchlist", ["005930"])
        if isinstance(raw_codes, str):
            raw_codes = [code.strip() for code in raw_codes.split(",")]
        watchlist = [str(code).strip() for code in raw_codes if str(code).strip()]
        if not watchlist or any(not code.isdigit() or len(code) != 6 for code in watchlist):
            raise ValueError("감시 종목은 6자리 종목코드로 입력해야 합니다.")

        settings = cls(
            watchlist=watchlist,
            order_budget=int(data.get("order_budget", 100_000)),
            short_window=int(data.get("short_window", 5)),
            long_window=int(data.get("long_window", 20)),
            poll_interval_seconds=int(data.get("poll_interval_seconds", 30)),
        )
        if settings.order_budget < 1_000:
            raise ValueError("1회 매수 한도는 1,000원 이상이어야 합니다.")
        if settings.short_window < 1 or settings.short_window >= settings.long_window:
            raise ValueError("단기 이동평균은 장기 이동평균보다 작아야 합니다.")
        if settings.poll_interval_seconds < 5:
            raise ValueError("폴링 주기는 5초 이상이어야 합니다.")
        return settings


DEFAULT_SETTINGS = TradingSettings(
    watchlist=["005930"],
    order_budget=100_000,
    short_window=5,
    long_window=20,
    poll_interval_seconds=30,
)


def load_settings() -> TradingSettings:
    if not SETTINGS_PATH.exists():
        return DEFAULT_SETTINGS
    try:
        return TradingSettings.from_dict(json.loads(SETTINGS_PATH.read_text()))
    except (OSError, ValueError, json.JSONDecodeError):
        logger.warning("Invalid dashboard settings; using defaults")
        return DEFAULT_SETTINGS


def save_settings(settings: TradingSettings) -> None:
    SETTINGS_PATH.write_text(json.dumps(asdict(settings), indent=2))


class PaperTradingRunner:
    def __init__(self, config: Config, settings: TradingSettings):
        if not config.is_paper:
            raise ValueError("웹 대시보드는 모의투자 모드에서만 실행할 수 있습니다.")
        self.config = config
        self.settings = settings
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._events: deque[dict[str, str]] = deque(maxlen=100)
        self._snapshot: dict[str, Any] = {"running": False, "prices": {}, "positions": {}}

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.running:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="paper-trading-runner", daemon=True)
        self._thread.start()
        self._event("info", "모의 자동매매를 시작했습니다.")

    def stop(self) -> None:
        self._stop_event.set()
        self._event("info", "중지 요청을 받았습니다.")

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self.running,
                "mode": "paper",
                "settings": asdict(self.settings),
                **self._snapshot,
            }

    def events(self) -> list[dict[str, str]]:
        with self._lock:
            return list(self._events)

    def _event(self, level: str, message: str) -> None:
        event = {"time": time.strftime("%H:%M:%S"), "level": level, "message": message}
        with self._lock:
            self._events.appendleft(event)

    def _run(self) -> None:
        client = KISClient(self.config)
        strategy = MovingAverageCrossStrategy(
            short_window=self.settings.short_window,
            long_window=self.settings.long_window,
        )
        try:
            while not self._stop_event.is_set():
                try:
                    balance = client.get_balance()
                    positions = {position["pdno"]: position for position in balance["positions"]}
                    cash = int(balance["summary"][0].get("dnca_tot_amt", "0")) if balance["summary"] else 0
                    prices: dict[str, str] = {}

                    for stock_code in self.settings.watchlist:
                        if self._stop_event.is_set():
                            break
                        quote = client.get_current_price(stock_code)
                        position = positions.get(stock_code)
                        decision = strategy.decide(stock_code, quote, position)
                        price = int(quote["stck_prpr"])
                        prices[stock_code] = quote["stck_prpr"]
                        self._event("info", f"{stock_code} {price:,}원 | {decision.reason}")

                        if decision.signal == Signal.BUY:
                            quantity = min(self.settings.order_budget, cash) // price
                            if quantity > 0:
                                client.place_order(stock_code, quantity, "buy")
                                cash -= quantity * price
                                self._event("order", f"매수 주문: {stock_code} {quantity}주")
                            else:
                                self._event("warning", f"매수 보류: {stock_code} 주문 한도 또는 예수금 부족")
                        elif decision.signal == Signal.SELL:
                            client.place_order(stock_code, decision.quantity, "sell")
                            self._event("order", f"매도 주문: {stock_code} {decision.quantity}주")

                    with self._lock:
                        self._snapshot = {
                            "running": True,
                            "prices": prices,
                            "positions": {
                                code: position.get("hldg_qty", "0") for code, position in positions.items()
                            },
                        }
                except Exception as error:
                    logger.exception("Dashboard trading tick failed")
                    self._event("error", f"조회 실패: {error}")

                self._stop_event.wait(self.settings.poll_interval_seconds)
        finally:
            with self._lock:
                self._snapshot["running"] = False
            self._event("info", "모의 자동매매가 중지되었습니다.")


def create_app(config: Config | None = None) -> Flask:
    app = Flask(__name__)
    config = config or load_config()
    runner: PaperTradingRunner | None = None
    settings = load_settings()

    @app.get("/")
    def index():
        return render_template("dashboard.html")

    @app.get("/api/status")
    def status():
        state = runner.status() if runner else {"running": False, "mode": "paper", "settings": asdict(settings), "prices": {}, "positions": {}}
        return jsonify(state)

    @app.get("/api/events")
    def events():
        return jsonify(runner.events() if runner else [])

    @app.put("/api/settings")
    def update_settings():
        nonlocal settings
        if runner and runner.running:
            return jsonify({"error": "실행 중에는 설정을 변경할 수 없습니다."}), 409
        try:
            settings = TradingSettings.from_dict(request.get_json(force=True))
            save_settings(settings)
        except (TypeError, ValueError) as error:
            return jsonify({"error": str(error)}), 400
        return jsonify(asdict(settings))

    @app.post("/api/start")
    def start():
        nonlocal runner
        if not config.is_paper:
            return jsonify({"error": "실전투자는 이 대시보드에서 사용할 수 없습니다."}), 403
        if runner is None or not runner.running:
            runner = PaperTradingRunner(config, settings)
            runner.start()
        return jsonify(runner.status())

    @app.post("/api/stop")
    def stop():
        if runner:
            runner.stop()
        return jsonify({"ok": True})

    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    create_app().run(host="127.0.0.1", port=5000, debug=False)
