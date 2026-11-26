/* ==========================================================
   HelioPulse frontend
   Sections:
     1. Config          5. Connection + errors
     2. Helpers         6. Renderers (one per panel)
     3. API client      7. Chart (log scale)
     4. Formatting      8. Actions   9. Refresh loop + startup

   API endpoints used (all of them):
     GET  /api/health            -> connection indicator
     GET  /api/weather/live      -> status strip
     GET  /api/weather/history   -> chart + readings table
     GET  /api/alerts            -> alert list + count
     GET  /api/risk-matrix       -> risk cards
     GET  /api/satellites        -> safe-mode list, joined into risk cards
     POST /api/safe-mode         -> toggle safe mode
     POST /api/simulate/flare    -> start simulation
     POST /api/simulate/flare/clear -> stop simulation
   ========================================================== */

/* ---------- 1. Config ---------- */

const CONFIG = {
  // Same origin when FastAPI serves this page (port 8000), otherwise the local API.
  // Override before loading this script: window.HELIOPULSE_API = "https://api.example.com"
  apiBase: window.HELIOPULSE_API ?? (location.port === "8000" ? "" : "http://127.0.0.1:8000"),
  refreshIntervalMs: 30_000,   // full dashboard refresh
  recentIntervalMs: 10_000,    // how often the history is re-read
  recentLimit: 5,              // rows shown by default
};

// NOAA solar radiation storm scale, in pfu (>=10 MeV protons). Mirrors risk.py.
const STORM_THRESHOLDS = { S1: 10, S2: 100, S3: 1_000, S4: 10_000, S5: 100_000 };

const CHART = { width: 800, height: 240 };

/* ---------- 2. Helpers ---------- */

const $ = (selector) => document.querySelector(selector);

/**
 * Build a DOM node without innerHTML, so API data can never inject markup.
 * options: { class, text, attrs: {name: value}, on: {event: handler} }
 */
function el(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  for (const [event, handler] of Object.entries(options.on ?? {})) node.addEventListener(event, handler);
  node.append(...children);
  return node;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* ---------- 3. API client ---------- */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // 0 = network failure, otherwise the HTTP status
  }
}

/** FastAPI sends `detail` as a string (HTTPException) or a list (validation errors). */
function describeDetail(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => item.msg).join("; ");
  return "";
}

async function api(path, { method = "GET", body } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(CONFIG.apiBase + path, options);
  } catch {
    throw new ApiError(`Cannot reach the API at ${CONFIG.apiBase || location.origin}.`, 0);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(describeDetail(payload.detail) || `Request failed (${response.status}).`, response.status);
  }
  return response.json();
}

/* ---------- 4. Formatting (all times are IST) ---------- */

const TIME_ZONE = "Asia/Kolkata"; // IST, UTC+05:30

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE });
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TIME_ZONE });
const clockFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: TIME_ZONE });

function formatNumber(value) {
  if (!Number.isFinite(value)) return "—";
  const digits = value >= 1000 ? 1 : value >= 1 ? 2 : 3;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}
const formatTime = (value) => (value ? `${timeFormat.format(new Date(value))} IST` : "—");
const formatDateTime = (value) => (value ? `${dateTimeFormat.format(new Date(value))} IST` : "—");

/** NOAA sends the GOES satellite number (for example 18). Show it as "GOES-18". */
function formatSatellite(value) {
  if (value === null || value === undefined || value === "") return "—";
  return /^\d+$/.test(String(value)) ? `GOES-${value}` : String(value);
}

/* ---------- 5. Connection + errors ---------- */

function setConnection(status) {
  const labels = { online: "API ONLINE", waiting: "WAITING FOR NOAA", offline: "API UNAVAILABLE" };
  const dotClass = { online: "online", waiting: "", offline: "offline" };
  $("#connection-dot").className = `dot ${dotClass[status]}`;
  $("#connection-text").textContent = labels[status];
}

let errorTimer;
function showError(message) {
  const banner = $("#error-banner");
  banner.textContent = message;
  banner.classList.remove("hidden");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => banner.classList.add("hidden"), 6000);
}

/** Replace a container's content with one muted message (used for per-panel failures). */
function showPanelMessage(selector, message) {
  $(selector).replaceChildren(el("p", { class: "empty-message", text: message }));
}

/* ---------- 6. Renderers ---------- */

// Latest data, kept so the fleet list and risk matrix can be re-rendered together.
const latest = { fleet: [], matrix: null };

function stormColor(level) {
  const number = Number(level.slice(1));
  if (number === 0) return "var(--green)";
  if (number === 1) return "var(--gold)";
  if (number <= 3) return "var(--orange)";
  return "var(--red)";
}

function renderLive({ reading, storm_level: level, risk_status: status }) {
  const stormLevel = $("#storm-level");
  stormLevel.textContent = level;
  stormLevel.style.color = stormColor(level);

  $("#live-flux").textContent = formatNumber(reading.flux);
  $("#last-observed").textContent = formatTime(reading.time_tag);
  $("#source-satellite").textContent = reading.satellite ? formatSatellite(reading.satellite) : "NOAA GOES";

  const riskPill = $("#risk-status");
  riskPill.textContent = status === "active" ? "Elevated activity" : "Normal conditions";
  riskPill.className = `pill ${status === "active" ? "active" : "neutral"}`;

  const simPill = $("#simulation-state");
  simPill.textContent = reading.is_simulated ? "Active" : "Inactive";
  simPill.className = `pill ${reading.is_simulated ? "active" : "neutral"}`;
}

function renderLiveUnavailable(error) {
  $("#storm-level").textContent = "--";
  $("#storm-level").style.color = "";
  $("#live-flux").textContent = "--";
  $("#last-observed").textContent = "--";
  const pill = $("#risk-status");
  pill.textContent = error.status === 503 ? "Waiting for first NOAA reading" : "Unavailable";
  pill.className = "pill neutral";
}

function renderAlerts({ alerts }) {
  $("#alert-count").textContent = alerts.length;
  const list = $("#alerts-list");

  if (!alerts.length) {
    showPanelMessage("#alerts-list", "No active solar-weather alerts.");
    return;
  }

  list.replaceChildren(
    ...alerts.map((alert) =>
      el("div", { class: "alert-item" },
        el("strong", { class: "alert-level", text: alert.level }),
        el("div", { class: "alert-body" },
          el("strong", { text: `${formatNumber(alert.flux)} pfu proton event` }),
          el("small", { text: formatDateTime(alert.triggered_at) }),
        ),
        alert.is_simulated ? el("span", { class: "sim-tag", text: "SIM" }) : "",
      ),
    ),
  );
}

function renderMatrix() {
  const { matrix, fleet } = latest;
  if (!matrix) return;

  $("#matrix-storm-level").textContent = `Storm level ${matrix.storm_level}`;
  if (!matrix.satellites.length) {
    showPanelMessage("#risk-matrix", "No satellites available.");
    return;
  }

  // /api/risk-matrix has no safe_mode field, so join it in from /api/satellites by name.
  const safeModeByName = new Map(fleet.map((satellite) => [satellite.name, satellite.safe_mode]));

  $("#risk-matrix").replaceChildren(
    ...matrix.satellites.map((item) => {
      const isSafe = safeModeByName.get(item.satellite) === true;
      return el("article", { class: `risk-card ${isSafe ? "protected" : ""}` },
        el("div", { class: "sat-name", text: item.satellite }),
        el("div", { class: "orbit", text: `${item.orbit_class} orbit` }),
        el("span", { class: `risk-badge risk-${item.risk_level.toLowerCase()}`, text: `${item.risk_level} risk` }),
        isSafe ? el("span", { class: "safe-note", text: "Safe mode on" }) : "",
      );
    }),
  );
}

function renderFleet() {
  const list = $("#safe-mode-list");
  if (!latest.fleet.length) {
    showPanelMessage("#safe-mode-list", "No satellites available.");
    return;
  }

  list.replaceChildren(
    ...latest.fleet.map((satellite) =>
      el("div", { class: "safe-row" },
        el("span", { class: "safe-name", text: satellite.name }),
        el("span", { class: "safe-orbit", text: satellite.orbit_class }),
        el("button", {
          class: `toggle ${satellite.safe_mode ? "on" : ""}`,
          attrs: { "aria-label": `Safe mode for ${satellite.name}`, "aria-pressed": String(satellite.safe_mode) },
          on: { click: (event) => toggleSafeMode(satellite, event.currentTarget) },
        }),
      ),
    ),
  );
}

/* ---------- Readings table (reads the backend's stored history, ~288 readings) ---------- */

const checkedFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: TIME_ZONE });
const seenReadingTimes = new Set(); // time_tags already shown, used to flash genuinely new rows
let historyCache = [];              // every reading from /api/weather/history, oldest first
let visibleCount = CONFIG.recentLimit;
let tableRenderedOnce = false;
let lastCheckedAt = null;
let historyError = "";

/** Same thresholds as risk.get_storm_level on the backend. */
function stormLevelFor(flux) {
  const reached = Object.entries(STORM_THRESHOLDS).filter(([, threshold]) => flux >= threshold);
  return reached.length ? reached.at(-1)[0] : "S0";
}

function renderReadingsTable({ flash }) {
  const body = $("#recent-body");
  const visible = historyCache.slice(-visibleCount).reverse(); // newest first

  if (!visible.length) {
    body.replaceChildren(el("tr", {}, el("td", { class: "empty-cell", text: "No readings yet.", attrs: { colspan: "4" } })));
    return;
  }

  body.replaceChildren(
    ...visible.map((reading) => {
      const level = stormLevelFor(reading.flux);
      const isNew = flash && tableRenderedOnce && !seenReadingTimes.has(reading.time_tag);
      return el("tr", { class: isNew ? "new-row" : "" },
        el("td", { text: formatDateTime(reading.time_tag) }),
        el("td", { class: "num", text: formatNumber(reading.flux) }),
        el("td", { text: level, attrs: { style: `color:${stormColor(level)}` } }),
        el("td", { text: formatSatellite(reading.satellite) }),
      );
    }),
  );
}

/** One history response feeds both the chart and the table. */
function showHistory({ readings }) {
  historyCache = readings;
  historyError = "";
  lastCheckedAt = new Date();

  renderChart({ readings });
  renderReadingsTable({ flash: true });

  readings.forEach((reading) => seenReadingTimes.add(reading.time_tag));
  tableRenderedOnce = true;
  updateHistoryStatus();
}

/** Header status: rows shown, age of newest reading, last check time. Ticks every second. */
function updateHistoryStatus() {
  const label = $("#recent-updated");
  if (historyError) {
    label.textContent = `Check failed: ${historyError}`;
    return;
  }
  if (!historyCache.length) return;

  const newest = historyCache.at(-1).time_tag;
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(newest)) / 1000));
  const age = ageSeconds < 90 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)} min`;
  const shown = Math.min(visibleCount, historyCache.length);
  label.textContent = `${shown} of ${historyCache.length} · newest ${age} old · checked ${checkedFormat.format(lastCheckedAt)} IST`;
}

/** Fetch history and render. Never rejects, so it is safe to run on its own timer. */
async function loadHistory() {
  try {
    showHistory(await api("/api/weather/history"));
  } catch (error) {
    historyError = error.message;
    if (!tableRenderedOnce) {
      $("#recent-body").replaceChildren(el("tr", {}, el("td", { class: "empty-cell", text: `Readings unavailable: ${error.message}`, attrs: { colspan: "4" } })));
    }
    updateHistoryStatus();
  }
}

/* ---------- 7. Chart (log scale) ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";
let chartModel = null; // { readings, minExp, maxExp } used by the hover handler

/** Map a flux to a y pixel on a log10 axis between 10^minExp and 10^maxExp. */
function fluxToY(flux, minExp, maxExp) {
  const exponent = Math.log10(Math.max(flux, 10 ** minExp));
  const fraction = clamp((exponent - minExp) / (maxExp - minExp), 0, 1);
  return CHART.height - fraction * CHART.height;
}

function indexToX(index, count) {
  return count === 1 ? CHART.width / 2 : (index / (count - 1)) * CHART.width;
}

function renderChart({ readings }) {
  $("#history-count").textContent = `${readings.length} readings`;
  if (!readings.length) return;

  $("#chart-empty").classList.add("hidden");
  $("#chart-wrap").classList.remove("hidden");

  // Axis range: whole decades, always showing at least up to S2 (100 pfu).
  const fluxes = readings.map((reading) => reading.flux);
  const positive = fluxes.filter((value) => value > 0);
  const minExp = clamp(Math.floor(Math.log10(Math.min(...positive, 1))), -3, -1);
  const maxExp = Math.max(2, Math.ceil(Math.log10(Math.max(...fluxes, 1))));
  chartModel = { readings, minExp, maxExp };

  // Line and filled area.
  const points = readings.map((reading, index) => [indexToX(index, readings.length), fluxToY(reading.flux, minExp, maxExp)]);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  $("#chart-line").setAttribute("d", line);
  $("#chart-area").setAttribute("d", `${line} L${points.at(-1)[0]},${CHART.height} L${points[0][0]},${CHART.height} Z`);

  // One grid line and label per decade; decades that are storm thresholds are highlighted.
  const thresholdByValue = new Map(Object.entries(STORM_THRESHOLDS).map(([name, value]) => [value, name]));
  const gridLines = [];
  const labels = [];
  for (let exponent = minExp; exponent <= maxExp; exponent++) {
    const value = 10 ** exponent;
    const y = fluxToY(value, minExp, maxExp);
    const stormName = thresholdByValue.get(value);

    const gridLine = document.createElementNS(SVG_NS, "line");
    gridLine.setAttribute("x1", 0);
    gridLine.setAttribute("x2", CHART.width);
    gridLine.setAttribute("y1", y);
    gridLine.setAttribute("y2", y);
    if (stormName) gridLine.setAttribute("class", "threshold");
    gridLines.push(gridLine);

    labels.push(el("span", {
      class: `chart-label ${stormName ? "threshold" : ""}`,
      text: stormName ? `${stormName} · ${formatNumber(value)}` : formatNumber(value),
      attrs: { style: `top:${(y / CHART.height) * 100}%` },
    }));
  }
  $("#chart-grid").replaceChildren(...gridLines);
  $("#chart-labels").replaceChildren(...labels);

  $("#chart-start").textContent = formatTime(readings[0].time_tag);
  $("#chart-end").textContent = formatTime(readings.at(-1).time_tag);
}

function setupChartHover() {
  const plot = $("#chart-plot");
  const cursor = $("#chart-cursor");
  const tooltip = $("#chart-tooltip");

  plot.addEventListener("mousemove", (event) => {
    if (!chartModel) return;
    const { readings } = chartModel;
    const rect = plot.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const index = Math.round(ratio * (readings.length - 1));
    const position = readings.length === 1 ? 0.5 : index / (readings.length - 1);

    cursor.style.left = `${position * 100}%`;
    tooltip.style.left = `${position * 100}%`;
    tooltip.style.transform = position > 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)";
    tooltip.textContent = `${formatTime(readings[index].time_tag)} · ${formatNumber(readings[index].flux)} pfu`;
    cursor.classList.remove("hidden");
    tooltip.classList.remove("hidden");
  });

  plot.addEventListener("mouseleave", () => {
    cursor.classList.add("hidden");
    tooltip.classList.add("hidden");
  });
}

/* ---------- 8. Actions ---------- */

async function toggleSafeMode(satellite, button) {
  button.disabled = true;
  try {
    const data = await api("/api/safe-mode", {
      method: "POST",
      body: { satellite_id: satellite.id, enabled: !satellite.safe_mode },
    });
    // Replace this satellite with the server's version, then redraw both views that show it.
    latest.fleet = latest.fleet.map((item) => (item.id === data.satellite.id ? data.satellite : item));
    renderFleet();
    renderMatrix();
  } catch (error) {
    showError(`Safe-mode update failed: ${error.message}`);
    button.disabled = false;
  }
}

async function startSimulation(event) {
  event.preventDefault();
  const message = $("#simulation-message");
  const flux = Number($("#flare-flux").value);

  try {
    const data = await api("/api/simulate/flare", { method: "POST", body: { flux } });
    message.textContent = `Simulation running: ${data.storm_level} at ${formatNumber(flux)} pfu.`;
    await refresh();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function clearSimulation() {
  const message = $("#simulation-message");
  try {
    await api("/api/simulate/flare/clear", { method: "POST" });
    message.textContent = "Simulation cleared. Showing live NOAA data.";
    await refresh();
  } catch (error) {
    message.textContent = error.message;
  }
}

/* ---------- 9. Refresh loop + startup ---------- */

let isRefreshing = false;

/**
 * Fetch everything in parallel, but let each panel succeed or fail on its own
 * (Promise.allSettled). One failing endpoint no longer blanks the whole dashboard.
 */
async function refresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  $("#refresh-button").classList.add("spinning");

  const [health, live, history, alerts, matrix, fleet] = await Promise.allSettled([
    api("/api/health"),
    api("/api/weather/live"),
    api("/api/weather/history"),
    api("/api/alerts"),
    api("/api/risk-matrix"),
    api("/api/satellites"),
  ]);

  // Connection: health decides online/offline; a 503 on live data means "backend up, NOAA not ready".
  if (health.status === "rejected") {
    setConnection("offline");
    showError(health.reason.message);
  } else if (live.status === "rejected" && live.reason.status === 503) {
    setConnection("waiting");
  } else {
    setConnection("online");
  }

  // Each panel handles its own result.
  if (live.status === "fulfilled") renderLive(live.value); else renderLiveUnavailable(live.reason);
  if (history.status === "fulfilled") showHistory(history.value);
  if (alerts.status === "fulfilled") renderAlerts(alerts.value); else showPanelMessage("#alerts-list", "Alerts unavailable.");

  if (fleet.status === "fulfilled") latest.fleet = fleet.value.satellites;
  if (matrix.status === "fulfilled") latest.matrix = matrix.value; else showPanelMessage("#risk-matrix", "Risk data unavailable until NOAA data arrives.");
  if (fleet.status === "fulfilled") renderFleet(); else showPanelMessage("#safe-mode-list", "Fleet unavailable.");
  if (matrix.status === "fulfilled") renderMatrix();

  $("#updated-at").textContent = `Last refreshed ${formatTime(new Date())}`;
  isRefreshing = false;
  setTimeout(() => $("#refresh-button").classList.remove("spinning"), 400);
}

function updateClock() {
  $("#clock").textContent = `${clockFormat.format(new Date())} IST`;
}

function init() {
  $("#refresh-button").addEventListener("click", refresh);
  $("#simulation-form").addEventListener("submit", startSimulation);
  $("#clear-simulation").addEventListener("click", clearSimulation);

  // Presets fill the input and submit the form.
  document.querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      $("#flare-flux").value = chip.dataset.flux;
      $("#simulation-form").requestSubmit();
    }),
  );

  $("#recent-limit").addEventListener("change", (event) => {
    visibleCount = Number(event.target.value);
    renderReadingsTable({ flash: false }); // re-slice cached data; no network call, no flashing
    updateHistoryStatus();
  });

  setupChartHover();
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(updateHistoryStatus, 1000);

  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, CONFIG.refreshIntervalMs);
  setInterval(() => { if (!document.hidden) loadHistory(); }, CONFIG.recentIntervalMs);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}

init();
