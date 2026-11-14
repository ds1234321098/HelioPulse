/* Change this if the API is deployed somewhere other than localhost:8000. */
const API_BASE = "http://127.0.0.1:8000";
const $ = (selector) => document.querySelector(selector);
let satellites = [];

function formatNumber(value) {
  if (!Number.isFinite(value)) return "—";
  return value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function shortTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(value)) + " UTC";
}
function timestamp(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC";
}
async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `Request failed (${response.status})`); }
  return response.json();
}
function showError(message) { const banner = $("#error-banner"); banner.textContent = message; banner.classList.remove("hidden"); clearTimeout(showError.timer); showError.timer = setTimeout(() => banner.classList.add("hidden"), 6000); }
function setConnection(online) { $("#connection-dot").className = `dot ${online ? "online" : "offline"}`; $("#connection-text").textContent = online ? "NOAA LINK ACTIVE" : "API UNAVAILABLE"; }
function updateClock() { $("#clock").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date()) + " UTC"; }
function renderLive(data) {
  const { reading, storm_level: level, risk_status: status } = data;
  $("#storm-level").textContent = level;
  $("#live-flux").textContent = formatNumber(reading.flux);
  $("#last-observed").textContent = shortTime(reading.time_tag);
  $("#source-satellite").textContent = reading.satellite || "NOAA GOES";
  const pill = $("#risk-status"); pill.textContent = status === "active" ? "ELEVATED ACTIVITY" : "NORMAL CONDITIONS"; pill.className = `pill ${status === "active" ? "active" : "neutral"}`;
  const sim = $("#simulation-state"); sim.textContent = reading.is_simulated ? "ACTIVE" : "INACTIVE"; sim.className = `pill ${reading.is_simulated ? "active" : "neutral"}`;
}
function renderChart(readings) {
  $("#history-count").textContent = `${readings.length} readings`;
  if (!readings.length) return;
  $("#chart-empty").classList.add("hidden"); $("#chart-wrap").classList.remove("hidden");
  const values = readings.map((r) => r.flux); const max = Math.max(...values, 10); const cap = Math.ceil(max * 1.1); const width = 800, top = 20, base = 240, usable = base - top;
  const points = readings.map((r, index) => { const x = readings.length === 1 ? width / 2 : (index / (readings.length - 1)) * width; const y = base - (r.flux / cap) * usable; return [x, Math.max(top, y)]; });
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  $("#chart-line").setAttribute("d", line); $("#chart-area").setAttribute("d", `${line} L${points.at(-1)[0]},${base} L${points[0][0]},${base} Z`);
  $("#chart-max").textContent = formatNumber(cap); $("#chart-mid").textContent = formatNumber(cap / 2); $("#chart-start").textContent = shortTime(readings[0].time_tag); $("#chart-end").textContent = shortTime(readings.at(-1).time_tag);
}
function renderAlerts(alerts) { $("#alert-count").textContent = alerts.length; const list = $("#alerts-list"); list.innerHTML = alerts.length ? alerts.map((a) => `<div class="alert-item"><strong class="alert-level">${a.level}</strong><div class="alert-body"><strong>${formatNumber(a.flux)} pfu proton event</strong><small>${timestamp(a.triggered_at)}</small></div>${a.is_simulated ? '<span class="sim-tag">SIM</span>' : ""}</div>`).join("") : '<p class="empty-message">No active solar-weather alerts.</p>'; }
function renderMatrix(data) { $("#matrix-storm-level").textContent = `STORM LEVEL ${data.storm_level}`; const matrix = $("#risk-matrix"); matrix.innerHTML = data.satellites.map((s) => `<article class="risk-card"><div class="sat-name">${s.satellite}</div><div class="orbit">${s.orbit_class} ORBIT</div><span class="risk-badge risk-${s.risk_level.toLowerCase()}">${s.risk_level.toUpperCase()} RISK</span></article>`).join("") || '<p class="empty-message">No satellites available.</p>'; }
function renderSatellites(items) { satellites = items; const list = $("#safe-mode-list"); list.innerHTML = items.map((s) => `<div class="safe-row"><span class="safe-name">${s.name}</span><span class="safe-orbit">${s.orbit_class}</span><button class="toggle ${s.safe_mode ? "on" : ""}" aria-label="Toggle safe mode for ${s.name}" aria-pressed="${s.safe_mode}" data-id="${s.id}"></button></div>`).join("") || '<p class="empty-message">No satellites available.</p>'; list.querySelectorAll(".toggle").forEach((button) => button.addEventListener("click", () => toggleSafeMode(button))); }
async function toggleSafeMode(button) { const current = satellites.find((s) => s.id === Number(button.dataset.id)); if (!current) return; button.disabled = true; try { const data = await api("/api/safe-mode", { method: "POST", body: JSON.stringify({ satellite_id: current.id, enabled: !current.safe_mode }) }); current.safe_mode = data.satellite.safe_mode; renderSatellites(satellites); } catch (error) { showError(`Safe-mode update failed: ${error.message}`); button.disabled = false; } }
async function refresh() { $("#refresh-button").style.transform = "rotate(360deg)"; try { const [live, history, alertData, matrix, fleet] = await Promise.all([api("/api/weather/live"), api("/api/weather/history"), api("/api/alerts"), api("/api/risk-matrix"), api("/api/satellites")]); renderLive(live); renderChart(history.readings); renderAlerts(alertData.alerts); renderMatrix(matrix); renderSatellites(fleet.satellites); setConnection(true); $("#updated-at").textContent = `Last refreshed ${shortTime(new Date())}`; } catch (error) { setConnection(false); showError(`Cannot reach HelioPulse API: ${error.message}`); } finally { setTimeout(() => { $("#refresh-button").style.transform = ""; }, 250); } }
$("#refresh-button").addEventListener("click", refresh);
$("#simulation-form").addEventListener("submit", async (event) => { event.preventDefault(); const flux = Number($("#flare-flux").value); const msg = $("#simulation-message"); try { const data = await api("/api/simulate/flare", { method: "POST", body: JSON.stringify({ flux }) }); msg.textContent = `Simulation active: ${data.storm_level} at ${formatNumber(flux)} pfu.`; await refresh(); } catch (error) { msg.textContent = error.message; } });
$("#clear-simulation").addEventListener("click", async () => { const msg = $("#simulation-message"); try { await api("/api/simulate/flare/clear", { method: "POST" }); msg.textContent = "Simulation cleared; live NOAA data restored."; await refresh(); } catch (error) { msg.textContent = error.message; } });
updateClock(); setInterval(updateClock, 1000); refresh(); setInterval(refresh, 30000);
