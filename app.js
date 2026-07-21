import * as L from "./vendor/leaflet/leaflet-src.esm.js";

const DATA_URL = "./data/location-data.json";
const TILE_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";
const TILE_DARK = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const JST_OFFSET_MS = 9 * HOUR_MS;
const MODE_ORDER = ["vehicle", "train", "flight", "walking", "cycling", "bus", "unknown"];

const dateShort = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dateCompact = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "short",
  day: "numeric",
});
const dateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const distanceFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });

let DATA = null;
let current = null;
let monthBarRects = [];
let redrawQueued = false;
let leafletMap = null;
let leafletBaseLayer = null;
let leafletFeatureLayer = null;
let leafletTheme = null;
let leafletRenderer = null;

const state = {
  startDay: 0,
  endDay: 0,
  view: "routes",
  modes: new Set(),
  selected: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const mapWrap = $("#map-wrap");
const monthCanvas = $("#month-chart");
const monthContext = monthCanvas.getContext("2d");

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function modeColor(mode) {
  return css(`--${mode}`) || css("--unknown");
}

function modeLabel(mode) {
  return DATA?.modeLabels?.[mode] || "未分類";
}

function validateData(data) {
  if (!data || data.schemaVersion !== 1) throw new Error("データ形式が未対応です。");
  if (!data.period || !Array.isArray(data.activities) || !Array.isArray(data.visits) || !Array.isArray(data.paths)) {
    throw new Error("必要な移動データがありません。");
  }
}

function rangeTimes() {
  const start = DATA.period.start + state.startDay * DAY_MS;
  const end = state.endDay >= DATA.period.days - 1
    ? DATA.period.end
    : DATA.period.start + (state.endDay + 1) * DAY_MS;
  return { start, end };
}

function overlaps(item, start, end) {
  return item.end >= start && item.start <= end;
}

function overlapFraction(item, start, end) {
  const duration = Math.max(1, item.end - item.start);
  const overlap = Math.max(0, Math.min(item.end, end) - Math.max(item.start, start));
  return overlap / duration;
}

function computeCurrent() {
  const { start, end } = rangeTimes();
  const activities = DATA.activities.filter((item) => state.modes.has(item.mode) && overlaps(item, start, end));
  const paths = DATA.paths.filter((item) => state.modes.has(item.mode) && overlaps(item, start, end));
  const visits = DATA.visits.filter((item) => overlaps(item, start, end));

  const placeMap = new Map();
  visits.forEach((visit) => {
    const ratio = overlapFraction(visit, start, end);
    const row = placeMap.get(visit.placeId) || {
      id: visit.placeId,
      point: visit.point,
      semantic: visit.semantic,
      visits: 0,
      durationHours: 0,
      first: visit.start,
      last: visit.end,
    };
    row.visits += 1;
    row.durationHours += (visit.durationMinutes * ratio) / 60;
    row.first = Math.min(row.first, visit.start);
    row.last = Math.max(row.last, visit.end);
    placeMap.set(visit.placeId, row);
  });
  const places = [...placeMap.values()].sort((a, b) => b.visits - a.visits || b.durationHours - a.durationHours);

  const modeStats = new Map();
  let distanceKm = 0;
  let movementHours = 0;
  activities.forEach((activity) => {
    const ratio = overlapFraction(activity, start, end);
    const distance = activity.distanceKm * ratio;
    const hours = (activity.durationMinutes * ratio) / 60;
    distanceKm += distance;
    movementHours += hours;
    const row = modeStats.get(activity.mode) || { count: 0, distanceKm: 0, hours: 0 };
    row.count += 1;
    row.distanceKm += distance;
    row.hours += hours;
    modeStats.set(activity.mode, row);
  });

  return {
    start,
    end,
    activities,
    paths,
    visits,
    places,
    modeStats,
    distanceKm,
    movementHours,
  };
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function formatDuration(hours) {
  if (hours >= 24) return `${distanceFormat.format(hours / 24)}日`;
  if (hours >= 1) return `${distanceFormat.format(hours)}時間`;
  return `${Math.max(1, Math.round(hours * 60))}分`;
}

function updateMetrics() {
  setText("#metric-distance", numberFormat.format(current.distanceKm));
  setText("#metric-places", numberFormat.format(current.places.length));
  setText("#metric-hours", numberFormat.format(current.movementHours));
  setText("#metric-days", numberFormat.format(state.endDay - state.startDay + 1));
  setText("#breakdown-total", `${numberFormat.format(current.distanceKm)} km`);
  setText("#range-start-label", dateShort.format(current.start));
  setText("#range-end-label", dateShort.format(Math.max(current.start, current.end - 1)));

  const startPercent = (state.startDay / Math.max(1, DATA.period.days - 1)) * 100;
  const endPercent = (state.endDay / Math.max(1, DATA.period.days - 1)) * 100;
  const fill = $("#range-fill");
  fill.style.left = `${startPercent}%`;
  fill.style.width = `${Math.max(0, endPercent - startPercent)}%`;
}

function updateBreakdown() {
  const host = $("#mode-breakdown");
  host.replaceChildren();
  const maxDistance = Math.max(1, ...[...current.modeStats.values()].map((row) => row.distanceKm));
  MODE_ORDER.forEach((mode) => {
    const row = current.modeStats.get(mode);
    if (!row) return;
    const wrapper = document.createElement("div");
    wrapper.className = "breakdown-row";
    wrapper.style.setProperty("--mode-color", modeColor(mode));
    wrapper.innerHTML = `
      <div class="breakdown-copy">
        <span class="breakdown-label">${modeLabel(mode)}</span>
        <span class="breakdown-value">${distanceFormat.format(row.distanceKm)} km</span>
      </div>
      <div class="breakdown-bar"><span style="--bar-width:${Math.max(1, (row.distanceKm / maxDistance) * 100)}%"></span></div>
    `;
    host.append(wrapper);
  });
  if (!host.children.length) {
    const empty = document.createElement("p");
    empty.className = "selection-meta";
    empty.textContent = "選択中の移動手段に記録がありません。";
    host.append(empty);
  }
}

function updateJourneys() {
  const host = $("#journey-list");
  host.replaceChildren();
  const rows = [...current.activities].sort((a, b) => b.distanceKm - a.distanceKm).slice(0, 5);
  rows.forEach((journey) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "journey-item";
    button.innerHTML = `
      <span class="journey-mode">${modeLabel(journey.mode)}${journey.coarse ? " 推定幅大" : ""}</span>
      <span class="journey-date">${dateCompact.format(journey.start)} ${dateTime.format(journey.start).slice(-5)}</span>
      <span class="journey-distance">${distanceFormat.format(journey.distanceKm)} km</span>
    `;
    button.addEventListener("click", () => selectJourney(journey));
    host.append(button);
  });
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "selection-meta";
    empty.textContent = "この条件では長距離区間がありません。";
    host.append(empty);
  }
}

function buildRhythm() {
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  current.activities.forEach((activity) => {
    let cursor = Math.max(activity.start, current.start);
    const end = Math.min(activity.end, current.end);
    while (cursor < end) {
      const shifted = cursor + JST_OFFSET_MS;
      const nextHour = (Math.floor(shifted / HOUR_MS) + 1) * HOUR_MS - JST_OFFSET_MS;
      const stop = Math.min(end, nextHour);
      const local = new Date(shifted);
      const weekday = (local.getUTCDay() + 6) % 7;
      const hour = local.getUTCHours();
      matrix[weekday][hour] += (stop - cursor) / 60_000;
      cursor = stop;
    }
  });
  return matrix;
}

function updateRhythm() {
  const host = $("#rhythm-chart");
  host.replaceChildren();
  const matrix = buildRhythm();
  const max = Math.max(1, ...matrix.flat());
  const dayLabels = ["月", "火", "水", "木", "金", "土", "日"];

  const spacer = document.createElement("span");
  host.append(spacer);
  for (let hour = 0; hour < 24; hour += 1) {
    const label = document.createElement("span");
    label.className = "rhythm-hour";
    label.textContent = hour % 6 === 0 ? String(hour) : "";
    host.append(label);
  }

  matrix.forEach((row, weekday) => {
    const day = document.createElement("span");
    day.className = "rhythm-day";
    day.textContent = dayLabels[weekday];
    host.append(day);
    row.forEach((minutes, hour) => {
      const cell = document.createElement("span");
      cell.className = "rhythm-cell";
      const intensity = minutes ? Math.max(10, Math.round((minutes / max) * 78)) : 0;
      cell.style.setProperty("--heat", `${intensity}%`);
      cell.title = `${dayLabels[weekday]}曜 ${hour}時: ${Math.round(minutes)}分`;
      host.append(cell);
    });
  });
}

function resizeCanvas(target, context, cssHeight) {
  const rect = target.getBoundingClientRect();
  const ratio = Math.min(2.5, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round((cssHeight || rect.height) * ratio));
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width: rect.width, height: cssHeight || rect.height, ratio };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function pointToLatLng(point) {
  return [point[1], point[0]];
}

function validPoint(point) {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function updateLeafletTiles() {
  if (!leafletMap) return;
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  if (leafletBaseLayer && leafletTheme === theme) return;
  const next = L.tileLayer(theme === "dark" ? TILE_DARK : TILE_LIGHT, {
    attribution: TILE_ATTRIBUTION,
    subdomains: "abcd",
    maxZoom: 19,
    keepBuffer: 3,
    updateWhenIdle: true,
    crossOrigin: "anonymous",
    className: "life-atlas-tiles",
  });
  next.addTo(leafletMap);
  next.bringToBack();
  if (leafletBaseLayer) leafletMap.removeLayer(leafletBaseLayer);
  leafletBaseLayer = next;
  leafletTheme = theme;
}

function initLeafletMap() {
  if (leafletMap) return;
  const host = $("#real-map");
  leafletRenderer = L.canvas({ padding: 0.6, tolerance: 8 });
  leafletMap = L.map(host, {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
    renderer: leafletRenderer,
    minZoom: 2,
    maxZoom: 18,
    zoomSnap: 1,
    zoomDelta: 1,
    wheelPxPerZoomLevel: 95,
    worldCopyJump: true,
  });
  leafletMap.attributionControl.setPrefix("");
  leafletFeatureLayer = L.layerGroup().addTo(leafletMap);
  updateLeafletTiles();
  const center = [
    (DATA.bounds.south + DATA.bounds.north) / 2,
    (DATA.bounds.west + DATA.bounds.east) / 2,
  ];
  leafletMap.setView(center, 5, { animate: false });
  host.setAttribute("tabindex", "0");
}

function addPlaceMarkers(limit, emphasized = false) {
  const places = current.places.slice(0, limit);
  const maxVisits = Math.max(1, ...places.map((place) => place.visits));
  places.forEach((place) => {
    if (!validPoint(place.point)) return;
    const selected = state.selected?.type === "place" && state.selected.value.id === place.id;
    const radius = (emphasized ? 4.5 : 2.8) + Math.sqrt(place.visits / maxVisits) * (emphasized ? 9 : 4.5);
    const marker = L.circleMarker(pointToLatLng(place.point), {
      renderer: leafletRenderer,
      radius: selected ? radius + 2 : radius,
      color: selected ? css("--text") : css("--surface-strong"),
      weight: selected ? 2 : 1,
      opacity: emphasized ? 0.92 : 0.62,
      fillColor: css("--accent"),
      fillOpacity: emphasized ? 0.72 : 0.38,
      bubblingMouseEvents: false,
      keyboard: true,
    });
    marker.bindTooltip(
      `<strong>${escapeHtml(place.id)}</strong><br>${place.visits}回訪問 / ${escapeHtml(formatDuration(place.durationHours))}`,
      { className: "life-map-tooltip", direction: "top", offset: [0, -5], opacity: 1 },
    );
    marker.on("click", () => selectPlace(place));
    marker.addTo(leafletFeatureLayer);
  });
}

function addRouteLayers() {
  let shown = 0;
  current.paths.forEach((path) => {
    const points = path.points.filter(validPoint).map(pointToLatLng);
    if (points.length < 2) return;
    const line = L.polyline(points, {
      renderer: leafletRenderer,
      color: modeColor(path.mode),
      weight: path.mode === "flight" ? 1.8 : 1.45,
      opacity: document.documentElement.dataset.theme === "light" ? 0.58 : 0.68,
      lineCap: "round",
      lineJoin: "round",
      smoothFactor: 0.75,
      bubblingMouseEvents: false,
    });
    line.bindTooltip(
      `<strong>${escapeHtml(modeLabel(path.mode))}</strong><br>${escapeHtml(dateTime.format(path.start))} / ${path.pointCount}点`,
      { className: "life-map-tooltip", sticky: true, opacity: 1 },
    );
    line.addTo(leafletFeatureLayer);
    shown += 1;
  });
  addPlaceMarkers(24, false);
  return shown;
}

function addHeatLayers() {
  current.visits.forEach((visit) => {
    if (!validPoint(visit.point)) return;
    const durationScale = Math.min(1, Math.log10(Math.max(10, visit.durationMinutes)) / 4);
    L.circleMarker(pointToLatLng(visit.point), {
      renderer: leafletRenderer,
      radius: 4 + durationScale * 13,
      stroke: false,
      fillColor: css("--accent"),
      fillOpacity: 0.08 + durationScale * 0.19,
      interactive: false,
    }).addTo(leafletFeatureLayer);
  });
  addPlaceMarkers(32, false);
  return current.visits.length;
}

function updateLeafletMap() {
  if (!leafletMap || !leafletFeatureLayer || !DATA || !current) return;
  leafletMap.invalidateSize(false);
  updateLeafletTiles();
  leafletFeatureLayer.clearLayers();

  let visible = 0;
  if (state.view === "routes") visible = addRouteLayers();
  else if (state.view === "heat") visible = addHeatLayers();
  else {
    addPlaceMarkers(100, true);
    visible = current.places.length;
  }

  $("#map-empty").hidden = visible > 0;
  setText("#visible-count", state.view === "routes" ? `${visible}経路を表示` : state.view === "heat" ? `${visible}滞在を表示` : `${visible}地点を表示`);
}

function scheduleMapDraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    drawMap();
  });
}

function drawMap() {
  updateLeafletMap();
}

function selectPlace(place) {
  state.selected = { type: "place", value: place };
  renderSelection();
  scheduleMapDraw();
}

function selectJourney(journey) {
  state.selected = { type: "journey", value: journey };
  state.view = "routes";
  syncViewTabs();
  renderSelection();
  scheduleMapDraw();

  if (!leafletMap || !validPoint(journey.startPoint) || !validPoint(journey.endPoint)) return;
  const start = pointToLatLng(journey.startPoint);
  const end = pointToLatLng(journey.endPoint);
  const bounds = L.latLngBounds([start, end]);
  if (bounds.isValid() && !bounds.getNorthEast().equals(bounds.getSouthWest())) {
    leafletMap.fitBounds(bounds.pad(0.32), {
      animate: true,
      duration: 0.65,
      maxZoom: 12,
      paddingTopLeft: [52, 78],
      paddingBottomRight: [52, 58],
    });
  } else {
    leafletMap.setView(start, 12, { animate: true });
  }
}

function renderSelection() {
  const panel = $("#selection-panel");
  const host = $("#selection-content");
  if (!state.selected) {
    panel.hidden = true;
    host.replaceChildren();
    return;
  }
  panel.hidden = false;
  const selected = state.selected;
  if (selected.type === "place") {
    const place = selected.value;
    host.innerHTML = `
      <div class="selection-content-grid">
        <div class="selection-stat"><strong>${place.id}</strong><span>匿名地点ID</span></div>
        <div class="selection-stat"><strong>${place.visits}回</strong><span>訪問</span></div>
        <div class="selection-stat"><strong>${formatDuration(place.durationHours)}</strong><span>滞在合計</span></div>
        <div class="selection-stat"><strong>${place.semantic === "Unknown" ? "未分類" : place.semantic}</strong><span>Google分類</span></div>
      </div>
      <p class="selection-meta">${dateShort.format(place.first)}から${dateShort.format(place.last)}までの表示期間内集計です。</p>
    `;
  } else {
    const journey = selected.value;
    host.innerHTML = `
      <div class="selection-content-grid">
        <div class="selection-stat"><strong>${modeLabel(journey.mode)}</strong><span>推定手段</span></div>
        <div class="selection-stat"><strong>${distanceFormat.format(journey.distanceKm)} km</strong><span>推定距離</span></div>
        <div class="selection-stat"><strong>${formatDuration(journey.durationMinutes / 60)}</strong><span>区間時間</span></div>
        <div class="selection-stat"><strong>${Math.round(journey.probability * 100)}%</strong><span>分類確率</span></div>
      </div>
      <p class="selection-meta">${dateTime.format(journey.start)}から${dateTime.format(journey.end)}。${journey.coarse ? "長時間区間のため推定幅が大きい記録です。" : "Googleの推定区間です。"}</p>
    `;
  }
}

function updateLegend() {
  const host = $("#map-legend");
  host.replaceChildren();
  MODE_ORDER.forEach((mode) => {
    if (!state.modes.has(mode) || !DATA.availableModes.includes(mode)) return;
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = `<span class="legend-line" style="--legend-color:${modeColor(mode)}"></span>${modeLabel(mode)}`;
    host.append(item);
  });
}

function updateAll() {
  current = computeCurrent();
  updateMetrics();
  updateBreakdown();
  updateJourneys();
  updateRhythm();
  updateMonthChart();
  updateLegend();
  renderSelection();
  scheduleMapDraw();
}

function initModes() {
  const pathModes = new Set(DATA.paths.map((path) => path.mode));
  DATA.availableModes = MODE_ORDER.filter((mode) => DATA.modeTotals[mode] || pathModes.has(mode));
  state.modes = new Set(DATA.availableModes.filter((mode) => mode !== "unknown"));
  const host = $("#mode-filters");
  DATA.availableModes.forEach((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mode-filter${state.modes.has(mode) ? " is-active" : ""}`;
    button.dataset.mode = mode;
    button.style.setProperty("--mode-color", modeColor(mode));
    button.setAttribute("aria-pressed", String(state.modes.has(mode)));
    button.textContent = modeLabel(mode);
    button.addEventListener("click", () => {
      if (state.modes.has(mode)) state.modes.delete(mode);
      else state.modes.add(mode);
      button.classList.toggle("is-active", state.modes.has(mode));
      button.setAttribute("aria-pressed", String(state.modes.has(mode)));
      updateAll();
    });
    host.append(button);
  });
}

function setAllModes() {
  state.modes = new Set(DATA.availableModes);
  $$(".mode-filter").forEach((button) => {
    button.classList.add("is-active");
    button.setAttribute("aria-pressed", "true");
  });
  updateAll();
}

function syncViewTabs() {
  $$(".view-tab").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setRange(startDay, endDay) {
  state.startDay = Math.max(0, Math.min(DATA.period.days - 1, startDay));
  state.endDay = Math.max(state.startDay, Math.min(DATA.period.days - 1, endDay));
  $("#range-start").value = String(state.startDay);
  $("#range-end").value = String(state.endDay);
  updateAll();
}

function resetMap() {
  if (!leafletMap || !DATA) return;
  const bounds = L.latLngBounds(
    [DATA.bounds.south, DATA.bounds.west],
    [DATA.bounds.north, DATA.bounds.east],
  );
  if (!bounds.isValid()) return;
  leafletMap.fitBounds(bounds, {
    animate: true,
    duration: 0.65,
    paddingTopLeft: [44, 80],
    paddingBottomRight: [44, 54],
  });
}

function zoomAt(factor) {
  if (!leafletMap) return;
  const delta = factor > 1 ? 1 : -1;
  leafletMap.setZoom(leafletMap.getZoom() + delta, { animate: true });
}

function updateMonthChart() {
  const { width, height } = resizeCanvas(monthCanvas, monthContext, 180);
  monthContext.clearRect(0, 0, width, height);
  const rows = DATA.months;
  const left = 8;
  const right = 8;
  const top = 8;
  const bottom = 27;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const gap = Math.max(4, chartWidth * 0.008);
  const barWidth = Math.max(8, (chartWidth - gap * (rows.length - 1)) / rows.length);
  const max = Math.max(1, ...rows.map((row) => row.distanceKm));
  monthBarRects = [];

  monthContext.strokeStyle = css("--line");
  monthContext.lineWidth = 1;
  monthContext.beginPath();
  monthContext.moveTo(left, top + chartHeight + 0.5);
  monthContext.lineTo(width - right, top + chartHeight + 0.5);
  monthContext.stroke();

  rows.forEach((row, index) => {
    const x = left + index * (barWidth + gap);
    const totalHeight = Math.max(1, (row.distanceKm / max) * chartHeight);
    let y = top + chartHeight;
    const monthStart = Date.parse(`${row.month}-01T00:00:00+09:00`);
    const nextMonthParts = row.month.split("-").map(Number);
    const nextYear = nextMonthParts[1] === 12 ? nextMonthParts[0] + 1 : nextMonthParts[0];
    const nextMonth = nextMonthParts[1] === 12 ? 1 : nextMonthParts[1] + 1;
    const monthEnd = Date.parse(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+09:00`) - 1;
    const inRange = monthEnd >= current.start && monthStart <= current.end;
    MODE_ORDER.forEach((mode) => {
      const distance = row.modes[mode] || 0;
      if (!distance) return;
      const segmentHeight = (distance / row.distanceKm) * totalHeight;
      y -= segmentHeight;
      monthContext.globalAlpha = inRange ? 0.82 : 0.16;
      monthContext.fillStyle = modeColor(mode);
      monthContext.fillRect(x, y, barWidth, Math.max(0.7, segmentHeight));
    });
    monthContext.globalAlpha = 1;
    monthContext.fillStyle = css("--faint");
    monthContext.font = "8px ui-monospace, Menlo, Consolas, monospace";
    monthContext.textAlign = "center";
    monthContext.fillText(row.month.slice(5), x + barWidth / 2, height - 8);
    monthBarRects.push({ x, y: top, width: barWidth, height: chartHeight, row, start: monthStart, end: monthEnd });
  });

  const filteredMonths = rows.filter((row) => {
    const start = Date.parse(`${row.month}-01T00:00:00+09:00`);
    return start <= current.end && start + 32 * DAY_MS >= current.start;
  });
  const peak = [...filteredMonths].sort((a, b) => b.distanceKm - a.distanceKm)[0];
  setText("#month-highlight", peak ? `${peak.month.replace("-", ".")}  ${numberFormat.format(peak.distanceKm)} km` : "-");
}

function initEvents() {
  const startInput = $("#range-start");
  const endInput = $("#range-end");
  const onRange = (source) => {
    let start = Number(startInput.value);
    let end = Number(endInput.value);
    if (start > end) {
      if (source === "start") end = start;
      else start = end;
    }
    setRange(start, end);
  };
  startInput.addEventListener("input", () => onRange("start"));
  endInput.addEventListener("input", () => onRange("end"));
  $("#range-reset").addEventListener("click", () => setRange(0, DATA.period.days - 1));
  $$("[data-range-days]").forEach((button) => {
    button.addEventListener("click", () => {
      const days = Number(button.dataset.rangeDays);
      setRange(Math.max(0, DATA.period.days - days), DATA.period.days - 1);
    });
  });
  $("#modes-all").addEventListener("click", setAllModes);
  $$(".view-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      syncViewTabs();
      scheduleMapDraw();
    });
  });
  $("#map-reset").addEventListener("click", resetMap);
  $("#zoom-in").addEventListener("click", () => zoomAt(1.35));
  $("#zoom-out").addEventListener("click", () => zoomAt(1 / 1.35));
  $("#selection-close").addEventListener("click", () => {
    state.selected = null;
    renderSelection();
  });
  $("#theme-toggle").addEventListener("click", toggleTheme);


  monthCanvas.addEventListener("mousemove", (event) => {
    const rect = monthCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const bar = monthBarRects.find((item) => x >= item.x && x <= item.x + item.width);
    if (bar) setText("#month-highlight", `${bar.row.month.replace("-", ".")}  ${numberFormat.format(bar.row.distanceKm)} km`);
  });
  monthCanvas.addEventListener("mouseleave", updateMonthChart);
  monthCanvas.addEventListener("click", (event) => {
    const rect = monthCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const bar = monthBarRects.find((item) => x >= item.x && x <= item.x + item.width);
    if (!bar) return;
    const startDay = Math.floor((bar.start - DATA.period.start) / DAY_MS);
    const endDay = Math.floor((Math.min(bar.end, DATA.period.end) - DATA.period.start) / DAY_MS);
    setRange(startDay, endDay);
  });

  const resizeObserver = new ResizeObserver(() => {
    scheduleMapDraw();
    updateMonthChart();
  });
  resizeObserver.observe(mapWrap);
  resizeObserver.observe(monthCanvas);
}

function applyInitialTheme() {
  const saved = localStorage.getItem("life-atlas-theme");
  const theme = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = theme;
  setText("#theme-toggle", theme === "dark" ? "Light" : "Dark");
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("life-atlas-theme", next);
  setText("#theme-toggle", next === "dark" ? "Light" : "Dark");
  if (DATA) {
    $$(".mode-filter").forEach((button) => button.style.setProperty("--mode-color", modeColor(button.dataset.mode)));
    updateAll();
  }
}

async function boot() {
  applyInitialTheme();
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`データ取得エラー: HTTP ${response.status}`);
    DATA = await response.json();
    validateData(DATA);
    state.endDay = DATA.period.days - 1;

    setText("#header-period", `${dateShort.format(DATA.period.start)} - ${dateShort.format(DATA.period.end)}`);
    setText("#source-summary", `${DATA.source.recordCount}記録 / ${DATA.summary.pathPoints}座標点 / ${DATA.summary.uniquePlaces}地点`);
    const startInput = $("#range-start");
    const endInput = $("#range-end");
    startInput.max = String(DATA.period.days - 1);
    endInput.max = String(DATA.period.days - 1);
    endInput.value = String(DATA.period.days - 1);

    initModes();
    initEvents();
    updateAll();

    $("#loading").hidden = true;
    $("#app").hidden = false;
    requestAnimationFrame(() => {
      initLeafletMap();
      updateAll();
      resetMap();
    });
  } catch (error) {
    console.error(error);
    $("#loading").hidden = true;
    $("#error-state").hidden = false;
    setText("#error-message", error instanceof Error ? error.message : "不明なエラーです。");
  }
}

boot();
