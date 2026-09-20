import pytest

from bot.config import Config
from bot.dashboard import PaperTradingRunner, TradingSettings


def test_accepts_valid_dashboard_settings():
    settings = TradingSettings.from_dict(
        {
            "watchlist": "005930, 000660",
            "order_budget": "100000",
            "daily_buy_limit": "300000",
            "daily_order_limit": "3",
            "short_window": "5",
            "long_window": "20",
            "poll_interval_seconds": "30",
        }
    )

    assert settings.watchlist == ["005930", "000660"]
    assert settings.order_budget == 100000
    assert settings.daily_buy_limit == 300000


@pytest.mark.parametrize(
    "data",
    [
        {"watchlist": "5930"},
        {"order_budget": 999},
        {"order_budget": 100_000, "daily_buy_limit": 99_000},
        {"daily_order_limit": 0},
        {"short_window": 20, "long_window": 5},
        {"poll_interval_seconds": 4},
    ],
)
def test_rejects_invalid_dashboard_settings(data):
    with pytest.raises(ValueError):
        TradingSettings.from_dict(data)


def test_runner_status_includes_price_history():
    runner = PaperTradingRunner(
        Config("key", "secret", "12345678", "01", True),
        TradingSettings.from_dict({}),
    )

    assert runner.status()["price_history"] == {}
