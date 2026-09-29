import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { accountFor } from "../src/mode.ts";
import { defaultSettings, validateSettings, reserveOrder } from "../src/logic.ts";
import { marketDate, usRegularHours, usSymbol } from "../src/market.ts";

const env = {
  KIS_APP_KEY: "paper-key", KIS_APP_SECRET: "paper-secret", KIS_ACCOUNT_NO: "11111111", KIS_ACCOUNT_PRODUCT_CD: "01",
  KIS_REAL_APP_KEY: "real-key", KIS_REAL_APP_SECRET: "real-secret", KIS_REAL_ACCOUNT_NO: "22222222", KIS_REAL_ACCOUNT_PRODUCT_CD: "02",
  KIS_METADATA_APP_KEY: "metadata-key", KIS_METADATA_APP_SECRET: "metadata-secret",
};
const bundle = await build({
  entryPoints: ["cloudflare/src/index.ts"], bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "fake-runtime", setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "runtime", namespace: "fake" }));
    builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }" }));
  } }],
});
const { TradingState, KisClient } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
function fixture(values = env) {
  const data = new Map();
  const storage = {
    async get(key) { return structuredClone(data.get(key)); },
    async delete(key) { return data.delete(key); },
    async put(key, value) { if (typeof key === "string") data.set(key, structuredClone(value)); else for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v)); },
    async setAlarm() {}, async deleteAlarm() {},
  };
  const object = new TradingState({ storage }, values);
  const call = async (path, method = "GET", body?) => object.fetch(new Request(`https://test/api/${path}`, {
    method, headers: { "X-Moa-Request": "dashboard", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { call, data, storage, object };
}
test("real credentials never fall back to paper; routes and accounts differ", () => {
  const paper = accountFor(env, "paper");
  const real = accountFor(env, "real");
  assert.notEqual(paper.baseUrl, real.baseUrl);
  assert.equal(real.KIS_ACCOUNT_NO, "22222222");
  assert.equal(real.buyId, "TTTC0012U");
  assert.equal(paper.buyId, "VTTC0012U");
  assert.throws(() => accountFor({ ...env, KIS_REAL_ACCOUNT_NO: "" }, "real"));
});

test("US settings validate exchange symbols and cent amounts; daily budgets have no floating point drift", () => {
  const settings = validateSettings({ watchlist: "nasd:aapl, NYSE:IBM, AMEX:SPY, nasd:aapl", order_budget: 1.01, daily_buy_limit: 3.03 }, "us");
  assert.deepEqual(settings.watchlist, ["NASD:AAPL", "NYSE:IBM", "AMEX:SPY"]);
  assert.equal(usSymbol("AMEX:SPY").quoteExchange, "AMS");
  for (const watchlist of ["AAPL", "005930", "SEHK:0700", "NASD:<script>"]) assert.throws(() => validateSettings({ watchlist }, "us"));
  for (const order_budget of [NaN, Infinity, -1, 1.001]) assert.throws(() => validateSettings({ order_budget }, "us"));
  let usage = { date: "2026-09-23", buy_amount: 0, order_count: 0 };
  for (let i = 0; i < 3; i++) usage = reserveOrder(usage, "buy", 1.01, settings, "us");
  assert.equal(usage.buy_amount, 3.03);
  assert.throws(() => reserveOrder({ ...usage, order_count: 0 }, "buy", 0.01, settings, "us"), /\$/);
});

test("US session and accounting dates follow New York including DST", () => {
  assert.equal(usRegularHours(new Date("2026-07-06T13:29:00Z")), false);
  assert.equal(usRegularHours(new Date("2026-07-06T13:30:00Z")), true);
  assert.equal(usRegularHours(new Date("2026-01-05T14:30:00Z")), true);
  assert.equal(usRegularHours(new Date("2026-07-06T20:00:00Z")), false);
  assert.equal(usRegularHours(new Date("2026-07-05T15:00:00Z")), false);
  assert.equal(marketDate("us", new Date("2026-09-23T02:00:00Z")), "2026-09-22");
});

test("market switches preserve settings/usage and block during trading; pending orders survive switches", async () => {
  const { call, data } = fixture();
  await call("settings", "PUT", { watchlist: "000660" });
  data.set("dailyUsage", { date: marketDate("kr"), order_count: 2, buy_amount: 2000 });
  assert.equal((await call("market", "PUT", { market: "us" })).status, 200);
  const us = await (await call("status")).json();
  assert.equal(us.settings.order_budget, 300);
  assert.equal(us.daily_usage.order_count, 0);
  await call("settings", "PUT", { watchlist: "NYSE:IBM", order_budget: 10.25 });
  await call("start", "POST");
  assert.equal((await call("market", "PUT", { market: "kr" })).status, 409);
  await call("stop", "POST");
  data.set("pendingOrder:paper:us", { code: "NYSE:IBM" });
  assert.equal((await call("start", "POST")).status, 409);
  await call("market", "PUT", { market: "kr" });
  const kr = await (await call("status")).json();
  assert.deepEqual(kr.settings.watchlist, ["000660"]);
  assert.equal(kr.daily_usage.order_count, 2);
  await call("market", "PUT", { market: "us" });
  assert.equal((await (await call("status")).json()).settings.order_budget, 10.25);
  assert.equal((await call("acknowledge-order", "POST", {})).status, 400);
  await call("acknowledge-order", "POST", { confirmed: true });
  assert.equal((await (await call("status")).json()).running, false);
  assert.equal(data.has("pendingOrder:paper:us"), false);
});

function fakeClient(t, mode = "paper") {
  const fixtureData = fixture();
  fixtureData.data.set(`kisToken:${mode}`, { accessToken: "fake-token", expiresAt: Date.now() + 86400_000 });
  const client = new KisClient(accountFor(env, mode), fixtureData.storage, mode, "us");
  client.waitForSlot = async () => {};
  const requests = [];
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: new URL(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    assert.ok(replies.length, "unexpected network request");
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return Response.json({ rt_cd: "0", ...reply.body }, { headers: reply.headers });
  });
  return { client, requests, replies, ...fixtureData };
}

test("domestic watchlist names come from KIS and are cached without changing saved codes", async t => {
  const { call, data } = fixture();
  data.set("kisToken:metadata", { accessToken: "fake-token", expiresAt: Date.now() + 86400_000 });
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async url => {
    const request = new URL(url);
    assert.equal(request.origin, "https://openapi.koreainvestment.com:9443");
    assert.equal(request.pathname, "/uapi/domestic-stock/v1/quotations/search-stock-info");
    assert.equal(request.searchParams.get("PRDT_TYPE_CD"), "300");
    assert.equal(request.searchParams.get("PDNO"), "005930");
    lookups += 1;
    return Response.json({ rt_cd: "0", output: { pdno: "005930", prdt_abrv_name: "삼성전자" } });
  });
  const first = await (await call("stock-names")).json();
  const second = await (await call("stock-names")).json();
  assert.deepEqual(first, { names: { "005930": "삼성전자" }, pending: false });
  assert.deepEqual(second, first);
  assert.equal(lookups, 1);
  assert.deepEqual((await (await call("status")).json()).settings.watchlist, ["005930"]);
});

test("name lookup processes one uncached code per request and survives lookup errors", async t => {
  const { call, data } = fixture();
  data.set("kisToken:metadata", { accessToken: "fake-token", expiresAt: Date.now() + 86400_000 });
  await call("settings", "PUT", { watchlist: "005930, 000660" });
  t.mock.method(globalThis, "fetch", async url => {
    const code = new URL(url).searchParams.get("PDNO");
    if (code === "005930") return Response.json({ msg1: "temporarily unavailable" }, { status: 400 });
    return Response.json({ rt_cd: "0", output: { pdno: code, prdt_name: "SK하이닉스" } });
  });
  const first = await (await call("stock-names")).json();
  assert.deepEqual(first, { names: { "005930": "" }, pending: true });
  const second = await (await call("stock-names")).json();
  assert.deepEqual(second, { names: { "005930": "", "000660": "SK하이닉스" }, pending: false });
});

test("name lookup waits while automatic trading is running", async t => {
  const { call, data } = fixture();
  data.set("runtime", { running: true });
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async () => { lookups += 1; throw new Error("unexpected lookup"); });
  assert.deepEqual(await (await call("stock-names")).json(), { names: {}, pending: true });
  assert.equal(lookups, 0);
});

test("US quotes, buying power and paginated balances use correct exchanges and paper TR IDs", async t => {
  const { client, requests, replies } = fakeClient(t);
  replies.push({ body: { output: { last: "201.23" } } });
  assert.equal((await client.currentPrice("NYSE:IBM")).stck_prpr, "201.23");
  assert.equal(requests[0].url.searchParams.get("EXCD"), "NYS");
  assert.equal(requests[0].headers.tr_id, "HHDFS00000300");
  replies.push({ body: { output: { max_ord_psbl_qty: "2" } } });
  assert.equal(await client.buyableQuantity("NASD:AAPL", 201.23), 2);
  assert.equal(requests[1].headers.tr_id, "VTTS3007R");
  assert.equal(requests[1].url.searchParams.get("OVRS_ORD_UNPR"), "201.23");
  replies.push(
    { body: { output1: [{ ovrs_pdno: "AAPL", ovrs_cblc_qty: "1", ord_psbl_qty: "1" }], ctx_area_fk200: "first", ctx_area_nk200: "next" }, headers: { tr_cont: "M" } },
    { body: { output1: [{ ovrs_pdno: "MSFT", ovrs_cblc_qty: "2", ord_psbl_qty: "2" }] } },
    { body: { output1: [] } }, { body: { output1: [] } },
  );
  const result = await client.balance();
  assert.deepEqual(result.positions.map(p => p.pdno), ["NASD:AAPL", "NASD:MSFT"]);
  assert.equal(requests[2].headers.tr_id, "VTTS3012R");
  assert.equal(requests[3].headers.tr_cont, "N");
  assert.equal(requests[3].url.searchParams.get("CTX_AREA_NK200"), "next");
  replies.push({ body: { output1: [], ctx_area_nk200: "" }, headers: { tr_cont: "M" } });
  await assert.rejects(() => client.balance(), /연속조회/);
});

for (const mode of ["paper", "real"]) for (const side of ["buy", "sell"]) {
  test(`${mode} US ${side} is a limit order and confirms exact order ID, symbol and quantity`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T15:00:00Z") });
    const { client, requests, replies, data } = fakeClient(t, mode);
    replies.push({ body: { output: { ODNO: "123" } } }, { body: { output: [
      { odno: "123", pdno: "AAPL", sll_buy_dvsn_cd: side === "buy" ? "02" : "01", ft_ord_qty: "2", ft_ccld_qty: "2", nccs_qty: "0" },
      { odno: "other", pdno: "IBM", sll_buy_dvsn_cd: "02", ft_ord_qty: "2", ft_ccld_qty: "2", nccs_qty: "0" },
    ] } });
    assert.deepEqual(await client.placeOrder("NASD:AAPL", 2, side, 201.23), { statusVerified: true, filled: true });
    assert.equal(requests[0].headers.tr_id, side === "buy" ? (mode === "real" ? "TTTT1002U" : "VTTT1002U") : (mode === "real" ? "TTTT1006U" : "VTTT1001U"));
    assert.equal(requests[0].body.ORD_DVSN, "00");
    assert.equal(requests[0].body.OVRS_ORD_UNPR, "201.23");
    assert.equal(requests[0].body.CANO, mode === "paper" ? "11111111" : "22222222");
    assert.equal(requests[1].url.searchParams.get("PDNO"), mode === "paper" ? "" : "AAPL");
    assert.equal(requests[1].url.searchParams.get("SLL_BUY_DVSN"), mode === "paper" ? "00" : side === "buy" ? "02" : "01");
    assert.equal(data.has(`pendingOrder:${mode}:us`), false);
  });
}

test("US uncertain POST is never retried and blocks another submission; partial fill stays pending", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T15:00:00Z") });
  const { client, replies, requests, data } = fakeClient(t);
  replies.push(new Error("timeout"));
  await assert.rejects(() => client.placeOrder("NASD:AAPL", 2, "buy", 200), /timeout/);
  await assert.rejects(() => client.placeOrder("NASD:AAPL", 2, "buy", 200), /이전 해외 주문/);
  assert.equal(requests.length, 1);
  assert.ok(data.has("pendingOrder:paper:us"));
  data.delete("pendingOrder:paper:us");
  replies.push({ body: { output: { ODNO: "123" } } }, { body: { output: [{ odno: "123", pdno: "AAPL", sll_buy_dvsn_cd: "02", ft_ord_qty: "2", ft_ccld_qty: "1", nccs_qty: "1" }] } });
  assert.deepEqual(await client.placeOrder("NASD:AAPL", 2, "buy", 200), { statusVerified: true, filled: false });
  assert.ok(data.has("pendingOrder:paper:us"));
});

test("US strategy tick reserves USD once, caps shares to buying power and stops on partial fill", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T15:00:00Z") });
  t.mock.method(KisClient.prototype, "waitForSlot", async () => {});
  const { object, data, replies, requests } = fakeClient(t);
  data.set("market", "us");
  const runtime = { running: true, prices: {}, price_history: {}, positions: {}, strategy: { history: { "NASD:AAPL": [3, 2, 1] }, previousShort: { "NASD:AAPL": 1.5 }, previousLong: { "NASD:AAPL": 2 } } };
  replies.push(
    { body: { output1: [] } }, { body: { output1: [] } }, { body: { output1: [] } },
    { body: { output: { last: "4.00" } } },
    { body: { output: [] } }, { body: { output: [] } },
    { body: { output: { max_ord_psbl_qty: "2" } } },
    { body: { output: { ODNO: "123" } } },
    { body: { output: [{ odno: "123", pdno: "AAPL", sll_buy_dvsn_cd: "02", ft_ord_qty: "2", ft_ccld_qty: "1", nccs_qty: "1" }] } },
  );
  const result = await object.tick(runtime, { ...defaultSettings("us"), short_window: 2, long_window: 3 });
  assert.equal(result.running, false);
  assert.equal(data.get("dailyUsage:us").buy_amount, 8);
  assert.equal(data.get("dailyUsage:us").order_count, 1);
  assert.equal(requests.filter(r => r.body).length, 1);
  assert.equal(requests.find(r => r.body).body.ORD_QTY, "2");
  assert.ok(data.has("pendingOrder:paper:us"));
});

test("US tick does not order against open orders or outside regular hours", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-23T15:00:00Z") });
  t.mock.method(KisClient.prototype, "waitForSlot", async () => {});
  const { object, data, replies, requests } = fakeClient(t);
  data.set("market", "us");
  const runtime = { running: true, prices: {}, price_history: {}, positions: {}, strategy: { history: { "NASD:AAPL": [3, 2, 1] }, previousShort: { "NASD:AAPL": 1.5 }, previousLong: { "NASD:AAPL": 2 } } };
  replies.push({ body: { output1: [] } }, { body: { output1: [] } }, { body: { output1: [] } }, { body: { output: { last: "4" } } }, { body: { output: [{ pdno: "AAPL", sll_buy_dvsn_cd: "02", nccs_qty: "1" }] } }, { body: { output: [] } });
  await object.tick(runtime, { ...defaultSettings("us"), short_window: 2, long_window: 3 });
  assert.equal(requests.some(r => r.body), false);
  const count = requests.length;
  t.mock.timers.setTime(new Date("2026-09-23T21:00:00Z").getTime());
  await object.tick(runtime, defaultSettings("us"));
  assert.equal(requests.length, count);
  assert.deepEqual(runtime.strategy.history, {});
});
test("mode switching clears stale portfolio and preserves daily limits across round trips", async () => {
  const { call, data } = fixture();
  data.set("dailyUsage", { date: "2000-01-01", order_count: 3, buy_amount: 100 });
  assert.equal((await call("mode", "PUT", { mode: "real" })).status, 200);
  const status = await (await call("status")).json();
  assert.equal(status.mode, "real");
  assert.equal(status.running, false);
  assert.deepEqual(status.positions, {});
  await call("mode", "PUT", { mode: "paper" });
  assert.equal(data.get("dailyUsage").order_count, 3);
  assert.equal((await call("mode", "PUT", { mode: "bad" })).status, 400);
});
test("real start requires credentials and explicit confirmation; running blocks mode switch", async () => {
  const { call } = fixture();
  await call("mode", "PUT", { mode: "real" });
  assert.equal((await call("start", "POST", {})).status, 403);
  assert.equal((await call("start", "POST", { confirm_real: true })).status, 200);
  assert.equal((await call("mode", "PUT", { mode: "paper" })).status, 409);
  await call("stop", "POST");
  assert.equal((await call("mode", "PUT", { mode: "paper" })).status, 200);
  const missing = fixture({ ...env, KIS_REAL_APP_KEY: "" });
  await missing.call("mode", "PUT", { mode: "real" });
  assert.equal((await missing.call("start", "POST", { confirm_real: true })).status, 400);
});
