import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS, decide, reserveOrder, validateSettings } from "../src/logic.ts";

test("settings accept comma-separated stock codes", () => {
  const settings = validateSettings({ watchlist: "005930, 000660" });
  assert.deepEqual(settings.watchlist, ["005930", "000660"]);
});

test("settings reject unsafe limits", () => {
  assert.throws(() => validateSettings({ order_budget: 999 }), /1,000원/);
  assert.throws(() => validateSettings({ daily_order_limit: 0 }), /1회 이상/);
  assert.throws(() => validateSettings({ short_window: 20, long_window: 5 }), /장기 이동평균/);
});

test("daily reservation fails closed at configured limits", () => {
  const usage = { date: "2026-09-21", order_count: 0, buy_amount: 250_000 };
  assert.throws(() => reserveOrder(usage, "buy", 60_000, DEFAULT_SETTINGS), /남은 한도: 50,000원/);
  assert.deepEqual(reserveOrder(usage, "sell", 60_000, DEFAULT_SETTINGS), {
    date: "2026-09-21",
    order_count: 1,
    buy_amount: 250_000,
  });
});

test("moving-average state is persisted through the supplied state object", () => {
  const settings = validateSettings({ short_window: 2, long_window: 3 });
  const state = { history: {}, previousShort: {}, previousLong: {} };
  decide("005930", 3, 0, settings, state);
  decide("005930", 2, 0, settings, state);
  assert.equal(decide("005930", 1, 0, settings, state).signal, "hold");
  const decision = decide("005930", 5, 0, settings, state);
  assert.equal(decision.signal, "buy");
});
