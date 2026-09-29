"""Build the domestic stock search catalog from KIS master files.

Run before deploying when the searchable stock list needs refreshing.
Source format: https://github.com/koreainvestment/open-trading-api/tree/main/stocks_info
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile


MARKETS = {"kospi": 228, "kosdaq": 222, "konex": 184}
OUTPUT = Path(__file__).resolve().parents[1] / "cloudflare/public/static/kr-stocks.json"


def stock_rows(market: str, suffix_length: int) -> list[list[str]]:
    url = f"https://new.real.download.dws.co.kr/common/master/{market}_code.mst.zip"
    with urlopen(url, timeout=20) as response:
        archive = ZipFile(BytesIO(response.read()))
    rows = archive.read(f"{market}_code.mst").decode("cp949").splitlines()
    stocks = []
    for row in rows:
        if len(row) <= 21 + suffix_length:
            continue
        code = row[:9].strip()
        name = row[21:-suffix_length].strip()
        if len(code) == 6 and code.isdigit() and name:
            stocks.append([code, name, market.upper()])
    if len(stocks) < 50:
        raise ValueError(f"Unexpectedly short {market} master file: {len(stocks)} stocks")
    return stocks


def main() -> None:
    by_code: dict[str, list[str]] = {}
    for market, suffix_length in MARKETS.items():
        for code, name, label in stock_rows(market, suffix_length):
            by_code.setdefault(code, [code, name, label])
    catalog = {
        "as_of": datetime.now(timezone.utc).date().isoformat(),
        "stocks": [by_code[code] for code in sorted(by_code)],
    }
    OUTPUT.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(catalog['stocks'])} stocks to {OUTPUT}")


if __name__ == "__main__":
    main()
