from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum


class Signal(Enum):
    BUY = "buy"
    SELL = "sell"
    HOLD = "hold"


@dataclass(frozen=True)
class Decision:
    signal: Signal
    quantity: int = 0
    reason: str = ""


class Strategy(ABC):
    """Implement this for a real strategy. decide() is called once per tick
    per watched stock code, with the latest quote and current position info."""

    @abstractmethod
    def decide(self, stock_code: str, quote: dict, position: dict | None) -> Decision:
        ...


class DoNothingStrategy(Strategy):
    """Safe default: never trades. Swap this out once a real strategy is ready."""

    def decide(self, stock_code: str, quote: dict, position: dict | None) -> Decision:
        return Decision(signal=Signal.HOLD, reason="no strategy configured yet")
