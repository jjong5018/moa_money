from bot.strategies.base import Signal
from bot.strategies.moving_average import MovingAverageCrossStrategy


def feed(strategy, prices, stock_code="005930", position=None):
    decisions = []
    for price in prices:
        decisions.append(strategy.decide(stock_code, {"stck_prpr": str(price)}, position))
    return decisions


def test_holds_while_collecting_history():
    strategy = MovingAverageCrossStrategy(short_window=2, long_window=4)
    decisions = feed(strategy, [100, 100, 100])
    assert all(d.signal == Signal.HOLD for d in decisions)


def test_buys_on_golden_cross_when_flat():
    strategy = MovingAverageCrossStrategy(short_window=2, long_window=4, buy_quantity=3)
    # 장기 이력을 만든 뒤 급등시켜 단기 이평선이 장기 이평선을 상향 돌파하게 함
    decisions = feed(strategy, [100, 100, 100, 100, 130])
    assert decisions[-1].signal == Signal.BUY
    assert decisions[-1].quantity == 3


def test_holds_on_golden_cross_when_already_holding():
    strategy = MovingAverageCrossStrategy(short_window=2, long_window=4)
    position = {"hldg_qty": "5"}
    decisions = feed(strategy, [100, 100, 100, 100, 130], position=position)
    assert decisions[-1].signal == Signal.HOLD


def test_sells_on_dead_cross_when_holding():
    strategy = MovingAverageCrossStrategy(short_window=2, long_window=4)
    position = {"hldg_qty": "5"}
    decisions = feed(strategy, [130, 130, 130, 130, 100], position=position)
    assert decisions[-1].signal == Signal.SELL
    assert decisions[-1].quantity == 5


def test_no_signal_without_cross():
    strategy = MovingAverageCrossStrategy(short_window=2, long_window=4)
    decisions = feed(strategy, [100, 101, 100, 101, 100, 101])
    assert all(d.signal == Signal.HOLD for d in decisions)


def test_rejects_invalid_windows():
    try:
        MovingAverageCrossStrategy(short_window=10, long_window=5)
    except ValueError:
        return
    raise AssertionError("expected ValueError for short_window >= long_window")
