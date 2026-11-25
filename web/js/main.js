// Telegram Mini App «Шпера Wuppertal»: интерфейс. Логика дат/выборки/маршрутов вынесена в отдельные модули.
import {
  addDays, formatDayNumber, formatLong, formatWeekdayShort, isValidIso, putOutToPickup, todayBerlin, window7,
} from "./dates.js";
import { isStale, lastPickupDate, stopPoints, streetsForPutOut } from "./schedule.js";
import { planRoute } from "./routing.js";
import { haptic, initTelegram, openExternal, setMainButton, startParam } from "./tg.js";
import { FAR_AWAY_KM, accuracyNote, rankStops } from "./nearest.js";
import { setupSheet } from "./sheet.js";
import { drawWalkRoute } from "./walkroute.js";
import { STREETS, el, externalLink, formatDistance, googlePoint, plural, walkMinutes } from "./ui.js";
import { detectAdmin, diagnose, openAdmin } from "./admin.js";

const CITY = "Wuppertal";
const CITY_CENTER = [51.2562, 7.1508];
const $ = (id) => document.getElementById(id);

const state = {
  start: todayBerlin(),
  selected: 0,
  query: "",
  schedule: null,
  coords: {},
  districts: new Map(),
  days: [], // [{iso, stops, beyond}]
  userPos: null,
  markers: new Map(), // имя улицы -> [{marker, point}]
  active: null,
  nearby: null, // Map имя улицы -> {km, point}, пока включена сортировка «Рядом»
  hot: null, // подсвеченный маркер
};
let sheet;

let flashTimer;
function banner(message, { kind = "warn", action } = {}) {
  const b = $("banner");
  clearTimeout(flashTimer);
  b.className = `banner${kind === "error" ? " banner--error" : ""}`;
  b.replaceChildren(document.createTextNode(message));
  if (action) {
    const btn = el("button", "btn", action.label);
    btn.type = "button";
    btn.addEventListener("click", action.run);
    b.append(btn);
  }
  b.hidden = false;
}
function flash(message, ms = 4000) {
  banner(message);
  flashTimer = setTimeout(() => ($("banner").hidden = true), ms);
}
const clearBanner = () => ($("banner").hidden = true);

// ---------- карта ----------
const hasMap = typeof window.L !== "undefined";
let map;
let streetLayer;
let userLayer;
let routeLayer;
let routeToken = 0;
let accent = "#2e7d32";

function initMap() {
  if (!hasMap) {
    $("map").append(el("p", "empty", "Карта недоступна (не загрузилась библиотека). Список и маршруты работают."));
    return;
  }
  map = L.map("map", { zoomControl: false, attributionControl: false, preferCanvas: true }).setView(CITY_CENTER, 12);
  L.control.zoom({ position: "topright" }).addTo(map);
  const attr = L.control.attribution({ prefix: false }).addTo(map);
  attr.getContainer().addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (a) {
      e.preventDefault();
      openExternal(a.href); // иначе ссылка уведёт WebView с приложения
    }
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  streetLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  userLayer = L.layerGroup().addTo(map);
  accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || accent;
}

function popupNode(stop, latlon) {
  const box = el("div", "popup");
  box.append(el("div", "popup__name", stop.name));
  if (stop.houses.length) box.append(el("div", "popup__houses", `Дома: ${stop.houses.join(", ")}`));
  const a = externalLink(el("a", "gm", "🔍 Открыть в Google Maps"));
  a.href = googlePoint(latlon);
  box.append(a);
  return box;
}

const MARKER_STYLE = { radius: 8, color: "#fff", weight: 2, fillOpacity: 0.95 };
const HOT_STYLE = { radius: 13, color: "#fff", weight: 3, fillColor: "#e65100", fillOpacity: 1 };

/** Подсвечивает выбранные маркеры (оранжевый, крупнее) и возвращает остальные к обычному виду. */
function highlight(entries) {
  for (const { marker } of state.hot ?? []) marker.setStyle({ ...MARKER_STYLE, fillColor: accent });
  state.hot = entries;
  for (const { marker } of entries) {
    marker.setStyle(HOT_STYLE);
    marker.bringToFront();
  }
}

function renderMap(stops, { fit }) {
  state.markers.clear();
  if (fit && hasMap) {
    routeToken++;
    routeLayer.clearLayers();
    userLayer.clearLayers();
  }
  state.hot = null;
  if (!hasMap) return;
  streetLayer.clearLayers();
  const points = [];
  for (const stop of stops) {
    // улица целиком: одна точка; улица с отдельными календарями домов: точки по домам (как в старой карте)
    const markers = stopPoints(stop, state.coords).map((p) => {
      const m = L.circleMarker(p.ll, { ...MARKER_STYLE, fillColor: accent });
      m.bindPopup(() => popupNode({ name: p.label, houses: p.houses.length && p.label === stop.name ? p.houses : [] }, p.ll), { maxWidth: 260 });
      m.addTo(streetLayer);
      points.push(p.ll);
      return { marker: m, point: p };
    });
    if (markers.length) state.markers.set(stop.name, markers);
  }
  if (fit && points.length) map.fitBounds(points, { padding: [32, 32], maxZoom: 15 });
  else if (fit) map.setView(CITY_CENTER, 12);
}

// ---------- данные и производные ----------
function computeDays() {
  const last = lastPickupDate(state.schedule);
  state.days = window7(state.start).map((iso) => ({
    iso,
    stops: streetsForPutOut(state.schedule, iso),
    beyond: last === null || putOutToPickup(iso) > last, // календарь AWG ещё не опубликован
  }));
}
const currentDay = () => state.days[state.selected];

function visibleStops() {
  const q = state.query.trim().toLocaleLowerCase("de");
  const all = currentDay()?.stops ?? [];
  return q ? all.filter((s) => s.name.toLocaleLowerCase("de").includes(q)) : all;
}

// ---------- отрисовка ----------
function renderDays() {
  const nav = $("days");
  nav.replaceChildren();
  state.days.forEach((day, i) => {
    const b = el("button", "day");
    b.type = "button";
    b.setAttribute("aria-pressed", String(i === state.selected));
    b.append(
      el("span", "day__wd", formatWeekdayShort(day.iso)),
      el("span", "day__num", formatDayNumber(day.iso)),
      el("span", "day__cnt", day.beyond ? "—" : String(day.stops.length)),
    );
    b.addEventListener("click", () => {
      state.selected = i;
      state.nearby = null;
      state.query = "";
      $("search").value = "";
      haptic();
      render({ fit: true });
    });
    nav.append(b);
  });
}

function renderList(stops) {
  const day = currentDay();
  const list = $("list");
  list.replaceChildren();

  if (!state.schedule) {
    $("sheetTitle").textContent = "Загрузка…";
    $("sheetSub").textContent = "";
    return;
  }
  const total = day.stops.length;
  $("sheetTitle").textContent = day.beyond ? "Нет данных на эту дату" : `${total} ${plural(total, STREETS)}`;
  $("sheetSub").textContent = `Выставить: ${formatLong(day.iso)} · вывоз AWG: ${formatLong(putOutToPickup(day.iso))}`;

  if (!stops.length) {
    const msg = day.beyond
      ? "Календарь AWG на эту дату пока не опубликован. Это не значит, что вывоза нет."
      : state.query
        ? "Ничего не найдено."
        : "В этот день вывоза Sperrmüll нет.";
    list.append(el("li", "empty", msg));
    return;
  }
  const ordered = state.nearby
    ? [...stops].sort((a, b) => (state.nearby.get(a.name)?.km ?? Infinity) - (state.nearby.get(b.name)?.km ?? Infinity))
    : stops;
  for (const stop of ordered) {
    const li = el("li");
    const row = el("button", "row");
    row.type = "button";
    row.dataset.name = stop.name;
    if (stop.name === state.active) row.setAttribute("aria-current", "true");
    const near = state.nearby?.get(stop.name);
    if (near) row.append(el("span", "row__dist", formatDistance(near.km)));
    row.append(el("span", "row__name", stop.name));
    const meta = [];
    if (stop.houses.length) meta.push(`дома ${stop.houses.join(", ")}`);
    const district = state.districts.get(stop.name);
    if (district) meta.push(district);
    if (meta.length) row.append(el("span", "row__meta", meta.join(" · ")));
    if (!stopPoints(stop, state.coords).length) row.append(el("span", "row__meta row__tag", "нет точки на карте"));
    row.addEventListener("click", () => focusStreet(stop));
    li.append(row);
    list.append(li);
  }
}

function renderActions() {
  const n = currentDay()?.stops.length ?? 0;
  const usable = n > 0;
  const handled = setMainButton(usable ? `🗺 Маршрут · ${n}` : "", openRoute);
  $("routeBtn").hidden = handled || !usable;
}

function render({ fit = false } = {}) {
  if (!state.schedule) return;
  const stops = visibleStops();
  renderDays();
  renderList(stops);
  renderMap(stops, { fit });
  renderActions();
}

function setStart(iso, { keepSelection = false } = {}) {
  if (!isValidIso(iso)) return;
  state.start = iso;
  state.nearby = null;
  if (!keepSelection) state.selected = 0;
  $("date").value = iso;
  computeDays();
  render({ fit: true });
}

// ---------- действия ----------
/** Показывает улицу/дом на карте и подсвечивает маркер и строку списка. point: конкретный дом (из «Рядом»). */
function focusStreet(stop, point = null, { fly = true } = {}) {
  state.active = stop.name;
  document.querySelectorAll(".row").forEach((r) => {
    const on = r.dataset.name === stop.name;
    if (on) {
      r.setAttribute("aria-current", "true");
      r.scrollIntoView({ block: "nearest" });
    } else r.removeAttribute("aria-current");
  });
  const entries = state.markers.get(stop.name) ?? [];
  if (!entries.length || !hasMap) {
    flash("Для этой улицы пока нет точки на карте.");
    return;
  }
  const chosen = point ? entries.filter((e) => e.point.ll[0] === point.ll[0] && e.point.ll[1] === point.ll[1] && e.point.label === point.label) : entries;
  const target = chosen.length ? chosen : entries;
  highlight(target);
  const wasMax = sheet.snap === "max";
  if (wasMax) sheet.snapTo("mid"); // чтобы карта была видна; список остаётся на экране
  setTimeout(() => {
    map.invalidateSize();
    if (!fly) target[0].marker.openPopup();
    else if (target.length === 1) {
      map.flyTo(target[0].marker.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.6 });
      target[0].marker.openPopup();
    } else {
      map.flyToBounds(target.map((e) => e.marker.getLatLng()), { padding: [40, 40], maxZoom: 17, duration: 0.6 });
    }
  }, wasMax ? 250 : 0);
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("unsupported"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(Object.assign([p.coords.latitude, p.coords.longitude], { accuracy: p.coords.accuracy })),
      reject,
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 15_000 },
    );
  });
}

async function showNearest() {
  const btn = $("nearest");
  btn.disabled = true;
  try {
    let pos;
    try {
      pos = await locate();
    } catch {
      flash("Не удалось определить местоположение. Разрешите доступ к геопозиции.");
      return;
    }
    state.userPos = pos;
    // ищем по всем улицам выбранного дня, а не только по найденным поиском: «ближайшая» не должна зависеть от фильтра
    const ranked = rankStops(pos, currentDay()?.stops ?? [], state.coords);
    if (!ranked.length) {
      flash("На выбранный день нет улиц с точками на карте.");
      return;
    }
    state.nearby = new Map(ranked.map((r) => [r.stop.name, { km: r.km, point: r.point }]));
    state.query = "";
    $("search").value = "";
    if (hasMap) {
      userLayer.clearLayers();
      if (pos.accuracy > 50) L.circle(pos, { radius: pos.accuracy, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(userLayer);
      L.circleMarker(pos, { radius: 7, color: "#1a73e8", weight: 3, fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip("Вы здесь")
        .addTo(userLayer);
    }
    render();
    $("list").scrollTop = 0;
    const best = ranked[0];
    const far = best.km > FAR_AWAY_KM;
    const note = accuracyNote(pos.accuracy);
    focusStreet(best.stop, best.point.houses.length ? best.point : null, { fly: far });
    haptic("medium");
    const label = best.point.label;
    flash(
      far
        ? `${note}Вы далеко: ближайшая точка (${label}) в ${formatDistance(best.km)}. Проверьте геопозицию.`
        : `${note}Ближайшая: ${label} · ${formatDistance(best.km)} по прямой · ~${walkMinutes(best.km)} мин пешком`,
      60_000,
    );
    if (far || !hasMap) return;
    // маршрут к ближайшей точке: сначала пунктир, затем настоящий пеший путь
    const token = ++routeToken;
    map.fitBounds([pos, best.point.ll], { padding: [48, 48], maxZoom: 17 });
    const route = await drawWalkRoute({ layer: routeLayer, from: pos, to: best.point.ll, isCurrent: () => token === routeToken, accent });
    if (route) flash(`${note}Ближайшая: ${label} · пешком ${formatDistance(route.km)}${route.minutes ? ` · ~${route.minutes} мин` : ""}`, 15_000);
    else if (token === routeToken) flash(`${note}Ближайшая: ${label} · ${formatDistance(best.km)} по прямой · ~${walkMinutes(best.km)} мин пешком (точный путь не построился)`, 12_000);
  } finally {
    btn.disabled = false;
  }
}

function buildRoute() {
  const day = currentDay();
  const start = $("routeFromMe").checked ? state.userPos : null;
  const { names, links } = planRoute(day.stops, state.coords, { city: CITY, start });
  const missing = day.stops.filter((s) => !state.coords[s.name]).length;
  const parts = links.length;
  $("routeInfo").textContent =
    `${names.length} ${plural(names.length, STREETS)}, ${parts} ${plural(parts, ["часть", "части", "частей"])} ` +
    `(до 20 точек в части). Порядок оптимизирован.` +
    (missing ? ` ${missing} без точки на карте добавлены в конец.` : "");
  const box = $("routeLinks");
  box.replaceChildren();
  links.forEach((l, i) => {
    const a = externalLink(el("a", "", `Часть ${i + 1} · ${l.count} точек`));
    a.href = l.url;
    box.append(a);
  });
}

function openRoute() {
  if (!currentDay()?.stops.length) return;
  $("routeFromMe").checked = false;
  buildRoute();
  $("routeDlg").showModal();
}

// ---------- запуск ----------
async function loadJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function loadData() {
  try {
    const [schedule, coords, streets] = await Promise.all([
      loadJson("data/schedule.json"),
      loadJson("data/coords.json"),
      loadJson("data/streets.json"),
    ]);
    state.schedule = schedule;
    state.coords = coords;
    state.districts = new Map(streets.map((s) => [s.name, s.district]));
  } catch (err) {
    console.error(err);
    banner("Не удалось загрузить данные.", { kind: "error", action: { label: "Повторить", run: init } });
    return false;
  }
  clearBanner();
  if (lastPickupDate(state.schedule) === null) {
    banner("Данные календаря пока не загружены. Загляните позже.");
  } else if (isStale(state.schedule)) {
    banner(`Данные обновлялись ${state.schedule.generated_at.slice(0, 10)}, возможны неточности.`);
  }
  return true;
}

async function init() {
  if (await loadData()) {
    computeDays();
    render({ fit: true });
  }
}

async function setupAdmin() {
  const admin = await detectAdmin();
  if (admin) {
    $("adminBtn").hidden = false;
    $("adminBtn").addEventListener("click", () => openAdmin({ start: state.start, days: 7, canUpdate: admin.canUpdate, canManage: admin.canManage }));
  }
}

function bindUi() {
  $("date").value = state.start;
  $("date").addEventListener("change", (e) => setStart(e.target.value));
  $("prev").addEventListener("click", () => setStart(addDays(state.start, -1)));
  $("next").addEventListener("click", () => setStart(addDays(state.start, 1)));
  $("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });
  $("nearest").addEventListener("click", showNearest);
  sheet = setupSheet({
    sheet: $("sheet"),
    handle: $("sheetToggle"),
    container: document.querySelector(".main"),
    onChange: () => hasMap && map.invalidateSize(),
  });
  // 5 нажатий на заголовок за 3 секунды: диагностика админ-панели (показывает только данные самого пользователя)
  let taps = [];
  document.querySelector(".top__title").addEventListener("click", async (e) => {
    if (e.target.closest("#adminBtn")) return;
    const now = Date.now();
    taps = [...taps.filter((t) => now - t < 3000), now];
    if (taps.length < 5) return;
    taps = [];
    banner("Проверяю…");
    banner((await diagnose()).join("\n"), { action: { label: "Закрыть", run: clearBanner } });
  });
  $("routeBtn").addEventListener("click", openRoute);
  $("routeFromMe").addEventListener("change", async (e) => {
    if (e.target.checked && !state.userPos) {
      try {
        state.userPos = await locate();
      } catch {
        e.target.checked = false;
        $("routeInfo").textContent = "Не удалось определить местоположение.";
        return;
      }
    }
    buildRoute();
  });
}

initTelegram();
const sp = startParam();
if (sp && isValidIso(sp)) state.start = sp;
bindUi();
initMap();
init();
setupAdmin();
