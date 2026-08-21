"""이동평균선 교차 전략 (Moving Average Crossover).

단기 이동평균이 장기 이동평균을 상향 돌파하면 매수(골든크로스),
하향 돌파하면 보유 물량을 매도(데드크로스)하는 기본 전략.

각 종목의 가격 이력은 decide() 호출마다 내부에 누적되므로, 장기 이동평균
기간만큼 데이터가 쌓이기 전까지는 HOLD를 반환한다.
"""

from __future__ import annotations

from collections import deque

from bot.strategies.base import Decision, Signal, Strategy


class MovingAverageCrossStrategy(Strategy):
    def __init__(self, short_window: int = 5, long_window: int = 20, buy_quantity: int = 1):
        if short_window >= long_window:
            raise ValueError("short_window must be smaller than long_window")
        self.short_window = short_window
        self.long_window = long_window
        self.buy_quantity = buy_quantity
        self._price_history: dict[str, deque[float]] = {}
        self._prev_short_ma: dict[str, float] = {}
        self._prev_long_ma: dict[str, float] = {}

    def decide(self, stock_code: str, quote: dict, position: dict | None) -> Decision:
        price = float(quote["stck_prpr"])
        history = self._price_history.setdefault(stock_code, deque(maxlen=self.long_window))
        history.append(price)

        if len(history) < self.long_window:
            return Decision(
                signal=Signal.HOLD,
                reason=f"가격 데이터 수집 중 ({len(history)}/{self.long_window})",
            )

        short_ma = sum(list(history)[-self.short_window :]) / self.short_window
        long_ma = sum(history) / self.long_window
        prev_short_ma = self._prev_short_ma.get(stock_code)
        prev_long_ma = self._prev_long_ma.get(stock_code)
        self._prev_short_ma[stock_code] = short_ma
        self._prev_long_ma[stock_code] = long_ma

        if prev_short_ma is None or prev_long_ma is None:
            return Decision(signal=Signal.HOLD, reason="교차 판단을 위한 이전 값 없음")

        golden_cross = prev_short_ma <= prev_long_ma and short_ma > long_ma
        dead_cross = prev_short_ma >= prev_long_ma and short_ma < long_ma

        holding_qty = int(position["hldg_qty"]) if position else 0

        if golden_cross and holding_qty == 0:
            return Decision(
                signal=Signal.BUY,
                quantity=self.buy_quantity,
                reason=f"골든크로스: 단기MA({short_ma:.0f}) > 장기MA({long_ma:.0f})",
            )

        if dead_cross and holding_qty > 0:
            return Decision(
                signal=Signal.SELL,
                quantity=holding_qty,
                reason=f"데드크로스: 단기MA({short_ma:.0f}) < 장기MA({long_ma:.0f})",
            )

        return Decision(
            signal=Signal.HOLD,
            reason=f"단기MA({short_ma:.0f}) 장기MA({long_ma:.0f}) 교차 없음",
        )
