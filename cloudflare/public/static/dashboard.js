import { addStockCode, searchStocks, watchlistCodes } from "./stock-search.js";

const $ = (selector) => document.querySelector(selector);
let currentMode = "paper";
let currentMarket = "kr";
let changingMode = false;
let stockNames = {};
let stockNameRequestKey = "";
let stockNameLoading = false;
let stockNameLoadComplete = false;
let latestStatus;
let stockCatalog = [];
let catalogNames = {};
let catalogLoading = false;
let catalogLoaded = false;

function money(value) { return Number(value).toLocaleString("ko-KR"); }
function priceText(value) { return currentMarket === "us" ? `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${money(value)}원`; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function stockLabel(code) { return stockNames[code] || catalogNames[code] ? `${code} · ${stockNames[code] || catalogNames[code]}` : code; }

function renderWatchlistNames(status) {
  const container = $("#watchlistNames");
  container.replaceChildren();
  if (status.market !== "kr") return;
  for (const code of watchlistCodes($("#watchlist").value)) {
    const chip = document.createElement("span");
    chip.className = "watchlist-chip";
    chip.append(document.createTextNode(stockLabel(code)));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `${stockLabel(code)} 삭제`);
    remove.disabled = status.running || changingMode;
    remove.addEventListener("click", () => {
      const codes = watchlistCodes($("#watchlist").value);
      codes.splice(codes.indexOf(code), 1);
      $("#watchlist").value = codes.join(", ");
      renderWatchlistNames(status);
      renderStockSearchResults();
    });
    chip.append(remove);
    container.append(chip);
  }
}

function renderStockSearchResults() {
  const results = $("#stockSearchResults");
  results.replaceChildren();
  const query = $("#stockSearch").value.trim();
  if (currentMarket !== "kr" || !query) return;
  if (!catalogLoaded) {
    results.textContent = catalogLoading ? "종목 목록을 불러오는 중입니다." : "종목 목록을 불러오지 못했습니다. 코드를 직접 입력할 수 있습니다.";
    return;
  }
  const matches = searchStocks(stockCatalog, query, watchlistCodes($("#watchlist").value));
  if (!matches.length) {
    results.textContent = "검색 결과가 없습니다.";
    return;
  }
  for (const [code, name, market] of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stock-search-result";
    button.disabled = Boolean(latestStatus?.running) || changingMode;
    const label = document.createElement("span");
    label.textContent = name;
    const detail = document.createElement("small");
    detail.textContent = `${code} · ${market}`;
    button.append(label, detail);
    button.addEventListener("click", () => {
      const next = addStockCode($("#watchlist").value, code);
      $("#formError").textContent = next.error;
      if (next.error) return;
      $("#watchlist").value = next.value;
      $("#stockSearch").value = "";
      renderWatchlistNames(latestStatus);
      renderStockSearchResults();
      $("#stockSearch").focus();
    });
    results.append(button);
  }
}

async function loadStockCatalog() {
  if (catalogLoading || catalogLoaded) return;
  catalogLoading = true;
  renderStockSearchResults();
  try {
    const response = await fetch("/static/kr-stocks.json");
    if (!response.ok) throw new Error("종목 목록 오류");
    const catalog = await response.json();
    if (!Array.isArray(catalog.stocks)) throw new Error("종목 목록 형식 오류");
    stockCatalog = catalog.stocks;
    catalogNames = Object.fromEntries(stockCatalog.map(([code, name]) => [code, name]));
    catalogLoaded = true;
    if (latestStatus) renderWatchlistNames(latestStatus);
  } catch {
    catalogLoaded = false;
  } finally {
    catalogLoading = false;
    renderStockSearchResults();
  }
}

async function loadStockNames(status) {
  const key = `${status.market}:${status.settings.watchlist.join(",")}`;
  if (key !== stockNameRequestKey) {
    stockNameRequestKey = key;
    stockNames = {};
    stockNameLoadComplete = status.market !== "kr";
    renderWatchlistNames(status);
  }
  if (stockNameLoading || stockNameLoadComplete) return;
  stockNameLoading = true;
  try {
    const result = await api("/api/stock-names");
    if (key !== stockNameRequestKey) return;
    stockNames = { ...stockNames, ...result.names };
    stockNameLoadComplete = !result.pending;
    if (latestStatus) {
      renderWatchlistNames(latestStatus);
      renderStatus(latestStatus);
      renderPriceChart(latestStatus.price_history);
    }
  } catch {
    if (key === stockNameRequestKey && latestStatus) renderWatchlistNames(latestStatus);
    stockNameLoadComplete = true;
  } finally {
    stockNameLoading = false;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...options.headers, "X-Moa-Request": "dashboard" },
  });
  if (response.status === 401) {
    window.location.reload();
    throw new Error("로그인이 필요합니다.");
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    window.location.reload();
    throw new Error("로그인 세션을 확인하고 있습니다.");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "요청을 처리하지 못했습니다.");
  return body;
}

function fillSettings(settings) {
  $("#watchlist").value = settings.watchlist.join(", ");
  $("#orderBudget").value = settings.order_budget;
  $("#dailyBuyLimit").value = settings.daily_buy_limit;
  $("#dailyOrderLimit").value = settings.daily_order_limit;
  $("#shortWindow").value = settings.short_window;
  $("#longWindow").value = settings.long_window;
  $("#pollInterval").value = settings.poll_interval_seconds;
}

function renderStatus(status) {
  currentMode = status.mode;
  currentMarket = status.market || "kr";
  const us = currentMarket === "us";
  $("#pendingOrderDescription").hidden = !status.pending_order;
  $("#pendingOrderDescription").textContent = status.pending_order ? `${status.pending_order.code} 해외 주문의 체결·취소 확인이 필요합니다. KIS 앱에서 확인해주세요. 중지 버튼은 접수된 주문을 취소하지 않습니다.` : "";
  $("#acknowledgeOrder").hidden = !status.pending_order;
  $("#acknowledgeOrder").disabled = status.running || changingMode;
  document.querySelectorAll("[data-market]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.market === currentMarket));
    button.disabled = status.running || changingMode;
  });
  $("#marketDescription").textContent = us ? "NASDAQ·NYSE·AMEX / 예: NASD:AAPL, NYSE:IBM, AMEX:SPY. 뉴욕 정규장에 조회 가격을 센트 단위로 반올림한 지정가로 주문합니다. 미체결 시 중지하며, 취소는 KIS에서 해주세요. 1달러 이상·정수 주식만 지원합니다." : "국내주식 · 원화 한도 · 시장가 주문";
  $("label[for='watchlist'] span").textContent = us ? "거래소:티커, 쉼표로 구분" : "6자리 코드, 쉼표로 구분";
  $("#watchlist").placeholder = us ? "NASD:AAPL, NYSE:IBM, AMEX:SPY" : "005930";
  $("#watchlist").inputMode = us ? "text" : "numeric";
  $("#stockSearchPanel").hidden = us;
  $("#stockSearch").disabled = status.running || changingMode;
  if (!us) void loadStockCatalog();
  renderStockSearchResults();
  for (const id of ["orderBudget", "dailyBuyLimit"]) {
    $(`#${id}`).min = us ? "1" : "1000";
    $(`#${id}`).step = us ? "0.01" : "1000";
    $(`label[for='${id}'] span`).textContent = us ? "USD" : "원";
  }
  $(".metric-icon.blue").textContent = us ? "$" : "₩";
  $(".safety-card > p").textContent = `시장·투자모드별 한도입니다. ${us ? "뉴욕" : "한국"} 자정에 새로 집계하며, 주문 예약 금액은 거절·취소되어도 당일 한도에서 차감합니다. 수수료는 별도입니다.`;
  $("#settingsForm button[type='submit']").disabled = status.running || changingMode;
  const real = currentMode === "real";
  document.body.classList.toggle("real-mode", real);
  $("#modeBadge").textContent = real ? "실전투자" : "모의투자";
  $(".mode-pill").textContent = real ? "REAL TRADING" : "PAPER TRADING";
  $(".hero-copy").textContent = real ? "실제 계좌의 자금으로 주문합니다. 시작 전 주문 한도를 확인하세요." : "설정한 안전 한도 안에서만 모의투자 주문을 실행합니다.";
  $("#positionSummary").nextElementSibling.textContent = real ? "실전투자 계좌 기준" : "모의투자 계좌 기준";
  $("#modeDescription").textContent = real
    ? (status.mode_ready ? "실제 자금으로 거래합니다. 시작할 때 주문 실행을 확인합니다." : "실전투자 키·계좌번호·계좌상품코드 설정이 필요합니다. 현재 시작할 수 없습니다.")
    : "모의 계좌로 거래합니다. 실행 중에는 모드를 바꿀 수 없습니다.";
  document.querySelectorAll("[data-mode]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === currentMode));
    button.disabled = status.running || changingMode;
  });
  const running = status.running;
  $("#runState").textContent = running ? "실행 중" : "중지됨";
  $("#runState").classList.toggle("running", running);
  $("#heroRunState").textContent = running ? "자동매매 실행 중" : "시작을 기다리고 있어요";
  $(".hero-status-card").classList.toggle("active", running);
  $("#startButton").disabled = running || changingMode || (real && !status.mode_ready) || (us && Boolean(status.pending_order));
  $("#startButton").textContent = real ? "실전 자동매매 시작" : "모의 자동매매 시작";
  $("#stopButton").disabled = !running;
  $("#watchCount").textContent = `${status.settings.watchlist.length}개`;
  const prices = Object.entries(status.prices);
  $("#priceSummary").textContent = prices.length ? prices.map(([code, price]) => `${stockLabel(code)} ${priceText(price)}`).join(" / ") : "-";
  const positions = Object.entries(status.positions).filter(([, quantity]) => Number(quantity) > 0);
  $("#positionSummary").textContent = positions.length ? positions.map(([code, quantity]) => `${stockLabel(code)} ${quantity}주`).join(" / ") : "없음";
  const usage = status.daily_usage;
  $("#dailyUsageSummary").textContent = usage ? `${usage.order_count}회 / 매수 ${priceText(usage.buy_amount)}` : "-";
}

function renderEvents(events) {
  $("#events").innerHTML = events.length ? events.map((event) => `<div class="event"><time>${escapeHtml(event.time)}</time><span class="${escapeHtml(event.level)}">${escapeHtml(event.level)}</span><span>${escapeHtml(event.message)}</span></div>`).join("") : "<div class=\"event\"><span></span><span></span><span>아직 실행 기록이 없습니다.</span></div>";
}

function renderPriceChart(historyByCode) {
  const chart = $("#priceChart");
  const legend = $("#priceChartLegend");
  const series = Object.entries(historyByCode || {}).filter(([, values]) => values.length);
  const colors = ["violet", "blue", "mint", "amber"];
  if (!series.length) {
    legend.innerHTML = "";
    chart.innerHTML = '<text x="340" y="115" text-anchor="middle" class="chart-empty">자동매매를 시작하면 최근 시세가 표시됩니다.</text>';
    return;
  }
  legend.innerHTML = series.map(([code], index) => `<span class="series-${colors[index % colors.length]}">${escapeHtml(stockLabel(code))}</span>`).join("");
  const allPrices = series.flatMap(([, values]) => values.map((value) => Number(value.price)));
  const low = Math.min(...allPrices);
  const high = Math.max(...allPrices);
  const padding = Math.max((high - low) * 0.12, high * 0.002, 1);
  const minPrice = low - padding;
  const maxPrice = high + padding;
  const left = 76;
  const right = 650;
  const top = 20;
  const bottom = 170;
  const longest = Math.max(...series.map(([, values]) => values.length));
  const xFor = (index, length) => length === 1 ? (left + right) / 2 : left + ((right - left) * index) / (length - 1);
  const yFor = (price) => bottom - ((price - minPrice) / (maxPrice - minPrice)) * (bottom - top);
  const priceLabel = priceText;
  const grid = [top, (top + bottom) / 2, bottom].map((y) => {
    const price = maxPrice - ((y - top) / (bottom - top)) * (maxPrice - minPrice);
    return `<g><line x1="${left}" y1="${y}" x2="${right}" y2="${y}" class="chart-grid"/><text x="8" y="${y + 4}" class="chart-label">${priceLabel(price)}</text></g>`;
  }).join("");
  const paths = series.map(([code, values], seriesIndex) => {
    const color = colors[seriesIndex % colors.length];
    const points = values.map((value, index) => `${xFor(index, values.length)},${yFor(Number(value.price))}`).join(" ");
    const markers = values.map((value, index) => `<circle cx="${xFor(index, values.length)}" cy="${yFor(Number(value.price))}" r="3.5" class="price-point series-${color}"><title>${escapeHtml(stockLabel(code))} · ${escapeHtml(value.time)} · ${priceLabel(value.price)}</title></circle>`).join("");
    return `<polyline points="${points}" class="price-line series-${color}"/>${markers}`;
  }).join("");
  const firstSeries = series[0][1];
  const timestamps = firstSeries.map((value, index) => {
    if (index !== 0 && index !== firstSeries.length - 1 && index % Math.ceil(longest / 3) !== 0) return "";
    return `<text x="${xFor(index, firstSeries.length)}" y="204" text-anchor="middle" class="chart-time">${value.time}</text>`;
  }).join("");
  chart.innerHTML = `${grid}${paths}${timestamps}`;
}

async function refresh() {
  try {
    const [status, events] = await Promise.all([api("/api/status"), api("/api/events")]);
    latestStatus = status;
    if (status.market !== currentMarket || !$("#settingsForm").contains(document.activeElement)) fillSettings(status.settings);
    renderStatus(status);
    renderWatchlistNames(status);
    renderEvents(events);
    renderPriceChart(status.price_history);
    void loadStockNames(status);
  } catch (error) { $("#formError").textContent = error.message; }
}

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#formError").textContent = "";
  try {
    const settings = await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ watchlist: $("#watchlist").value, order_budget: $("#orderBudget").value, daily_buy_limit: $("#dailyBuyLimit").value, daily_order_limit: $("#dailyOrderLimit").value, short_window: $("#shortWindow").value, long_window: $("#longWindow").value, poll_interval_seconds: $("#pollInterval").value }) });
    fillSettings(settings);
    await refresh();
  } catch (error) { $("#formError").textContent = error.message; }
});

$("#watchlist").addEventListener("input", () => {
  if (latestStatus) renderWatchlistNames(latestStatus);
  renderStockSearchResults();
});
$("#stockSearch").addEventListener("input", renderStockSearchResults);
$("#stockSearch").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("#stockSearch").value = "";
    renderStockSearchResults();
  }
});

document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", async () => {
  if (changingMode || button.dataset.mode === currentMode) return;
  changingMode = true;
  document.querySelectorAll("[data-mode]").forEach(item => { item.disabled = true; });
  $("#startButton").disabled = true;
  $("#formError").textContent = "";
  try { await api("/api/mode", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: button.dataset.mode }) }); }
  catch (error) { $("#formError").textContent = error.message; }
  finally { changingMode = false; await refresh(); }
}));
document.querySelectorAll("[data-market]").forEach(button => button.addEventListener("click", async () => {
  if (changingMode || button.dataset.market === currentMarket) return;
  changingMode = true;
  document.querySelectorAll("[data-mode], [data-market], #startButton, #settingsForm button[type='submit']").forEach(item => { item.disabled = true; });
  $("#formError").textContent = "";
  try {
    const result = await api("/api/market", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market: button.dataset.market }) });
    fillSettings(result.settings);
  } catch (error) { $("#formError").textContent = error.message; }
  finally { changingMode = false; await refresh(); }
}));
$("#startButton").addEventListener("click", async () => {
  const real = currentMode === "real";
  if (real && !window.confirm("저장된 설정으로 실제 계좌에 매수·매도 주문을 실행합니다. 실전 자동매매를 시작할까요?")) return;
  try { await api("/api/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm_real: real }) }); await refresh(); }
  catch (error) { $("#formError").textContent = error.message; }
});
$("#acknowledgeOrder").addEventListener("click", async () => {
  if (!window.confirm("KIS 앱에서 해당 해외 주문이 전량 체결되었거나 취소된 것을 확인했나요? 미체결 주문이 남아 있으면 취소하거나 체결을 기다려주세요. 확인 후에도 자동매매는 중지 상태입니다.")) return;
  try { await api("/api/acknowledge-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) }); await refresh(); }
  catch (error) { $("#formError").textContent = error.message; }
});
$("#stopButton").addEventListener("click", async () => { await api("/api/stop", { method: "POST" }); await refresh(); });
refresh();
setInterval(refresh, 3000);
