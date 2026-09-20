const $ = (selector) => document.querySelector(selector);

function money(value) { return Number(value).toLocaleString("ko-KR"); }

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
  const running = status.running;
  $("#runState").textContent = running ? "실행 중" : "중지됨";
  $("#runState").classList.toggle("running", running);
  $("#heroRunState").textContent = running ? "자동매매 실행 중" : "시작을 기다리고 있어요";
  $(".hero-status-card").classList.toggle("active", running);
  $("#startButton").disabled = running;
  $("#stopButton").disabled = !running;
  $("#watchCount").textContent = `${status.settings.watchlist.length}개`;
  const prices = Object.entries(status.prices);
  $("#priceSummary").textContent = prices.length ? prices.map(([code, price]) => `${code} ${money(price)}원`).join(" / ") : "-";
  const positions = Object.entries(status.positions).filter(([, quantity]) => Number(quantity) > 0);
  $("#positionSummary").textContent = positions.length ? positions.map(([code, quantity]) => `${code} ${quantity}주`).join(" / ") : "없음";
  const usage = status.daily_usage;
  $("#dailyUsageSummary").textContent = usage ? `${usage.order_count}회 / 매수 ${money(usage.buy_amount)}원` : "-";
}

function renderEvents(events) {
  $("#events").innerHTML = events.length ? events.map((event) => `<div class="event"><time>${event.time}</time><span class="${event.level}">${event.level}</span><span>${event.message}</span></div>`).join("") : "<div class=\"event\"><span></span><span></span><span>아직 실행 기록이 없습니다.</span></div>";
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
  legend.innerHTML = series.map(([code], index) => `<span class="series-${colors[index % colors.length]}">${code}</span>`).join("");
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
  const priceLabel = (price) => `${Math.round(price).toLocaleString("ko-KR")}원`;
  const grid = [top, (top + bottom) / 2, bottom].map((y) => {
    const price = maxPrice - ((y - top) / (bottom - top)) * (maxPrice - minPrice);
    return `<g><line x1="${left}" y1="${y}" x2="${right}" y2="${y}" class="chart-grid"/><text x="8" y="${y + 4}" class="chart-label">${priceLabel(price)}</text></g>`;
  }).join("");
  const paths = series.map(([code, values], seriesIndex) => {
    const color = colors[seriesIndex % colors.length];
    const points = values.map((value, index) => `${xFor(index, values.length)},${yFor(Number(value.price))}`).join(" ");
    const markers = values.map((value, index) => `<circle cx="${xFor(index, values.length)}" cy="${yFor(Number(value.price))}" r="3.5" class="price-point series-${color}"><title>${code} · ${value.time} · ${priceLabel(value.price)}</title></circle>`).join("");
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
    fillSettings(status.settings);
    renderStatus(status);
    renderEvents(events);
    renderPriceChart(status.price_history);
  } catch (error) { $("#formError").textContent = error.message; }
}

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#formError").textContent = "";
  try {
    const settings = await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ watchlist: $("#watchlist").value, order_budget: $("#orderBudget").value, daily_buy_limit: $("#dailyBuyLimit").value, daily_order_limit: $("#dailyOrderLimit").value, short_window: $("#shortWindow").value, long_window: $("#longWindow").value, poll_interval_seconds: $("#pollInterval").value }) });
    fillSettings(settings);
  } catch (error) { $("#formError").textContent = error.message; }
});

$("#startButton").addEventListener("click", async () => { try { await api("/api/start", { method: "POST" }); await refresh(); } catch (error) { $("#formError").textContent = error.message; } });
$("#stopButton").addEventListener("click", async () => { await api("/api/stop", { method: "POST" }); await refresh(); });
refresh();
setInterval(refresh, 3000);
