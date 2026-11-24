// Telegram Mini App «Шпера Wuppertal»: интерфейс. Логика дат/выборки/маршрутов вынесена в отдельные модули.
import {
  addDays, formatDayNumber, formatLong, formatWeekdayShort, isValidIso, putOutToPickup, todayBerlin, window7,
} from "./dates.js";
import { isStale, lastPickupDate, stopPoints, streetsForPutOut } from "./schedule.js";
import { haversineKm, planRoute } from "./routing.js";
import { haptic, initTelegram, openChannel, openExternal, setMainButton, startParam } from "./tg.js";
import { CHANNEL_URL } from "../config.js";
import { detectAdmin, openAdmin } from "./admin.js";

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
  markers: new Map(),
  active: null,
};

// ---------- мелкие помощники ----------
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const plural = (n, [one, few, many]) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};
const STREETS = ["улица", "улицы", "улиц"];
const googlePoint = ([lat, lon]) => `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;

function externalLink(a) {
  a.target = "_blank";
  a.rel = "noopener";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    openExternal(a.href);
  });
  return a;
}

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

function renderMap(stops, { fit }) {
  state.markers.clear();
  if (!hasMap) return;
  streetLayer.clearLayers();
  const points = [];
  for (const stop of stops) {
    // улица целиком: одна точка; улица с отдельными календарями домов: точки по домам (как в старой карте)
    const markers = stopPoints(stop, state.coords).map((p) => {
      const m = L.circleMarker(p.ll, { radius: 8, color: "#fff", weight: 2, fillColor: accent, fillOpacity: 0.95 });
      m.bindPopup(() => popupNode({ name: p.label, houses: p.houses.length && p.label === stop.name ? p.houses : [] }, p.ll), { maxWidth: 260 });
      m.addTo(streetLayer);
      points.push(p.ll);
      return m;
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
  for (const stop of stops) {
    const li = el("li");
    const row = el("button", "row");
    row.type = "button";
    row.dataset.name = stop.name;
    if (stop.name === state.active) row.setAttribute("aria-current", "true");
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
  if (!keepSelection) state.selected = 0;
  $("date").value = iso;
  computeDays();
  render({ fit: true });
}

// ---------- действия ----------
function setCollapsed(collapsed) {
  $("sheet").dataset.collapsed = String(collapsed);
  $("sheetToggle").setAttribute("aria-expanded", String(!collapsed));
  if (hasMap) setTimeout(() => map.invalidateSize(), 230);
}

function focusStreet(stop) {
  state.active = stop.name;
  const markers = state.markers.get(stop.name) ?? [];
  document.querySelectorAll(".row").forEach((r) => {
    if (r.dataset.name === stop.name) r.setAttribute("aria-current", "true");
    else r.removeAttribute("aria-current");
  });
  if (!markers.length || !hasMap) {
    flash("Для этой улицы пока нет точки на карте.");
    return;
  }
  setCollapsed(true);
  if (markers.length === 1) {
    map.flyTo(markers[0].getLatLng(), Math.max(map.getZoom(), 16), { duration: 0.6 });
    markers[0].openPopup();
  } else {
    map.flyToBounds(markers.map((m) => m.getLatLng()), { padding: [40, 40], maxZoom: 17, duration: 0.6 });
  }
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("unsupported"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.latitude, p.coords.longitude]),
      reject,
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

async function showNearest() {
  let pos;
  try {
    pos = await locate();
  } catch {
    flash("Не удалось определить местоположение. Разрешите доступ к геопозиции.");
    return;
  }
  state.userPos = pos;
  const candidates = (currentDay()?.stops ?? []).filter((s) => stopPoints(s, state.coords).length);
  if (!candidates.length) {
    flash("На выбранный день нет улиц с точками на карте.");
    return;
  }
  const best = candidates
    .map((s) => ({ s, km: Math.min(...stopPoints(s, state.coords).map((p) => haversineKm(pos, p.ll))) }))
    .reduce((a, b) => (b.km < a.km ? b : a));
  const meters = Math.round(best.km * 1000);
  const minutes = Math.max(1, Math.round((best.km / 5) * 60));
  if (hasMap) {
    userLayer.clearLayers();
    L.circleMarker(pos, { radius: 7, color: "#333", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip("Вы здесь")
      .addTo(userLayer);
  }
  focusStreet(best.s);
  flash(`Ближайшая: ${best.s.name} · ${meters} м по прямой · ~${minutes} мин пешком`, 7000);
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
    $("adminBtn").addEventListener("click", () => openAdmin({ start: state.start, days: 7, canUpdate: admin.canUpdate }));
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
  $("sheetToggle").addEventListener("click", () => setCollapsed($("sheet").dataset.collapsed !== "true"));
  $("nearest").addEventListener("click", showNearest);
  $("promo").addEventListener("click", (e) => {
    e.preventDefault();
    openChannel(CHANNEL_URL);
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
