import { cents, usSymbol, type Market } from "./market.ts";

export interface TradingSettings {
  watchlist: string[];
  order_budget: number;
  daily_buy_limit: number;
  daily_order_limit: number;
  short_window: number;
  long_window: number;
  poll_interval_seconds: number;
}

export interface DailyUsage {
  date: string;
  order_count: number;
  buy_amount: number;
}

export interface StrategyState {
  history: Record<string, number[]>;
  previousShort: Record<string, number>;
  previousLong: Record<string, number>;
}

export interface Decision {
  signal: "buy" | "sell" | "hold";
  quantity: number;
  reason: string;
}

export const DEFAULT_SETTINGS: TradingSettings = {
  watchlist: ["005930"],
  order_budget: 100_000,
  daily_buy_limit: 300_000,
  daily_order_limit: 3,
  short_window: 5,
  long_window: 20,
  poll_interval_seconds: 30,
};

function integer(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error("설정값은 정수로 입력해야 합니다.");
  return parsed;
}

export function defaultSettings(market: Market): TradingSettings {
  return market === "us" ? { ...DEFAULT_SETTINGS, watchlist: ["NASD:AAPL"], order_budget: 300, daily_buy_limit: 900 } : DEFAULT_SETTINGS;
}

export function validateSettings(input: Record<string, unknown>, market: Market = "kr"): TradingSettings {
  const defaults = defaultSettings(market);
  const rawWatchlist = input.watchlist ?? defaults.watchlist;
  const values = Array.isArray(rawWatchlist)
    ? rawWatchlist
    : String(rawWatchlist).split(",");
  const watchlist = [...new Set(values.map((value) => String(value).trim().toUpperCase()).filter(Boolean))];
  if (market === "us") watchlist.forEach(usSymbol);
  if (!watchlist.length || (market === "kr" && watchlist.some((code) => !/^\d{6}$/.test(code)))) {
    throw new Error("감시 종목은 6자리 종목코드로 입력해야 합니다.");
  }

  if (watchlist.length > 10) throw new Error("감시 종목은 최대 10개입니다.");
  const amount = (value: unknown, fallback: number) => {
    if (market === "kr") return integer(value, fallback);
    const number = value === undefined || value === "" ? fallback : Number(value);
    if (Math.abs(cents(number) / 100 - number) > 1e-8) throw new Error("달러 금액은 소수 둘째 자리까지 입력해주세요.");
    return number;
  };
  const settings: TradingSettings = {
    watchlist,
    order_budget: amount(input.order_budget, defaults.order_budget),
    daily_buy_limit: amount(input.daily_buy_limit, defaults.daily_buy_limit),
    daily_order_limit: integer(input.daily_order_limit, DEFAULT_SETTINGS.daily_order_limit),
    short_window: integer(input.short_window, DEFAULT_SETTINGS.short_window),
    long_window: integer(input.long_window, DEFAULT_SETTINGS.long_window),
    poll_interval_seconds: integer(input.poll_interval_seconds, DEFAULT_SETTINGS.poll_interval_seconds),
  };
  if (settings.order_budget < (market === "us" ? 1 : 1_000)) throw new Error(market === "us" ? "1회 매수 한도는 1달러 이상이어야 합니다." : "1회 매수 한도는 1,000원 이상이어야 합니다.");
  if (settings.daily_buy_limit < settings.order_budget) {
    throw new Error("일일 최대 매수 금액은 1회 매수 한도 이상이어야 합니다.");
  }
  if (settings.daily_order_limit < 1) throw new Error("일일 최대 주문 횟수는 1회 이상이어야 합니다.");
  if (settings.short_window < 1 || settings.short_window >= settings.long_window) {
    throw new Error("단기 이동평균은 장기 이동평균보다 작아야 합니다.");
  }
  if (settings.poll_interval_seconds < 5) throw new Error("폴링 주기는 5초 이상이어야 합니다.");
  return settings;
}

export function decide(
  code: string,
  price: number,
  holdingQuantity: number,
  settings: TradingSettings,
  state: StrategyState,
): Decision {
  const history = [...(state.history[code] ?? []), price].slice(-settings.long_window);
  state.history[code] = history;
  if (history.length < settings.long_window) {
    return { signal: "hold", quantity: 0, reason: `가격 데이터 수집 중 (${history.length}/${settings.long_window})` };
  }

  const shortAverage = history.slice(-settings.short_window).reduce((sum, value) => sum + value, 0) / settings.short_window;
  const longAverage = history.reduce((sum, value) => sum + value, 0) / settings.long_window;
  const previousShort = state.previousShort[code];
  const previousLong = state.previousLong[code];
  state.previousShort[code] = shortAverage;
  state.previousLong[code] = longAverage;
  if (previousShort === undefined || previousLong === undefined) {
    return { signal: "hold", quantity: 0, reason: "교차 판단을 위한 이전 값 없음" };
  }

  if (previousShort <= previousLong && shortAverage > longAverage && holdingQuantity === 0) {
    return { signal: "buy", quantity: 1, reason: `골든크로스: 단기MA(${shortAverage.toFixed(0)}) > 장기MA(${longAverage.toFixed(0)})` };
  }
  if (previousShort >= previousLong && shortAverage < longAverage && holdingQuantity > 0) {
    return { signal: "sell", quantity: holdingQuantity, reason: `데드크로스: 단기MA(${shortAverage.toFixed(0)}) < 장기MA(${longAverage.toFixed(0)})` };
  }
  return { signal: "hold", quantity: 0, reason: `단기MA(${shortAverage.toFixed(0)}) 장기MA(${longAverage.toFixed(0)}) 교차 없음` };
}

export function reserveOrder(
  usage: DailyUsage,
  side: "buy" | "sell",
  amount: number,
  settings: TradingSettings,
  market: Market = "kr",
): DailyUsage {
  if (market === "us") {
    if (usage.order_count >= settings.daily_order_limit) throw new Error(`일일 주문 횟수 한도(${settings.daily_order_limit}회)에 도달했습니다.`);
    if (side === "buy" && cents(usage.buy_amount) + cents(amount) > cents(settings.daily_buy_limit)) throw new Error(`일일 매수 한도($${settings.daily_buy_limit.toFixed(2)})를 초과합니다.`);
    const reserved = reserveOrder({ ...usage, buy_amount: cents(usage.buy_amount) }, side, cents(amount), { ...settings, daily_buy_limit: cents(settings.daily_buy_limit) });
    return { ...reserved, buy_amount: reserved.buy_amount / 100 };
  }
  if (amount < 1) throw new Error("주문 금액은 1원 이상이어야 합니다.");
  if (usage.order_count >= settings.daily_order_limit) {
    throw new Error(`일일 주문 횟수 한도(${settings.daily_order_limit}회)에 도달했습니다.`);
  }
  if (side === "buy" && usage.buy_amount + amount > settings.daily_buy_limit) {
    const remaining = Math.max(settings.daily_buy_limit - usage.buy_amount, 0);
    throw new Error(`일일 매수 한도(${settings.daily_buy_limit.toLocaleString("ko-KR")}원)를 초과합니다. 남은 한도: ${remaining.toLocaleString("ko-KR")}원`);
  }
  return {
    date: usage.date,
    order_count: usage.order_count + 1,
    buy_amount: usage.buy_amount + (side === "buy" ? amount : 0),
  };
}

export function seoulDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function seoulTime(now = new Date()): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
}
