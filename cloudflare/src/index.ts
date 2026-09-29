import { DurableObject } from "cloudflare:workers";
import { accountFor, parseMode, type TradingMode } from "./mode";
import { cents, marketDate, parseMarket, usRegularHours, usSymbol, type Market } from "./market";

import {
  defaultSettings,
  type DailyUsage,
  type StrategyState,
  type TradingSettings,
  decide,
  reserveOrder,
  seoulDate,
  seoulTime,
  validateSettings,
} from "./logic";

interface Env {
  [key: string]: unknown;
  ASSETS: Fetcher;
  TRADING_STATE: DurableObjectNamespace;
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string;
  KIS_ACCOUNT_PRODUCT_CD: string;
  KIS_METADATA_APP_KEY: string;
  KIS_METADATA_APP_SECRET: string;
  TRADING_MODE: string;
  DEPLOYMENT_LOCKED: string;
}

interface RuntimeState {
  running: boolean;
  tick_in_progress?: string;
  prices: Record<string, string>;
  price_history: Record<string, Array<{ time: string; price: number }>>;
  positions: Record<string, string>;
  strategy: StrategyState;
}

interface DashboardEvent {
  time: string;
  level: "info" | "order" | "warning" | "error";
  message: string;
}

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    },
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class KisClient {
  private lastRequestAt = 0;

  constructor(
    private env: ReturnType<typeof accountFor>,
    private storage: DurableObjectStorage,
    private mode: TradingMode,
    private market: Market = "kr",
    private tokenCacheKey?: string,
  ) {}

  private async waitForSlot(): Promise<void> {
    const wait = 1_200 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await delay(wait);
    this.lastRequestAt = Date.now();
  }

  private async request(url: string, init: RequestInit, retry = true): Promise<Record<string, any>> {
    let lastError: unknown;
    const attempts = retry ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.waitForSlot();
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await delay(1_000 * 2 ** (attempt - 1));
        continue;
      }
      const body = await response.json<Record<string, any>>();
      if (response.ok) return { ...body, _tr_cont: response.headers.get("tr_cont") ?? "" };
      const error = new Error(`KIS HTTP ${response.status}: ${body.msg1 ?? response.statusText}`);
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
      if (attempt < attempts) await delay(1_000 * 2 ** (attempt - 1));
    }
    throw lastError instanceof Error ? lastError : new Error("KIS 요청에 실패했습니다.");
  }

  private async token(): Promise<string> {
    const key = this.tokenCacheKey ?? `kisToken:${this.mode}`;
    const cached = await this.storage.get<TokenState>(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const body = await this.request(`${this.env.baseUrl}/oauth2/tokenP`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: this.env.KIS_APP_KEY,
        appsecret: this.env.KIS_APP_SECRET,
      }),
    });
    const token = { accessToken: String(body.access_token), expiresAt: Date.now() + Number(body.expires_in) * 1_000 };
    await this.storage.put(key, token);
    return token.accessToken;
  }

  private async headers(transactionId: string): Promise<Record<string, string>> {
    return {
      ...JSON_HEADERS,
      authorization: `Bearer ${await this.token()}`,
      appkey: this.env.KIS_APP_KEY,
      appsecret: this.env.KIS_APP_SECRET,
      tr_id: transactionId,
      custtype: "P",
    };
  }

  private query(path: string, params: Record<string, string>): string {
    const url = new URL(path, this.env.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  async currentPrice(stockCode: string): Promise<Record<string, any>> {
    if (this.market === "us") {
      const { quoteExchange, symbol } = usSymbol(stockCode);
      const body = await this.request(this.query("/uapi/overseas-price/v1/quotations/price", { AUTH: "", EXCD: quoteExchange, SYMB: symbol }), { headers: await this.headers("HHDFS00000300") });
      if (body.rt_cd !== "0" || !Number.isFinite(Number(body.output?.last)) || Number(body.output?.last) <= 0) throw new Error(`해외 시세 조회 실패: ${body.msg1 ?? stockCode}`);
      return { stck_prpr: body.output.last };
    }
    const body = await this.request(this.query("/uapi/domestic-stock/v1/quotations/inquire-price", {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: stockCode,
    }), { headers: await this.headers("FHKST01010100") });
    if (body.rt_cd !== "0") throw new Error(`KIS API 오류: ${body.msg1}`);
    return body.output;
  }

  async stockName(stockCode: string): Promise<string> {
    const body = await this.request(this.query("/uapi/domestic-stock/v1/quotations/search-stock-info", {
      PRDT_TYPE_CD: "300",
      PDNO: stockCode,
    }), { headers: await this.headers("CTPF1002R") });
    const product = Array.isArray(body.output) ? body.output[0] : body.output;
    if (body.rt_cd !== "0" || !product) return "";
    return String(product.prdt_abrv_name || product.prdt_name || "").trim();
  }

  async balance(): Promise<{ positions: Array<Record<string, any>>; summary: Array<Record<string, any>> }> {
    if (this.market === "us") {
      const positions: Array<Record<string, any>> = [];
      for (const exchange of ["NASD", "NYSE", "AMEX"]) {
        const rows = await this.overseasPages("inquire-balance", this.mode === "real" ? "TTTS3012R" : "VTTS3012R", { OVRS_EXCG_CD: this.mode === "real" && exchange === "NASD" ? "NAS" : exchange, TR_CRCY_CD: "USD" }, "output1");
        for (const row of rows) {
          if (!row.ovrs_pdno || row.ovrs_cblc_qty === undefined || !Number.isFinite(Number(row.ovrs_cblc_qty))) throw new Error("해외 잔고 응답이 올바르지 않습니다.");
          positions.push({ ...row, pdno: `${exchange}:${row.ovrs_pdno}`, hldg_qty: row.ovrs_cblc_qty, sellable: row.ord_psbl_qty });
        }
      }
      return { positions, summary: [] };
    }
    const body = await this.request(this.query("/uapi/domestic-stock/v1/trading/inquire-balance", {
      CANO: this.env.KIS_ACCOUNT_NO,
      ACNT_PRDT_CD: this.env.KIS_ACCOUNT_PRODUCT_CD,
      AFHR_FLPR_YN: "N",
      OFL_YN: "",
      INQR_DVSN: "02",
      UNPR_DVSN: "01",
      FUND_STTL_ICLD_YN: "N",
      FNCG_AMT_AUTO_RDPT_YN: "N",
      PRCS_DVSN: "01",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    }), { headers: await this.headers(this.env.balanceId) });
    if (body.rt_cd !== "0") throw new Error(`KIS API 오류: ${body.msg1}`);
    return { positions: body.output1 ?? [], summary: body.output2 ?? [] };
  }

  private async overseasPages(path: string, trId: string, params: Record<string, string>, field: string): Promise<Array<Record<string, any>>> {
    const rows: Array<Record<string, any>> = [];
    let fk = "", nk = "", continuation = "";
    for (let page = 0; page < 20; page++) {
      const body = await this.request(this.query(`/uapi/overseas-stock/v1/trading/${path}`, { CANO: this.env.KIS_ACCOUNT_NO, ACNT_PRDT_CD: this.env.KIS_ACCOUNT_PRODUCT_CD, ...params, CTX_AREA_FK200: fk, CTX_AREA_NK200: nk }), { headers: { ...await this.headers(trId), tr_cont: continuation } });
      if (body.rt_cd !== "0") throw new Error(`해외 조회 실패: ${body.msg1}`);
      const output = body[field];
      if (output) rows.push(...(Array.isArray(output) ? output : [output]));
      if (!["M", "F"].includes(body._tr_cont)) return rows;
      const nextFk = String(body.ctx_area_fk200 ?? "").trim(), nextNk = String(body.ctx_area_nk200 ?? "").trim();
      if ((!nextFk && !nextNk) || (fk === nextFk && nk === nextNk)) throw new Error("해외 연속조회가 완료되지 않았습니다. 주문을 보류합니다.");
      fk = nextFk; nk = nextNk; continuation = "N";
    }
    throw new Error("해외 조회 페이지 한도를 초과했습니다. 주문을 보류합니다.");
  }

  async buyableQuantity(code: string, price: number): Promise<number> {
    const { exchange, symbol } = usSymbol(code);
    const body = await this.request(this.query("/uapi/overseas-stock/v1/trading/inquire-psamount", { CANO: this.env.KIS_ACCOUNT_NO, ACNT_PRDT_CD: this.env.KIS_ACCOUNT_PRODUCT_CD, OVRS_EXCG_CD: exchange, OVRS_ORD_UNPR: price.toFixed(2), ITEM_CD: symbol }), { headers: await this.headers(this.mode === "real" ? "TTTS3007R" : "VTTS3007R") });
    if (body.rt_cd !== "0") throw new Error(`해외 매수가능금액 조회 실패: ${body.msg1}`);
    const quantity = Number(body.output?.max_ord_psbl_qty);
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("해외 매수가능수량을 확인하지 못했습니다.");
    return quantity;
  }

  async todayOrders(stockCode: string, side: "buy" | "sell"): Promise<Array<Record<string, any>>> {
    if (this.market === "us") {
      const { symbol, exchange } = usSymbol(stockCode);
      const rows = await this.overseasPages("inquire-ccnl", this.mode === "real" ? "TTTS3035R" : "VTTS3035R", {
        PDNO: this.mode === "paper" ? "" : symbol,
        ORD_STRT_DT: marketDate("us", new Date(Date.now() - 7 * 86400_000)).replaceAll("-", ""), ORD_END_DT: marketDate("us").replaceAll("-", ""),
        SLL_BUY_DVSN: this.mode === "paper" ? "00" : side === "buy" ? "02" : "01",
        CCLD_NCCS_DVSN: "00", OVRS_EXCG_CD: this.mode === "paper" ? "" : exchange, SORT_SQN: "DS", ORD_DT: "", ORD_GNO_BRNO: "", ODNO: "",
      }, "output");
      return rows.filter(row => row.pdno === symbol && row.sll_buy_dvsn_cd === (side === "buy" ? "02" : "01"));
    }
    const today = seoulDate().replaceAll("-", "");
    const body = await this.request(this.query("/uapi/domestic-stock/v1/trading/inquire-daily-ccld", {
      CANO: this.env.KIS_ACCOUNT_NO,
      ACNT_PRDT_CD: this.env.KIS_ACCOUNT_PRODUCT_CD,
      INQR_STRT_DT: today,
      INQR_END_DT: today,
      SLL_BUY_DVSN_CD: side === "buy" ? "02" : "01",
      PDNO: stockCode,
      CCLD_DVSN: "00",
      INQR_DVSN: "00",
      INQR_DVSN_3: "00",
      ORD_GNO_BRNO: "",
      ODNO: "",
      INQR_DVSN_1: "",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
      EXCG_ID_DVSN_CD: "KRX",
    }), { headers: await this.headers(this.env.ordersId) });
    if (body.rt_cd !== "0") throw new Error(`KIS API 오류: ${body.msg1}`);
    return body.output1 ?? [];
  }

  private orderNumber(order: Record<string, any>): string {
    return String(order.ODNO ?? order.odno ?? "");
  }

  private async confirmOrder(
    stockCode: string,
    side: "buy" | "sell",
    prior: Set<string>,
    submitted = "",
  ): Promise<Record<string, any> | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const orders = await this.todayOrders(stockCode, side);
      const found = orders.find((order) => {
        const number = this.orderNumber(order);
        return number && (number === submitted || !prior.has(number));
      });
      if (found) return found;
      if (attempt < 3) await delay(attempt * 1_000);
    }
    return null;
  }

  async placeOrder(stockCode: string, quantity: number, side: "buy" | "sell", price = 0): Promise<{ statusVerified: boolean; filled?: boolean }> {
    if (this.market === "us") {
      const { exchange, symbol } = usSymbol(stockCode);
      if (!usRegularHours()) throw new Error("미국 정규장 주문 시간이 아닙니다.");
      if (!Number.isSafeInteger(quantity) || quantity < 1 || cents(price) < 100 || cents(price) / 100 !== price) throw new Error("미국 주문은 1달러 이상 종목의 정수 수량·센트 단위 지정가만 지원합니다.");
      // Persist before the non-idempotent POST. A timeout/restart must never silently re-submit.
      const pendingKey = `pendingOrder:${this.mode}:us`;
      if (await this.storage.get(pendingKey)) throw new Error("이전 해외 주문 내역을 먼저 확인해주세요.");
      await this.storage.put(pendingKey, { code: stockCode, side, quantity, price, time: new Date().toISOString() });
      const body = await this.request(`${this.env.baseUrl}/uapi/overseas-stock/v1/trading/order`, {
        method: "POST", headers: await this.headers(side === "buy" ? (this.mode === "real" ? "TTTT1002U" : "VTTT1002U") : (this.mode === "real" ? "TTTT1006U" : "VTTT1001U")),
        body: JSON.stringify({ CANO: this.env.KIS_ACCOUNT_NO, ACNT_PRDT_CD: this.env.KIS_ACCOUNT_PRODUCT_CD, OVRS_EXCG_CD: exchange, PDNO: symbol, ORD_QTY: String(quantity), OVRS_ORD_UNPR: price.toFixed(2), ORD_DVSN: "00", ORD_SVR_DVSN_CD: "0", SLL_TYPE: side === "sell" ? "00" : "", CTAC_TLNO: "", MGCO_APTM_ODNO: "" }),
      }, false);
      if (body.rt_cd !== "0") {
        if (body.rt_cd === "1") await this.storage.delete(pendingKey);
        throw new Error(`해외 주문 거절: ${body.msg1}`);
      }
      const number = this.orderNumber(body.output ?? {});
      if (!number) return { statusVerified: false };
      for (let attempt = 0; attempt < 3; attempt++) {
        const rows = await this.todayOrders(stockCode, side);
        const order = rows.find(row => this.orderNumber(row) === number && row.pdno === symbol && Number(row.ft_ord_qty) === quantity);
        if (order) {
          const filled = Number(order.ft_ccld_qty) === quantity;
          if (filled) await this.storage.delete(pendingKey);
          return { statusVerified: true, filled };
        }
        if (attempt < 2) await delay(1000);
      }
      return { statusVerified: false };
    }
    const priorOrders = await this.todayOrders(stockCode, side);
    const priorNumbers = new Set(priorOrders.map((order) => this.orderNumber(order)).filter(Boolean));
    const transactionId = side === "buy" ? this.env.buyId : this.env.sellId;
    let body: Record<string, any>;
    try {
      body = await this.request(`${this.env.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`, {
        method: "POST",
        headers: await this.headers(transactionId),
        body: JSON.stringify({
          CANO: this.env.KIS_ACCOUNT_NO,
          ACNT_PRDT_CD: this.env.KIS_ACCOUNT_PRODUCT_CD,
          PDNO: stockCode,
          ORD_DVSN: "01",
          ORD_QTY: String(quantity),
          ORD_UNPR: "0",
          EXCG_ID_DVSN_CD: "KRX",
        }),
      }, false);
    } catch (error) {
      const confirmed = await this.confirmOrder(stockCode, side, priorNumbers);
      if (confirmed) return { statusVerified: true };
      throw new Error("주문 응답을 확인하지 못했습니다. 재주문하지 말고 KIS 주문 내역을 확인하세요.", { cause: error });
    }
    if (body.rt_cd !== "0") throw new Error(`KIS 주문 거절: ${body.msg1}`);
    const confirmed = await this.confirmOrder(stockCode, side, priorNumbers, this.orderNumber(body.output ?? {}));
    return { statusVerified: Boolean(confirmed) };
  }
}

function freshRuntime(): RuntimeState {
  return {
    running: false,
    prices: {},
    price_history: {},
    positions: {},
    strategy: { history: {}, previousShort: {}, previousLong: {} },
  };
}

export class TradingState extends DurableObject<Env> {
  private pending: Promise<unknown> = Promise.resolve();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async mode(): Promise<TradingMode> {
    return parseMode((await this.ctx.storage.get("mode")) ?? "paper");
  }

  private async usageKey(): Promise<string> {
    const base = (await this.mode()) === "paper" ? "dailyUsage" : "dailyUsage:real";
    return await this.market() === "us" ? `${base}:us` : base;
  }
  private async market(): Promise<Market> {
    return parseMarket((await this.ctx.storage.get("market")) ?? "kr");
  }
  private async settingsKey(): Promise<string> {
    return await this.market() === "us" ? "settings:us" : "settings";
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async settings(): Promise<TradingSettings> {
    return (await this.ctx.storage.get<TradingSettings>(await this.settingsKey())) ?? defaultSettings(await this.market());
  }

  private async runtime(): Promise<RuntimeState> {
    return (await this.ctx.storage.get<RuntimeState>("runtime")) ?? freshRuntime();
  }

  private async usage(settings: TradingSettings): Promise<DailyUsage> {
    const today = marketDate(await this.market());
    const key = await this.usageKey();
    const saved = await this.ctx.storage.get<DailyUsage>(key);
    if (!saved || saved.date !== today) {
      const fresh = { date: today, order_count: 0, buy_amount: 0 };
      await this.ctx.storage.put(key, fresh);
      return fresh;
    }
    return saved;
  }

  private async events(): Promise<DashboardEvent[]> {
    return (await this.ctx.storage.get<DashboardEvent[]>("events")) ?? [];
  }

  private async addEvent(level: DashboardEvent["level"], message: string): Promise<void> {
    const events = await this.events();
    events.unshift({ time: seoulTime(), level, message });
    await this.ctx.storage.put("events", events.slice(0, 100));
  }

  private mutationAllowed(request: Request): boolean {
    return request.headers.get("X-Moa-Request") === "dashboard"
      && request.headers.get("Sec-Fetch-Site") !== "cross-site";
  }

  async fetch(request: Request): Promise<Response> {
    return this.serial(() => this.handleRequest(request));
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !this.mutationAllowed(request)) {
      return json({ error: "대시보드에서 다시 요청해주세요." }, 403);
    }
    if (url.pathname === "/api/status" && request.method === "GET") {
      const settings = await this.settings();
      const runtime = await this.runtime();
      return json({
        running: runtime.running,
        prices: runtime.prices,
        price_history: runtime.price_history,
        positions: runtime.positions,
        mode: await this.mode(),
        market: await this.market(),
        pending_order: await this.ctx.storage.get(`pendingOrder:${await this.mode()}:us`) ?? null,
        mode_ready: (() => { try { accountFor(this.env, "real"); return true; } catch { return false; } })(),
        settings,
        daily_usage: await this.usage(settings),
      });
    }
    if (url.pathname === "/api/events" && request.method === "GET") return json(await this.events());
    if (url.pathname === "/api/stock-names" && request.method === "GET") {
      if (await this.market() !== "kr") return json({ names: {}, pending: false });
      const names: Record<string, string> = {};
      const now = Date.now();
      const lookupAllowed = !(await this.runtime()).running;
      let lookedUp = false;
      let pending = false;
      for (const code of (await this.settings()).watchlist) {
        const key = `stockName:v2:${code}`;
        const cached = await this.ctx.storage.get<{ name: string; checkedAt: number }>(key);
        if (cached && now - cached.checkedAt < (cached.name ? 86_400_000 : 600_000)) {
          names[code] = cached.name;
          continue;
        }
        if (lookedUp || !lookupAllowed) { pending = true; continue; }
        lookedUp = true;
        let name = "";
        try {
          if (!this.env.KIS_METADATA_APP_KEY || !this.env.KIS_METADATA_APP_SECRET) throw new Error("종목명 조회 키가 없습니다.");
          const credentials = {
            ...accountFor(this.env, "paper"),
            KIS_APP_KEY: this.env.KIS_METADATA_APP_KEY,
            KIS_APP_SECRET: this.env.KIS_METADATA_APP_SECRET,
            baseUrl: "https://openapi.koreainvestment.com:9443",
          };
          const client = new KisClient(credentials, this.ctx.storage, "paper", "kr", "kisToken:metadata");
          name = await client.stockName(code);
        } catch { /* Name lookup must not block trading settings. */ }
        names[code] = name;
        await this.ctx.storage.put(key, { name, checkedAt: now });
      }
      return json({ names, pending });
    }
    if (url.pathname === "/api/acknowledge-order" && request.method === "POST") {
      if ((await this.runtime()).running) return json({ error: "먼저 자동매매를 중지해주세요." }, 409);
      const body = await request.json<{ confirmed?: boolean }>().catch(() => ({} as { confirmed?: boolean }));
      if (body.confirmed !== true) return json({ error: "KIS 주문 확인이 필요합니다." }, 400);
      await this.ctx.storage.delete(`pendingOrder:${await this.mode()}:us`);
      await this.addEvent("info", "사용자가 KIS 해외 주문 내역 확인을 완료했습니다. 자동매매는 중지 상태입니다.");
      return json({ ok: true });
    }
    if (url.pathname === "/api/market" && request.method === "PUT") {
      const runtime = await this.runtime();
      if (runtime.running || runtime.tick_in_progress) return json({ error: "자동매매를 중지한 뒤 시장을 변경해주세요." }, 409);
      try {
        const market = parseMarket((await request.json<{ market: unknown }>()).market);
        if (market !== await this.market()) {
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.put({ market, runtime: freshRuntime(), events: [] });
          await this.addEvent("info", `${market === "us" ? "미국주식 · USD" : "국내주식 · KRW"}으로 전환했습니다. 저장된 한도를 확인해주세요.`);
        }
        return json({ market, settings: await this.settings() });
      } catch (error) { return json({ error: (error as Error).message }, 400); }
    }
    if (url.pathname === "/api/mode" && request.method === "PUT") {
      const runtime = await this.runtime();
      if (runtime.running || runtime.tick_in_progress) return json({ error: "자동매매를 중지하고 실행이 끝난 뒤 모드를 변경해주세요." }, 409);
      try {
        const { mode: value } = await request.json<{ mode: unknown }>();
        const mode = parseMode(value);
        if (mode !== await this.mode()) {
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.put({ mode, runtime: freshRuntime(), events: [] });
          await this.addEvent("info", `${mode === "real" ? "실전" : "모의"}투자 모드로 전환했습니다. 자동매매는 중지 상태입니다.`);
        }
        return json({ mode });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "잘못된 요청입니다." }, 400);
      }
    }
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      const runtime = await this.runtime();
      if (runtime.running) return json({ error: "실행 중에는 설정을 변경할 수 없습니다." }, 409);
      try {
        const settings = validateSettings(await request.json<Record<string, unknown>>(), await this.market());
        runtime.strategy = { history: {}, previousShort: {}, previousLong: {} };
        runtime.price_history = {};
        await this.ctx.storage.put({ [await this.settingsKey()]: settings, runtime });
        return json(settings);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "설정값이 올바르지 않습니다." }, 400);
      }
    }
    if (url.pathname === "/api/start" && request.method === "POST") {
      const mode = await this.mode();
      if (await this.market() === "us" && await this.ctx.storage.get(`pendingOrder:${mode}:us`)) return json({ error: "해외 주문의 체결·취소 여부를 KIS에서 확인한 뒤 ‘주문 확인 완료’를 눌러주세요." }, 409);
      try { accountFor(this.env, mode); }
      catch (error) { return json({ error: (error as Error).message }, 400); }
      if (mode === "real") {
        const body = await request.json<{ confirm_real?: boolean }>().catch(() => ({} as { confirm_real?: boolean }));
        if (body.confirm_real !== true) return json({ error: "실제 계좌 주문을 확인한 뒤 시작해주세요." }, 403);
      }
      const runtime = await this.runtime();
      if (!runtime.running) {
        runtime.running = true;
        delete runtime.tick_in_progress;
        await this.ctx.storage.put("runtime", runtime);
        await this.ctx.storage.setAlarm(Date.now() + 250);
        await this.addEvent("info", `${mode === "real" ? "실전" : "모의"} 자동매매를 시작했습니다.`);
      }
      return this.handleRequest(new Request(new URL("/api/status", request.url), { method: "GET" }));
    }
    if (url.pathname === "/api/stop" && request.method === "POST") {
      const runtime = await this.runtime();
      runtime.running = false;
      await this.ctx.storage.put("runtime", runtime);
      await this.ctx.storage.deleteAlarm();
      delete runtime.tick_in_progress;
      await this.ctx.storage.put("runtime", runtime);
      await this.addEvent("info", "자동매매를 중지했습니다. 접수된 주문은 별도로 확인해주세요.");
      return json({ ok: true });
    }
    return json({ error: "요청한 API를 찾을 수 없습니다." }, 404);
  }

  async alarm(): Promise<void> {
    return this.serial(() => this.runAlarm());
  }

  private async runAlarm(): Promise<void> {
    let runtime = await this.runtime();
    if (!runtime.running) return;
    if (runtime.tick_in_progress) {
      runtime.running = false;
      await this.ctx.storage.put("runtime", runtime);
      await this.addEvent(
        "error",
        `이전 실행(${runtime.tick_in_progress})이 비정상 종료되어 자동매매를 중지했습니다. KIS 주문 내역을 확인한 뒤 다시 시작하세요.`,
      );
      return;
    }
    const settings = await this.settings();
    runtime.tick_in_progress = new Date().toISOString();
    await this.ctx.storage.put("runtime", runtime);
    try {
      runtime = await this.tick(runtime, settings);
      delete runtime.tick_in_progress;
      await this.ctx.storage.put("runtime", runtime);
    } catch (error) {
      delete runtime.tick_in_progress;
      await this.ctx.storage.put("runtime", runtime);
      await this.addEvent("error", `조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      const latest = await this.runtime();
      if (latest.running) await this.ctx.storage.setAlarm(Date.now() + settings.poll_interval_seconds * 1_000);
    }
  }

  private async tick(runtime: RuntimeState, settings: TradingSettings): Promise<RuntimeState> {
    const mode = await this.mode();
    const market = await this.market();
    const us = market === "us";
    if (us && !usRegularHours()) {
      runtime.strategy = { history: {}, previousShort: {}, previousLong: {} };
      await this.addEvent("info", "미국 정규장 대기 중 (뉴욕 평일 09:30~16:00). 휴장·조기폐장은 증권사에서 확인합니다.");
      return runtime;
    }
    const client = new KisClient(accountFor(this.env, mode), this.ctx.storage, mode, market);
    const balance = await client.balance();
    const positions = Object.fromEntries(balance.positions.map((position) => [String(position.pdno), position]));
    let cash = Number(balance.summary[0]?.dnca_tot_amt ?? 0);
    runtime.positions = Object.fromEntries(balance.positions.map((position) => [String(position.pdno), String(position.hldg_qty ?? "0")]));

    for (const code of settings.watchlist) {
      const quote = await client.currentPrice(code);
      const price = Number(quote.stck_prpr);
      if (!Number.isFinite(price) || price <= 0) throw new Error(`${code} 시세가 올바르지 않습니다.`);
      runtime.prices[code] = String(quote.stck_prpr);
      const history = runtime.price_history[code] ?? [];
      history.push({ time: seoulTime(), price });
      runtime.price_history[code] = history.slice(-120);
      const position = positions[code];
      const holdingQuantity = Number(position?.hldg_qty ?? 0);
      if (!Number.isSafeInteger(holdingQuantity) || holdingQuantity < 0) throw new Error(`${code} 보유수량을 확인해주세요. 소수점 주식은 지원하지 않습니다.`);
      if (us) {
        if (price < 1) { await this.addEvent("warning", `${code}: 1달러 미만 종목은 지원하지 않습니다.`); continue; }
        const orders = [...await client.todayOrders(code, "buy"), ...await client.todayOrders(code, "sell")];
        if (orders.some(order => order.nccs_qty === undefined || !Number.isFinite(Number(order.nccs_qty)))) throw new Error("해외 미체결 수량을 확인하지 못했습니다.");
        if (orders.some(order => Number(order.nccs_qty) > 0)) {
          await this.addEvent("info", `${code}: 미체결 주문이 있어 추가 주문을 보류합니다.`);
          continue;
        }
      }
      const decision = decide(code, price, holdingQuantity, settings, runtime.strategy);
      await this.addEvent("info", `${code} ${price.toLocaleString("ko-KR")}${us ? " USD" : "원"} | ${decision.reason}`);
      const limitPrice = us ? cents(price) / 100 : price;

      if (decision.signal === "buy") {
        const quantity = us ? Math.min(Math.floor(cents(settings.order_budget) / cents(limitPrice)), await client.buyableQuantity(code, limitPrice)) : Math.floor(Math.min(settings.order_budget, cash) / price);
        if (quantity < 1) {
          await this.addEvent("warning", `매수 보류: ${code} 주문 한도 또는 예수금 부족`);
          continue;
        }
        try {
          const usage = reserveOrder(await this.usage(settings), "buy", quantity * limitPrice, settings, market);
          await this.ctx.storage.put(await this.usageKey(), usage);
          const result = await client.placeOrder(code, quantity, "buy", limitPrice);
          if (!result.statusVerified) throw new Error("주문 상태가 미확인입니다. KIS 주문 내역을 확인해주세요.");
          if (us && !result.filled) throw new Error("지정가 매수 접수 확인. 미체결 또는 부분체결이므로 중지합니다. KIS에서 체결·취소를 확인해주세요.");
          cash -= quantity * price;
          await this.addEvent("order", `매수 주문: ${code} ${quantity}주 (${result.statusVerified ? "상태 확인됨" : "상태 확인 대기"})`);
        } catch (error) {
          await this.addEvent("warning", `매수 보류: ${error instanceof Error ? error.message : String(error)}`);
          runtime.running = false;
          return runtime;
        }
      } else if (decision.signal === "sell") {
        try {
          if (us && (!Number.isSafeInteger(Number(position?.sellable)) || Number(position?.sellable) < decision.quantity)) throw new Error("해외 매도가능수량이 부족하거나 확인되지 않았습니다.");
          const usage = reserveOrder(await this.usage(settings), "sell", decision.quantity * limitPrice, settings, market);
          await this.ctx.storage.put(await this.usageKey(), usage);
          const result = await client.placeOrder(code, decision.quantity, "sell", limitPrice);
          if (!result.statusVerified) throw new Error("주문 상태가 미확인입니다. KIS 주문 내역을 확인해주세요.");
          if (us && !result.filled) throw new Error("지정가 매도 접수 확인. 미체결 또는 부분체결이므로 중지합니다. KIS에서 체결·취소를 확인해주세요.");
          await this.addEvent("order", `매도 주문: ${code} ${decision.quantity}주 (${result.statusVerified ? "상태 확인됨" : "상태 확인 대기"})`);
        } catch (error) {
          await this.addEvent("warning", `매도 보류: ${error instanceof Error ? error.message : String(error)}`);
          runtime.running = false;
          return runtime;
        }
      }
    }
    return runtime;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true });
    if (env.DEPLOYMENT_LOCKED === "true") {
      return new Response("Cloudflare Access 설정을 완료한 뒤 서비스를 엽니다.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/api/")) {
      return env.TRADING_STATE.getByName("primary").fetch(request);
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("cache-control", url.pathname.includes("/static/") ? "public, max-age=3600" : "no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "same-origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
