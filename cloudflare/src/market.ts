export type Market = "kr" | "us";
export function parseMarket(value: unknown): Market {
  if (value !== "kr" && value !== "us") throw new Error("국내 또는 미국 시장을 선택해주세요.");
  return value;
}
export function usSymbol(code: string) {
  const match = /^(NASD|NYSE|AMEX):([A-Z][A-Z0-9.\-]{0,14})$/.exec(code);
  if (!match) throw new Error("미국 종목은 NASD:AAPL, NYSE:IBM, AMEX:SPY 형식으로 입력해주세요.");
  const exchange = match[1];
  return { exchange, symbol: match[2], quoteExchange: ({ NASD: "NAS", NYSE: "NYS", AMEX: "AMS" } as Record<string, string>)[exchange] };
}
export function marketDate(market: Market, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: market === "us" ? "America/New_York" : "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
// The broker still validates holidays and early closes. No extended-hours orders.
export function usRegularHours(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  return !["Sat", "Sun"].includes(part("weekday")) && minutes >= 570 && minutes < 960;
}
export function cents(value: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100))) throw new Error("달러 금액이 올바르지 않습니다.");
  return Math.round(value * 100);
}
