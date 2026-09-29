export type TradingMode = "paper" | "real";

export function parseMode(value: unknown): TradingMode {
  if (value !== "paper" && value !== "real") throw new Error("투자 모드를 선택해주세요.");
  return value;
}

export function accountFor(env: Record<string, unknown>, mode: TradingMode) {
  const prefix = mode === "real" ? "KIS_REAL_" : "KIS_";
  const names = ["APP_KEY", "APP_SECRET", "ACCOUNT_NO", "ACCOUNT_PRODUCT_CD"];
  const values = names.map(name => String(env[prefix + name] ?? "").trim());
  if (values.some(value => !value) || !/^\d{8}$/.test(values[2]) || !/^\d{2}$/.test(values[3])) {
    throw new Error(`${mode === "real" ? "실전" : "모의"}투자 키·계좌번호·계좌상품코드를 서버에 설정해주세요.`);
  }
  return {
    KIS_APP_KEY: values[0], KIS_APP_SECRET: values[1],
    KIS_ACCOUNT_NO: values[2], KIS_ACCOUNT_PRODUCT_CD: values[3],
    baseUrl: mode === "real" ? "https://openapi.koreainvestment.com:9443" : "https://openapivts.koreainvestment.com:29443",
    balanceId: mode === "real" ? "TTTC8434R" : "VTTC8434R",
    ordersId: mode === "real" ? "TTTC0081R" : "VTTC0081R",
    buyId: mode === "real" ? "TTTC0012U" : "VTTC0012U",
    sellId: mode === "real" ? "TTTC0011U" : "VTTC0011U",
  };
}
