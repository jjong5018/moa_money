export function watchlistCodes(value) {
  return value.split(",").map(code => code.trim()).filter(Boolean);
}

export function addStockCode(value, code, max = 10) {
  const codes = watchlistCodes(value);
  if (codes.includes(code)) return { value, error: "이미 감시 목록에 있는 종목입니다." };
  if (codes.length >= max) return { value, error: `감시 종목은 최대 ${max}개입니다.` };
  return { value: [...codes, code].join(", "), error: "" };
}

export function searchStocks(stocks, query, selected = [], limit = 8) {
  const term = query.trim().toLocaleLowerCase("ko-KR");
  if (!term) return [];
  const selectedCodes = new Set(selected);
  return stocks
    .filter(([code, name]) => !selectedCodes.has(code) && (code.includes(term) || name.toLocaleLowerCase("ko-KR").includes(term)))
    .sort((a, b) => {
      const rank = ([code, name]) => code === term || name.toLocaleLowerCase("ko-KR") === term ? 0 : code.startsWith(term) || name.toLocaleLowerCase("ko-KR").startsWith(term) ? 1 : 2;
      return rank(a) - rank(b) || a[1].localeCompare(b[1], "ko-KR");
    })
    .slice(0, limit);
}
