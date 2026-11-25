import test from "node:test";
import assert from "node:assert/strict";
import { addDays, isValidIso, pickupToPutOut, putOutToPickup, todayBerlin, window7 } from "../../web/js/dates.js";
import { rankStops } from "../../web/js/nearest.js";
import { resolveMapUrl } from "../../web/js/message.js";
import { isStale, lastPickupDate, maxPickupDate, naturalCompare, streetsForPutOut } from "../../web/js/schedule.js";
import { GOOGLE_CHUNK, googleRouteLinks, orderPoints, planRoute } from "../../web/js/routing.js";

test("правило D-1: вывоз AWG 14-го -> выставить 13-го", () => {
  assert.equal(pickupToPutOut("2026-12-14"), "2026-12-13");
  assert.equal(putOutToPickup("2026-12-13"), "2026-12-14");
  assert.equal(pickupToPutOut("2027-01-01"), "2026-12-31");
});

test("даты: валидность, переход через месяц и перевод часов", () => {
  assert.ok(isValidIso("2026-02-28") && !isValidIso("2026-02-30") && !isValidIso("26-1-1"));
  assert.equal(addDays("2026-03-28", 2), "2026-03-30"); // перевод на летнее время
  assert.equal(addDays("2026-10-24", 2), "2026-10-26");
  assert.deepEqual(window7("2026-11-29").slice(-1), ["2026-12-05"]);
  assert.equal(window7("2026-11-29").length, 7);
});

test("сегодня считается по Берлину, а не по UTC", () => {
  // 23:30 UTC 22 ноября = 00:30 23 ноября в Берлине
  assert.equal(todayBerlin(new Date("2026-11-22T23:30:00Z")), "2026-11-23");
});

const SCHEDULE = {
  generated_at: "2026-11-01T00:00:00+00:00",
  streets: {
    Bachstr: { dates: ["2026-11-30"] },
    "Adolf-Vorwerk-Str": { dates: [], houses: { "107a": ["2026-11-30"], 16: ["2026-11-30"], 19: ["2026-12-14"] } },
    Zoo: { dates: ["2026-12-14"] },
  },
};

test("выборка улиц применяет сдвиг и сортирует дома естественно", () => {
  assert.deepEqual(streetsForPutOut(SCHEDULE, "2026-11-29"), [
    { name: "Adolf-Vorwerk-Str", houses: ["16", "107a"] },
    { name: "Bachstr", houses: [] },
  ]);
  assert.deepEqual(streetsForPutOut(SCHEDULE, "2026-11-30"), []);
});

test("покрытие данных и устаревание", () => {
  assert.equal(lastPickupDate(SCHEDULE), "2026-12-14");
  assert.equal(lastPickupDate({ streets: {} }), null);
  // граница публикации из парсера важнее последней даты вывоза
  assert.equal(lastPickupDate({ ...SCHEDULE, covered_until: "2027-04-30" }), "2027-04-30");
  assert.equal(maxPickupDate(SCHEDULE), "2026-12-14");
  assert.ok(isStale(SCHEDULE, Date.parse("2026-12-30T00:00:00Z")));
  assert.ok(!isStale(SCHEDULE, Date.parse("2026-11-20T00:00:00Z")));
  assert.ok(naturalCompare("9", "10") < 0 && naturalCompare("12a", "12b") < 0);
});

test("порядок обхода идёт монотонно от старта", () => {
  const pts = [[51, 7.0], [51, 7.3], [51, 7.1], [51, 7.2]];
  const order = orderPoints(pts, [51, 6.9]);
  assert.deepEqual(order.map((i) => pts[i][1]), [7.0, 7.1, 7.2, 7.3]);
});

test("ссылки Google: <=20 точек, части стыкуются, ничего не теряется", () => {
  const pts = Array.from({ length: 45 }, (_, i) => `Street ${i}, Wuppertal`);
  const links = googleRouteLinks(pts);
  const parts = links.map((l) =>
    l.url.replace("https://www.google.com/maps/dir/", "").replace(/\/$/, "").split("/").map(decodeURIComponent),
  );
  assert.ok(parts.every((p) => p.length <= GOOGLE_CHUNK));
  assert.equal(parts[1][0], parts[0].at(-1));
  assert.deepEqual(new Set(parts.flat()), new Set(pts));
  assert.deepEqual(googleRouteLinks([]), []);
});

test("planRoute: улицы без координат уходят в конец, старт — первой точкой", () => {
  const stops = [{ name: "B" }, { name: "A" }, { name: "Z" }];
  const coords = { A: [51.0, 7.0], B: [51.0, 7.1] };
  const r = planRoute(stops, coords, { start: [51.0, 6.9] });
  assert.deepEqual(r.names, ["A", "B", "Z"]);
  const url = decodeURIComponent(r.links[0].url);
  assert.ok(url.includes("/dir/51,6.9/51,7/51,7.1/Z, Wuppertal/"));
});

import { stopPoints } from "../../web/js/schedule.js";

test("stopPoints: улица целиком, дома с координатами, дома без координат", () => {
  const coords = { Bachstr: [51.2, 7.1], "Alter Markt": [51.3, 7.2], "Alter Markt 5": [51.31, 7.21] };
  assert.deepEqual(stopPoints({ name: "Bachstr", houses: [] }, coords), [{ ll: [51.2, 7.1], label: "Bachstr", houses: [] }]);
  assert.deepEqual(stopPoints({ name: "Alter Markt", houses: ["5", "7"] }, coords), [
    { ll: [51.31, 7.21], label: "Alter Markt 5", houses: ["5"] },
    { ll: [51.3, 7.2], label: "Alter Markt", houses: ["7"] }, // дом без координат: точка улицы
  ]);
  assert.deepEqual(stopPoints({ name: "Нет", houses: [] }, coords), []);
  assert.deepEqual(stopPoints({ name: "Alter Markt", houses: ["7"] }, { "Alter Markt": [1, 2] }), [{ ll: [1, 2], label: "Alter Markt", houses: ["7"] }]);
});

test("Рядом: берётся ближайший дом, а не центр улицы; порядок по расстоянию", () => {
  const coords = {
    "Lange Str": [51.2000, 7.1000], // центр улицы далеко от пользователя
    "Lange Str 1": [51.2000, 7.1000],
    "Lange Str 99": [51.2600, 7.1500], // этот дом рядом с пользователем
    "Kurze Str": [51.2620, 7.1500],
  };
  const stops = [{ name: "Lange Str", houses: ["1", "99"] }, { name: "Kurze Str", houses: [] }, { name: "Без точки", houses: [] }];
  const r = rankStops([51.2601, 7.1500], stops, coords);
  assert.deepEqual(r.map((x) => x.stop.name), ["Lange Str", "Kurze Str"]); // улица без точки пропущена
  assert.equal(r[0].point.label, "Lange Str 99");
  assert.ok(r[0].km < 0.05 && r[1].km > r[0].km);
});

test("Рядом: неверная позиция и NaN-координаты не ломают поиск", () => {
  const stops = [{ name: "A", houses: [] }, { name: "B", houses: [] }];
  assert.deepEqual(rankStops(null, stops, {}), []);
  assert.deepEqual(rankStops([NaN, 7], stops, { A: [51, 7] }), []);
  const r = rankStops([51.25, 7.15], stops, { A: [NaN, 7], B: [51.26, 7.15] });
  assert.deepEqual(r.map((x) => x.stop.name), ["B"]);
});

test("адрес публичной карты: MAP_URL либо map.html рядом с data", () => {
  assert.equal(resolveMapUrl({ MAP_URL: "https://x/m.html" }), "https://x/m.html");
  assert.equal(resolveMapUrl({ DATA_BASE_URL: "https://u.github.io/repo/data/" }), "https://u.github.io/repo/map.html");
  assert.equal(resolveMapUrl({}), "");
});

test("адреса: «str» раскрывается, маршрут строится по координатам, без них по полному адресу", async () => {
  const { expandStreet, waypoint } = await import("../../web/js/address.js");
  assert.equal(expandStreet("Gaußstr"), "Gaußstraße");
  assert.equal(expandStreet("Albert-Einstein-Str"), "Albert-Einstein-Straße");
  assert.equal(expandStreet("Breslauer Str."), "Breslauer Straße");
  assert.equal(expandStreet("Brüderstr"), "Brüderstraße");
  assert.equal(expandStreet("Am Waldschlößchen"), "Am Waldschlößchen");
  assert.equal(waypoint("A", { A: [51.2, 7.1] }, "Wuppertal"), "51.2,7.1");
  assert.equal(waypoint("Amboßstr", {}, "Wuppertal"), "Amboßstraße, Wuppertal");
  const { links } = planRoute([{ name: "Gaußstr" }, { name: "Brüderstr" }], { Gaußstr: [51.25, 7.15] }, {});
  assert.ok(links[0].url.includes("/51.25,7.15/") && links[0].url.includes(encodeURIComponent("Brüderstraße, Wuppertal")));
});

test("пеший маршрут: разбор ответа OSRM и отказоустойчивость", async () => {
  const { parseOsrm, fetchWalkRoute } = await import("../../web/js/walkroute.js");
  const ok = { code: "Ok", routes: [{ distance: 420, duration: 300, geometry: { coordinates: [[7.1, 51.2], [7.11, 51.21]] } }] };
  const r = parseOsrm(ok);
  assert.deepEqual(r.line, [[51.2, 7.1], [51.21, 7.11]]); // lon,lat -> lat,lon
  assert.equal(r.km, 0.42);
  assert.equal(r.minutes, 5);
  assert.equal(parseOsrm({ code: "NoRoute" }), null);
  assert.equal(parseOsrm({ code: "Ok", routes: [{ distance: 1, geometry: { coordinates: [[7, 51]] } }] }), null);
  assert.equal(await fetchWalkRoute([51.2, 7.1], [51.21, 7.11], { fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await fetchWalkRoute([51.2, 7.1], [51.21, 7.11], { fetchImpl: async () => ({ ok: false }) }), null);
  let url = "";
  await fetchWalkRoute([51.2, 7.1], [51.21, 7.11], { fetchImpl: async (u) => { url = u; return { ok: true, json: async () => ok }; } });
  assert.match(url, /\/foot\/7\.1,51\.2;7\.11,51\.21\?/); // OSRM ждёт lon,lat
});
