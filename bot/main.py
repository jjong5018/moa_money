"""Trading bot entrypoint.

Runs a poll loop: for each watched stock, fetch a quote, ask the strategy for
a decision, and act on it. Ships with DoNothingStrategy so the loop is safe
to run as-is -- swap in a real Strategy once one exists.
"""

import logging
import time

from bot.config import load_config
from bot.kis_client import KISClient
from bot.strategies.base import DoNothingStrategy, Signal, Strategy

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("bot.main")

# 6-digit KRX codes to watch, e.g. 삼성전자.
WATCHLIST = ["005930"]

POLL_INTERVAL_SECONDS = 30


def run(strategy: Strategy, watchlist: list[str] = WATCHLIST) -> None:
    config = load_config()
    client = KISClient(config)
    logger.info("Starting bot in %s mode, watching %s", "PAPER" if config.is_paper else "REAL", watchlist)

    while True:
        try:
            balance = client.get_balance()
            positions_by_code = {p["pdno"]: p for p in balance["positions"]}

            for stock_code in watchlist:
                quote = client.get_current_price(stock_code)
                position = positions_by_code.get(stock_code)
                decision = strategy.decide(stock_code, quote, position)

                logger.info(
                    "%s price=%s signal=%s reason=%s",
                    stock_code, quote.get("stck_prpr"), decision.signal.value, decision.reason,
                )

                if decision.signal == Signal.BUY:
                    client.place_order(stock_code, decision.quantity, "buy")
                elif decision.signal == Signal.SELL:
                    client.place_order(stock_code, decision.quantity, "sell")

        except Exception:
            logger.exception("Error during trading loop tick; will retry next interval")

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    run(strategy=DoNothingStrategy())
