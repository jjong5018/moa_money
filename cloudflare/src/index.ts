import { DurableObject } from "cloudflare:workers";

import {
  DEFAULT_SETTINGS,
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
  ASSETS: Fetcher;
  TRADING_STATE: DurableObjectNamespace;
  KIS_APP_KEY: string;
  KIS_APP_SECRET: string;
  KIS_ACCOUNT_NO: string;
  KIS_ACCOUNT_PRODUCT_CD: string;
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

const BASE_URL = "https://openapivts.koreainvestment.com:29443";
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

class KisClient {
  private lastRequestAt = 0;

  constructor(
    private env: Env,
    private storage: DurableObjectStorage,
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
      if (response.ok) return body;
      const error = new Error(`KIS HTTP ${response.status}: ${body.msg1 ?? response.statusText}`);
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
      if (attempt < attempts) await delay(1_000 * 2 ** (attempt - 1));
    }
    throw lastError instanceof Error ? lastError : new Error("KIS 요청에 실패했습니다.");
  }

  private async token(): Promise<string> {
    const cached = await this.storage.get<TokenState>("kisToken");
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const body = await this.request(`${BASE_URL}/oauth2/tokenP`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: this.env.KIS_APP_KEY,
        appsecret: this.env.KIS_APP_SECRET,
      }),
    });
    const token = { accessToken: String(body.access_token), expiresAt: Date.now() + Number(body.expires_in) * 1_000 };
    await this.storage.put("kisToken", token);
    return token.accessToken;
  }

  private async headers(transactionId: string): Promise<Record<string, string>> {
    return {
      ...JSON_HEADERS,
      authorization: `Bearer ${await this.token()}`,
      appkey: this.env.KIS_APP_KEY,
      appsecret: this.env.KIS_APP_SECRET,
      tr_id: transactionId,
    };
  }

  private query(path: string, params: Record<string, string>): string {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  async currentPrice(stockCode: string): Promise<Record<string, any>> {
    const body = await this.request(this.query("/uapi/domestic-stock/v1/quotations/inquire-price", {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: stockCode,
    }), { headers: await this.headers("FHKST01010100") });
    if (body.rt_cd !== "0") throw new Error(`KIS API 오류: ${body.msg1}`);
    return body.output;
  }

  async balance(): Promise<{ positions: Array<Record<string, any>>; summary: Array<Record<string, any>> }> {
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
    }), { headers: await this.headers("VTTC8434R") });
    if (body.rt_cd !== "0") throw new Error(`KIS API 오류: ${body.msg1}`);
    return { positions: body.output1 ?? [], summary: body.output2 ?? [] };
  }

  async todayOrders(stockCode: string, side: "buy" | "sell"): Promise<Array<Record<string, any>>> {
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
    }), { headers: await this.headers("VTTC0081R") });
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

  async placeOrder(stockCode: string, quantity: number, side: "buy" | "sell"): Promise<{ statusVerified: boolean }> {
    const priorOrders = await this.todayOrders(stockCode, side);
    const priorNumbers = new Set(priorOrders.map((order) => this.orderNumber(order)).filter(Boolean));
    const transactionId = side === "buy" ? "VTTC0802U" : "VTTC0801U";
    let body: Record<string, any>;
    try {
      body = await this.request(`${BASE_URL}/uapi/domestic-stock/v1/trading/order-cash`, {
        method: "POST",
        headers: await this.headers(transactionId),
        body: JSON.stringify({
          CANO: this.env.KIS_ACCOUNT_NO,
          ACNT_PRDT_CD: this.env.KIS_ACCOUNT_PRODUCT_CD,
          PDNO: stockCode,
          ORD_DVSN: "01",
          ORD_QTY: String(quantity),
          ORD_UNPR: "0",
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async settings(): Promise<TradingSettings> {
    return (await this.ctx.storage.get<TradingSettings>("settings")) ?? DEFAULT_SETTINGS;
  }

  private async runtime(): Promise<RuntimeState> {
    return (await this.ctx.storage.get<RuntimeState>("runtime")) ?? freshRuntime();
  }

  private async usage(settings: TradingSettings): Promise<DailyUsage> {
    const today = seoulDate();
    const saved = await this.ctx.storage.get<DailyUsage>("dailyUsage");
    if (!saved || saved.date !== today) {
      const fresh = { date: today, order_count: 0, buy_amount: 0 };
      await this.ctx.storage.put("dailyUsage", fresh);
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
        mode: "paper",
        settings,
        daily_usage: await this.usage(settings),
      });
    }
    if (url.pathname === "/api/events" && request.method === "GET") return json(await this.events());
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      const runtime = await this.runtime();
      if (runtime.running) return json({ error: "실행 중에는 설정을 변경할 수 없습니다." }, 409);
      try {
        const settings = validateSettings(await request.json<Record<string, unknown>>());
        runtime.strategy = { history: {}, previousShort: {}, previousLong: {} };
        runtime.price_history = {};
        await this.ctx.storage.put({ settings, runtime });
        return json(settings);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "설정값이 올바르지 않습니다." }, 400);
      }
    }
    if (url.pathname === "/api/start" && request.method === "POST") {
      if (this.env.TRADING_MODE !== "paper") return json({ error: "Cloudflare 배포는 모의투자만 지원합니다." }, 403);
      const runtime = await this.runtime();
      if (!runtime.running) {
        runtime.running = true;
        delete runtime.tick_in_progress;
        await this.ctx.storage.put("runtime", runtime);
        await this.ctx.storage.setAlarm(Date.now() + 250);
        await this.addEvent("info", "모의 자동매매를 시작했습니다.");
      }
      return this.fetch(new Request(new URL("/api/status", request.url), { method: "GET" }));
    }
    if (url.pathname === "/api/stop" && request.method === "POST") {
      const runtime = await this.runtime();
      runtime.running = false;
      await this.ctx.storage.put("runtime", runtime);
      await this.ctx.storage.deleteAlarm();
      await this.addEvent("info", "모의 자동매매를 중지했습니다.");
      return json({ ok: true });
    }
    return json({ error: "요청한 API를 찾을 수 없습니다." }, 404);
  }

  async alarm(): Promise<void> {
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
    const client = new KisClient(this.env, this.ctx.storage);
    const balance = await client.balance();
    const positions = Object.fromEntries(balance.positions.map((position) => [String(position.pdno), position]));
    let cash = Number(balance.summary[0]?.dnca_tot_amt ?? 0);
    runtime.positions = Object.fromEntries(balance.positions.map((position) => [String(position.pdno), String(position.hldg_qty ?? "0")]));

    for (const code of settings.watchlist) {
      const quote = await client.currentPrice(code);
      const price = Number(quote.stck_prpr);
      runtime.prices[code] = String(quote.stck_prpr);
      const history = runtime.price_history[code] ?? [];
      history.push({ time: seoulTime(), price });
      runtime.price_history[code] = history.slice(-120);
      const position = positions[code];
      const holdingQuantity = Number(position?.hldg_qty ?? 0);
      const decision = decide(code, price, holdingQuantity, settings, runtime.strategy);
      await this.addEvent("info", `${code} ${price.toLocaleString("ko-KR")}원 | ${decision.reason}`);

      if (decision.signal === "buy") {
        const quantity = Math.floor(Math.min(settings.order_budget, cash) / price);
        if (quantity < 1) {
          await this.addEvent("warning", `매수 보류: ${code} 주문 한도 또는 예수금 부족`);
          continue;
        }
        try {
          const usage = reserveOrder(await this.usage(settings), "buy", quantity * price, settings);
          await this.ctx.storage.put("dailyUsage", usage);
          const result = await client.placeOrder(code, quantity, "buy");
          cash -= quantity * price;
          await this.addEvent("order", `매수 주문: ${code} ${quantity}주 (${result.statusVerified ? "상태 확인됨" : "상태 확인 대기"})`);
        } catch (error) {
          await this.addEvent("warning", `매수 보류: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (decision.signal === "sell") {
        try {
          const usage = reserveOrder(await this.usage(settings), "sell", decision.quantity * price, settings);
          await this.ctx.storage.put("dailyUsage", usage);
          const result = await client.placeOrder(code, decision.quantity, "sell");
          await this.addEvent("order", `매도 주문: ${code} ${decision.quantity}주 (${result.statusVerified ? "상태 확인됨" : "상태 확인 대기"})`);
        } catch (error) {
          await this.addEvent("warning", `매도 보류: ${error instanceof Error ? error.message : String(error)}`);
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
