import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addStockCode, searchStocks, watchlistCodes } from "../public/static/stock-search.js";

const catalog = JSON.parse(readFileSync(new URL("../public/static/kr-stocks.json", import.meta.url), "utf8"));

test("official domestic catalog includes searchable common stocks", () => {
  assert.ok(catalog.stocks.length > 3000);
  assert.deepEqual(searchStocks(catalog.stocks, "삼성전자")[0].slice(0, 2), ["005930", "삼성전자"]);
  assert.deepEqual(searchStocks(catalog.stocks, "000660")[0].slice(0, 2), ["000660", "SK하이닉스"]);
  assert.equal(new Set(catalog.stocks.map(([code]: string[]) => code)).size, catalog.stocks.length);
});

test("selection avoids duplicates and respects the ten-stock limit", () => {
  assert.deepEqual(addStockCode("005930", "000660"), { value: "005930, 000660", error: "" });
  assert.match(addStockCode("005930", "005930").error, /이미/);
  assert.match(addStockCode(Array.from({ length: 10 }, (_, index) => String(index).padStart(6, "0")).join(", "), "005930").error, /최대 10개/);
  assert.deepEqual(watchlistCodes("005930, 000660, "), ["005930", "000660"]);
  assert.ok(searchStocks(catalog.stocks, "삼성전자", ["005930"]).every(([code]: string[]) => code !== "005930"));
});
