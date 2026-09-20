import pytest

from bot.safety import DailyOrderGuard, OrderLimitExceeded


@pytest.fixture
def today(monkeypatch):
    monkeypatch.setattr(
        DailyOrderGuard,
        "_today",
        staticmethod(lambda: "2026-09-18"),
    )


def test_reserves_daily_buy_budget_and_persists_it(tmp_path, today):
    state_path = tmp_path / "usage.json"
    guard = DailyOrderGuard(100_000, 2, state_path)

    usage = guard.reserve("buy", 60_000)

    assert usage.order_count == 1
    assert usage.buy_amount == 60_000
    assert DailyOrderGuard(100_000, 2, state_path).usage().buy_amount == 60_000
    with pytest.raises(OrderLimitExceeded, match="일일 매수 한도"):
        guard.reserve("buy", 40_001)


def test_order_count_applies_to_buys_and_sells(tmp_path, today):
    guard = DailyOrderGuard(100_000, 2, tmp_path / "usage.json")
    guard.reserve("buy", 10_000)
    guard.reserve("sell", 10_000)

    with pytest.raises(OrderLimitExceeded, match="주문 횟수"):
        guard.reserve("sell", 10_000)


def test_usage_resets_on_next_seoul_day(tmp_path, monkeypatch):
    state_path = tmp_path / "usage.json"
    monkeypatch.setattr(DailyOrderGuard, "_today", staticmethod(lambda: "2026-09-18"))
    guard = DailyOrderGuard(100_000, 1, state_path)
    guard.reserve("buy", 50_000)
    monkeypatch.setattr(DailyOrderGuard, "_today", staticmethod(lambda: "2026-09-19"))

    assert guard.usage().order_count == 0
    assert guard.usage().buy_amount == 0
