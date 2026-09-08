const $ = (selector) => document.querySelector(selector);

function money(value) { return Number(value).toLocaleString("ko-KR"); }

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "요청을 처리하지 못했습니다.");
  return body;
}

function fillSettings(settings) {
  $("#watchlist").value = settings.watchlist.join(", ");
  $("#orderBudget").value = settings.order_budget;
  $("#shortWindow").value = settings.short_window;
  $("#longWindow").value = settings.long_window;
  $("#pollInterval").value = settings.poll_interval_seconds;
}

function renderStatus(status) {
  const running = status.running;
  $("#runState").textContent = running ? "실행 중" : "중지됨";
  $("#runState").classList.toggle("running", running);
  $("#startButton").disabled = running;
  $("#stopButton").disabled = !running;
  $("#watchCount").textContent = `${status.settings.watchlist.length}개`;
  const prices = Object.entries(status.prices);
  $("#priceSummary").textContent = prices.length ? prices.map(([code, price]) => `${code} ${money(price)}원`).join(" / ") : "-";
  const positions = Object.entries(status.positions).filter(([, quantity]) => Number(quantity) > 0);
  $("#positionSummary").textContent = positions.length ? positions.map(([code, quantity]) => `${code} ${quantity}주`).join(" / ") : "없음";
}

function renderEvents(events) {
  $("#events").innerHTML = events.length ? events.map((event) => `<div class="event"><time>${event.time}</time><span class="${event.level}">${event.level}</span><span>${event.message}</span></div>`).join("") : "<div class=\"event\"><span></span><span></span><span>아직 실행 기록이 없습니다.</span></div>";
}

async function refresh() {
  try {
    const [status, events] = await Promise.all([api("/api/status"), api("/api/events")]);
    fillSettings(status.settings);
    renderStatus(status);
    renderEvents(events);
  } catch (error) { $("#formError").textContent = error.message; }
}

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#formError").textContent = "";
  try {
    const settings = await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ watchlist: $("#watchlist").value, order_budget: $("#orderBudget").value, short_window: $("#shortWindow").value, long_window: $("#longWindow").value, poll_interval_seconds: $("#pollInterval").value }) });
    fillSettings(settings);
  } catch (error) { $("#formError").textContent = error.message; }
});

$("#startButton").addEventListener("click", async () => { try { await api("/api/start", { method: "POST" }); await refresh(); } catch (error) { $("#formError").textContent = error.message; } });
$("#stopButton").addEventListener("click", async () => { await api("/api/stop", { method: "POST" }); await refresh(); });

refresh();
setInterval(refresh, 3000);
