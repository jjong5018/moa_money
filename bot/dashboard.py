"""Local web dashboard and paper-trading runner."""

from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit

from flask import Flask, jsonify, redirect, render_template, request, session, url_for

from bot.config import Config, load_config
from bot.kis_client import KISClient, OrderStatusUnknownError
from bot.safety import DailyOrderGuard, OrderLimitExceeded
from bot.storage import data_path
from bot.strategies.base import Signal
from bot.strategies.moving_average import MovingAverageCrossStrategy

logger = logging.getLogger(__name__)
SETTINGS_PATH = data_path("dashboard_settings.json")
DAILY_USAGE_PATH = data_path("daily_order_usage.json")


@dataclass
class TradingSettings:
    watchlist: list[str]
    order_budget: int
    daily_buy_limit: int
    daily_order_limit: int
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
            daily_buy_limit=int(data.get("daily_buy_limit", 300_000)),
            daily_order_limit=int(data.get("daily_order_limit", 3)),
            short_window=int(data.get("short_window", 5)),
            long_window=int(data.get("long_window", 20)),
            poll_interval_seconds=int(data.get("poll_interval_seconds", 30)),
        )
        if settings.order_budget < 1_000:
            raise ValueError("1회 매수 한도는 1,000원 이상이어야 합니다.")
        if settings.daily_buy_limit < settings.order_budget:
            raise ValueError("일일 최대 매수 금액은 1회 매수 한도 이상이어야 합니다.")
        if settings.daily_order_limit < 1:
            raise ValueError("일일 최대 주문 횟수는 1회 이상이어야 합니다.")
        if settings.short_window < 1 or settings.short_window >= settings.long_window:
            raise ValueError("단기 이동평균은 장기 이동평균보다 작아야 합니다.")
        if settings.poll_interval_seconds < 5:
            raise ValueError("폴링 주기는 5초 이상이어야 합니다.")
        return settings


DEFAULT_SETTINGS = TradingSettings(
    watchlist=["005930"],
    order_budget=100_000,
    daily_buy_limit=300_000,
    daily_order_limit=3,
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
        self._price_history: dict[str, deque[dict[str, Any]]] = {}
        self._snapshot: dict[str, Any] = {
            "running": False,
            "prices": {},
            "price_history": {},
            "positions": {},
        }
        self._daily_guard = DailyOrderGuard(
            settings.daily_buy_limit, settings.daily_order_limit, DAILY_USAGE_PATH,
        )

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
                "daily_usage": asdict(self._daily_guard.usage()),
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
                        history = self._price_history.setdefault(stock_code, deque(maxlen=120))
                        history.append({"time": time.strftime("%H:%M:%S"), "price": price})
                        self._event("info", f"{stock_code} {price:,}원 | {decision.reason}")

                        if decision.signal == Signal.BUY:
                            quantity = min(self.settings.order_budget, cash) // price
                            if quantity > 0:
                                amount = quantity * price
                                self._daily_guard.reserve("buy", amount)
                                result = client.place_order(stock_code, quantity, "buy")
                                cash -= amount
                                verification = "상태 확인됨" if result["status_verified"] else "상태 확인 대기"
                                self._event("order", f"매수 주문: {stock_code} {quantity}주 ({verification})")
                            else:
                                self._event("warning", f"매수 보류: {stock_code} 주문 한도 또는 예수금 부족")
                        elif decision.signal == Signal.SELL:
                            self._daily_guard.reserve("sell", decision.quantity * price)
                            result = client.place_order(stock_code, decision.quantity, "sell")
                            verification = "상태 확인됨" if result["status_verified"] else "상태 확인 대기"
                            self._event("order", f"매도 주문: {stock_code} {decision.quantity}주 ({verification})")

                    with self._lock:
                        self._snapshot = {
                            "running": True,
                            "prices": prices,
                            "price_history": {
                                code: list(history) for code, history in self._price_history.items()
                            },
                            "positions": {
                                code: position.get("hldg_qty", "0") for code, position in positions.items()
                            },
                        }
                except OrderStatusUnknownError as error:
                    logger.error("Order status is unknown: %s", error)
                    self._event("error", f"주문 상태 미확인: {error}")
                except OrderLimitExceeded as error:
                    logger.warning("Daily order limit reached: %s", error)
                    self._event("warning", f"주문 보류: {error}")
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
    username = os.environ.get("DASHBOARD_USERNAME", "")
    password = os.environ.get("DASHBOARD_PASSWORD", "")
    session_secret = os.environ.get("DASHBOARD_SESSION_SECRET", "")
    production = os.environ.get("MOA_ENV") == "production" or os.environ.get("RENDER") == "true"
    if production or username or password:
        if not username or len(password) < 16:
            raise ValueError("Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD (at least 16 characters).")
        if production and len(session_secret) < 32:
            raise ValueError("Set DASHBOARD_SESSION_SECRET (at least 32 characters).")

    auth_enabled = bool(username and password)
    app.secret_key = session_secret or secrets.token_hex(32)
    app.config.update(
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=production,
    )

    def is_safe_next_url(target: str) -> bool:
        parsed = urlsplit(target)
        return not parsed.scheme and not parsed.netloc and target.startswith("/") and not target.startswith("//")

    def logged_in() -> bool:
        return session.get("dashboard_user") == username

    @app.before_request
    def authenticate():
        if request.path == "/healthz" and request.method in ("GET", "HEAD"):
            return None
        if request.endpoint == "static" or request.path == "/login":
            return None
        if not auth_enabled:
            return None
        if not logged_in():
            if request.path.startswith("/api/"):
                return jsonify(error="로그인이 필요합니다."), 401
            return redirect(url_for("login", next=request.full_path.rstrip("?")))
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get("X-Moa-Request") != "dashboard" or request.headers.get("Sec-Fetch-Site") == "cross-site":
                return jsonify(error="대시보드에서 다시 요청해주세요."), 403
        return None

    @app.after_request
    def security_headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        return response

    @app.get("/healthz")
    def health():
        return jsonify(ok=True)

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if not auth_enabled:
            return redirect(url_for("index"))
        next_url = request.values.get("next", "")
        if not is_safe_next_url(next_url):
            next_url = url_for("index")
        csrf_token = session.setdefault("login_csrf", secrets.token_urlsafe(32))
        if request.method == "GET":
            if logged_in():
                return redirect(next_url)
            return render_template("login.html", csrf_token=csrf_token, next_url=next_url)

        supplied_token = request.form.get("csrf_token", "")
        if not secrets.compare_digest(supplied_token.encode(), csrf_token.encode()):
            return render_template(
                "login.html",
                csrf_token=csrf_token,
                next_url=next_url,
                error="페이지를 새로고침한 뒤 다시 시도해주세요.",
            ), 400

        supplied_username = request.form.get("username", "")
        supplied_password = request.form.get("password", "")
        valid_username = secrets.compare_digest(supplied_username.encode(), username.encode())
        valid_password = secrets.compare_digest(supplied_password.encode(), password.encode())
        if not (valid_username and valid_password):
            return render_template(
                "login.html",
                csrf_token=csrf_token,
                next_url=next_url,
                error="아이디 또는 비밀번호가 올바르지 않습니다.",
                entered_username=supplied_username,
            ), 401

        session.clear()
        session["dashboard_user"] = username
        session.permanent = True
        return redirect(next_url)

    @app.post("/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    config = config or load_config()
    runner: PaperTradingRunner | None = None
    settings = load_settings()

    @app.get("/")
    def index():
        return render_template("dashboard.html", auth_enabled=auth_enabled)

    @app.get("/api/status")
    def status():
        state = runner.status() if runner else {
            "running": False,
            "mode": "paper",
            "settings": asdict(settings),
            "daily_usage": asdict(
                DailyOrderGuard(
                    settings.daily_buy_limit, settings.daily_order_limit, DAILY_USAGE_PATH,
                ).usage()
            ),
            "prices": {},
            "price_history": {},
            "positions": {},
        }
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
