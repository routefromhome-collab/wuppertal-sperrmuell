// Публичная страница «карта дня»: map.html?d=YYYY-MM-DD, d = день, когда улицы выставляют (правило D-1).
// Без Telegram, без админки и без навигации по датам: ссылка из поста всегда показывает ровно один день.
import { formatLong, isValidIso, putOutToPickup, todayBerlin } from "./dates.js";
import { FAR_AWAY_KM, rankStops } from "./nearest.js";
import { planRoute } from "./routing.js";
import { lastPickupDate, stopPoints, streetsForPutOut } from "./schedule.js";
import { setupSheet } from "./sheet.js";
import { drawWalkRoute } from "./walkroute.js";
import { STREETS, el, externalLink, formatDistance, googlePoint, plural, walkMinutes } from "./ui.js";

const CITY = "Wuppertal";
const CITY_CENTER = [51.2562, 7.1508];
const $ = (id) => document.getElementById(id);

const param = new URLSearchParams(location.search).get("d");
const iso = isValidIso(param) ? param : todayBerlin();

const st = { stops: [], coords: {}, districts: new Map(), query: "", nearby: null, userPos: null, markers: new Map(), hot: [], beyond: false };
let map;
let streetLayer;
let userLayer;
let routeLayer;
let routeToken = 0;
let sheet;
const accent = "#2e7d32";
const STYLE = { radius: 8, color: "#fff", weight: 2, fillOpacity: 0.95, fillColor: accent };
const HOT = { radius: 13, color: "#fff", weight: 3, fillColor: "#e65100", fillOpacity: 1 };

function banner(text, kind = "warn") {
  const b = $("banner");
  b.className = `banner${kind === "error" ? " banner--error" : ""}`;
  b.textContent = text;
  b.hidden = false;
}
let flashTimer;
function flash(text, ms = 6000) {
  banner(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($("banner").hidden = true), ms);
}

function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: false, preferCanvas: true }).setView(CITY_CENTER, 12);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.attribution({ prefix: false }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  streetLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  userLayer = L.layerGroup().addTo(map);
}

function popup(point) {
  const box = el("div", "popup");
  box.append(el("div", "popup__name", point.label));
  if (point.houses.length && !(point.houses.length === 1 && point.label.endsWith(` ${point.houses[0]}`))) box.append(el("div", "popup__houses", `Дома: ${point.houses.join(", ")}`));
  const a = externalLink(el("a", "gm", "🔍 Открыть в Google Maps"));
  a.href = googlePoint(point.ll);
  box.append(a);
  return box;
}

function renderMap() {
  streetLayer.clearLayers();
  st.markers.clear();
  const all = [];
  for (const stop of st.stops) {
    const entries = stopPoints(stop, st.coords).map((point) => {
      const marker = L.circleMarker(point.ll, STYLE).bindPopup(() => popup(point), { maxWidth: 260 }).addTo(streetLayer);
      all.push(point.ll);
      return { marker, point };
    });
    if (entries.length) st.markers.set(stop.name, entries);
  }
  if (all.length) map.fitBounds(all, { padding: [32, 32], maxZoom: 15 });
}

function highlight(entries) {
  st.hot.forEach(({ marker }) => marker.setStyle(STYLE));
  st.hot = entries;
  entries.forEach(({ marker }) => {
    marker.setStyle(HOT);
    marker.bringToFront();
  });
}

function focusStreet(stop, point = null, { fly = true } = {}) {
  document.querySelectorAll(".row").forEach((r) => {
    const on = r.dataset.name === stop.name;
    if (on) {
      r.setAttribute("aria-current", "true");
      r.scrollIntoView({ block: "nearest" });
    } else r.removeAttribute("aria-current");
  });
  const entries = st.markers.get(stop.name) ?? [];
  if (!entries.length) return flash("Для этой улицы пока нет точки на карте.");
  const exact = point ? entries.filter((e) => e.point.label === point.label && e.point.ll[0] === point.ll[0] && e.point.ll[1] === point.ll[1]) : [];
  const target = exact.length ? exact : entries;
  highlight(target);
  const wasMax = sheet.snap === "max";
  if (wasMax) sheet.snapTo("mid");
  setTimeout(() => {
    map.invalidateSize();
    if (!fly) target[0].marker.openPopup();
    else if (target.length === 1) {
      map.flyTo(target[0].marker.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.6 });
      target[0].marker.openPopup();
    } else map.flyToBounds(target.map((e) => e.marker.getLatLng()), { padding: [40, 40], maxZoom: 17, duration: 0.6 });
  }, wasMax ? 250 : 0);
}

function renderList() {
  const total = st.stops.length;
  $("sheetTitle").textContent = st.beyond ? "Нет данных на эту дату" : `${total} ${plural(total, STREETS)}`;
  $("sheetSub").textContent = `Выставить: ${formatLong(iso)} · вывоз AWG: ${formatLong(putOutToPickup(iso))}`;
  $("dayLine").textContent = `Выставить ${formatLong(iso)}, вывоз AWG ${formatLong(putOutToPickup(iso))}`;
  $("routeBtn").hidden = !total;

  const q = st.query.trim().toLocaleLowerCase("de");
  let rows = q ? st.stops.filter((s) => s.name.toLocaleLowerCase("de").includes(q)) : st.stops;
  if (st.nearby) rows = [...rows].sort((a, b) => (st.nearby.get(a.name)?.km ?? Infinity) - (st.nearby.get(b.name)?.km ?? Infinity));
  const list = $("list");
  list.replaceChildren();
  if (!rows.length) {
    const msg = st.beyond ? "Календарь AWG на эту дату пока не опубликован. Это не значит, что вывоза нет." : q ? "Ничего не найдено." : "В этот день вывоза Sperrmüll нет.";
    list.append(el("li", "empty", msg));
    return;
  }
  for (const stop of rows) {
    const li = el("li");
    const row = el("button", "row");
    row.type = "button";
    row.dataset.name = stop.name;
    const near = st.nearby?.get(stop.name);
    if (near) row.append(el("span", "row__dist", formatDistance(near.km)));
    row.append(el("span", "row__name", stop.name));
    const meta = [];
    if (stop.houses.length) meta.push(`дома ${stop.houses.join(", ")}`);
    const d = st.districts.get(stop.name);
    if (d) meta.push(d);
    if (meta.length) row.append(el("span", "row__meta", meta.join(" · ")));
    row.addEventListener("click", () => focusStreet(stop));
    li.append(row);
    list.append(li);
  }
}

const locate = () =>
  new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("unsupported"));
    navigator.geolocation.getCurrentPosition((p) => res([p.coords.latitude, p.coords.longitude]), rej, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 15_000 });
  });

async function showNearest() {
  const btn = $("nearest");
  btn.disabled = true;
  try {
    let pos;
    try {
      pos = await locate();
    } catch {
      return flash("Не удалось определить местоположение. Разрешите доступ к геопозиции в браузере.");
    }
    st.userPos = pos;
    const ranked = rankStops(pos, st.stops, st.coords);
    if (!ranked.length) return flash("Нет улиц с точками на карте.");
    st.nearby = new Map(ranked.map((r) => [r.stop.name, { km: r.km, point: r.point }]));
    st.query = "";
    $("search").value = "";
    userLayer.clearLayers();
    L.circleMarker(pos, { radius: 7, color: "#1a73e8", weight: 3, fillColor: "#fff", fillOpacity: 1 }).bindTooltip("Вы здесь").addTo(userLayer);
    renderList();
    $("list").scrollTop = 0;
    const best = ranked[0];
    const far = best.km > FAR_AWAY_KM;
    focusStreet(best.stop, best.point.houses.length ? best.point : null, { fly: far });
    const label = best.point.label;
    flash(
      far
        ? `Вы далеко: ближайшая точка (${label}) в ${formatDistance(best.km)}.`
        : `Ближайшая: ${label} · ${formatDistance(best.km)} по прямой · ~${walkMinutes(best.km)} мин пешком`,
      60_000,
    );
    if (far) return;
    const token = ++routeToken;
    map.fitBounds([pos, best.point.ll], { padding: [48, 48], maxZoom: 17 });
    const route = await drawWalkRoute({ layer: routeLayer, from: pos, to: best.point.ll, isCurrent: () => token === routeToken, accent });
    if (route) flash(`Ближайшая: ${label} · пешком ${formatDistance(route.km)}${route.minutes ? ` · ~${route.minutes} мин` : ""}`, 15_000);
    else if (token === routeToken) flash(`Ближайшая: ${label} · ${formatDistance(best.km)} по прямой · ~${walkMinutes(best.km)} мин пешком (точный путь не построился)`, 12_000);
  } finally {
    btn.disabled = false;
  }
}

function openRoute() {
  const { names, links } = planRoute(st.stops, st.coords, { city: CITY, start: null });
  $("routeInfo").textContent = `${names.length} ${plural(names.length, STREETS)}, ${links.length} ${plural(links.length, ["часть", "части", "частей"])} (до 20 точек в части).`;
  const box = $("routeLinks");
  box.replaceChildren();
  links.forEach((l, i) => {
    const a = externalLink(el("a", "", `Часть ${i + 1} · ${l.count} точек`));
    a.href = l.url;
    box.append(a);
  });
  $("routeDlg").showModal();
}

async function loadJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function init() {
  sheet = setupSheet({ sheet: $("sheet"), handle: $("sheetToggle"), container: document.querySelector(".main"), onChange: () => map.invalidateSize() });
  initMap();
  $("search").addEventListener("input", (e) => {
    st.query = e.target.value;
    renderList();
  });
  $("nearest").addEventListener("click", showNearest);
  $("routeBtn").addEventListener("click", openRoute);
  try {
    const [schedule, coords, streets] = await Promise.all([loadJson("data/schedule.json"), loadJson("data/coords.json"), loadJson("data/streets.json")]);
    st.coords = coords;
    st.districts = new Map(streets.map((s) => [s.name, s.district]));
    const last = lastPickupDate(schedule);
    st.beyond = last === null || putOutToPickup(iso) > last;
    st.stops = st.beyond ? [] : streetsForPutOut(schedule, iso);
    if (st.beyond) banner("Календарь AWG на эту дату пока не опубликован.");
  } catch (err) {
    console.error(err);
    banner("Не удалось загрузить данные. Обновите страницу позже.", "error");
  }
  renderMap();
  renderList();
}

init();
