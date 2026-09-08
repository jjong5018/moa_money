import pytest

from bot.dashboard import TradingSettings


def test_accepts_valid_dashboard_settings():
    settings = TradingSettings.from_dict(
        {
            "watchlist": "005930, 000660",
            "order_budget": "100000",
            "short_window": "5",
            "long_window": "20",
            "poll_interval_seconds": "30",
        }
    )

    assert settings.watchlist == ["005930", "000660"]
    assert settings.order_budget == 100000


@pytest.mark.parametrize(
    "data",
    [
        {"watchlist": "5930"},
        {"order_budget": 999},
        {"short_window": 20, "long_window": 5},
        {"poll_interval_seconds": 4},
    ],
)
def test_rejects_invalid_dashboard_settings(data):
    with pytest.raises(ValueError):
        TradingSettings.from_dict(data)
