import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyInitData } from "../../worker/src/auth.js";
import { handle } from "../../worker/src/index.js";
import { buildDayMessage, chunkText } from "../../web/js/message.js";

const TOKEN = "123456:TEST-token";
const NOW = Date.parse("2026-11-23T10:00:00Z");
const ORIGIN = "https://example.github.io";

/** Подписывает initData так же, как Telegram. */
function signInitData({ user, authDate = NOW / 1000, token = TOKEN, extra = {} }) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "AAH", user: JSON.stringify(user), ...extra });
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(dcs).digest("hex"));
  return params.toString();
}

const ADMIN = { id: 111, first_name: "Admin", username: "boss" };
const GUEST = { id: 222, first_name: "Guest" };

test("initData: валидная подпись принимается", async () => {
  const r = await verifyInitData(signInitData({ user: ADMIN }), TOKEN, { nowMs: NOW });
  assert.ok(r.ok && r.user.id === 111);
});

test("initData: подделка, чужой токен, просрочка, мусор отклоняются", async () => {
  const good = signInitData({ user: ADMIN });
  const tampered = good.replace("%22id%22%3A111", "%22id%22%3A999");
  assert.notEqual(tampered, good);
  assert.equal((await verifyInitData(tampered, TOKEN, { nowMs: NOW })).reason, "bad_signature");
  assert.equal((await verifyInitData(good, "other:token", { nowMs: NOW })).reason, "bad_signature");
  const old = signInitData({ user: ADMIN, authDate: NOW / 1000 - 7200 });
  assert.equal((await verifyInitData(old, TOKEN, { nowMs: NOW, maxAgeSec: 3600 })).reason, "expired");
  assert.equal((await verifyInitData(signInitData({ user: ADMIN, authDate: NOW / 1000 + 3600 }), TOKEN, { nowMs: NOW })).reason, "expired");
  for (const junk of ["", "hash=abc", "a=b", null, undefined, 5]) {
    assert.equal((await verifyInitData(junk, TOKEN, { nowMs: NOW })).ok, false);
  }
});

test("initData: поле signature входит в проверку (как в актуальном Telegram)", async () => {
  const r = await verifyInitData(signInitData({ user: ADMIN, extra: { signature: "xyz", chat_type: "private" } }), TOKEN, { nowMs: NOW });
  assert.ok(r.ok);
});

// ---------- API ----------
const SCHEDULE = {
  generated_at: "2026-11-20T00:00:00+00:00",
  covered_until: "2027-04-30",
  streets: { Achterbergweg: { dates: ["2026-11-30"] }, "Alter Markt": { dates: [], houses: { 5: ["2026-11-30"] } }, "Bachstr & Co": { dates: ["2026-12-01"] } },
};
const COORDS = { Achterbergweg: [51.25, 7.1], "Bachstr & Co": [51.26, 7.12] };

function makeEnv(extra = {}) {
  return { BOT_TOKEN: TOKEN, CHANNEL_ID: "@chan", ADMIN_IDS: "111", ALLOWED_ORIGIN: ORIGIN, DATA_BASE_URL: "https://data.test/data", MINIAPP_URL: "https://t.me/bot/app", ...extra };
}

function makeDeps({ tgFail = null } = {}) {
  const sent = [];
  const fetch = async (url, init) => {
    url = String(url);
    if (url.endsWith("/schedule.json")) return new Response(JSON.stringify(SCHEDULE));
    if (url.endsWith("/coords.json")) return new Response(JSON.stringify(COORDS));
    if (url.startsWith("https://api.telegram.org/")) {
      const body = JSON.parse(init.body);
      if (tgFail && tgFail(body, sent.length)) return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot is not a member" }), { status: 403 });
      sent.push(body);
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response("nope", { status: 404 });
  };
  return { deps: { fetch, now: () => NOW, sleep: async () => {} }, sent };
}

function call(path, payload, { env = makeEnv(), deps, origin = ORIGIN } = {}) {
  const req = new Request(`https://worker.test${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(payload) });
  return handle(req, env, deps ?? makeDeps().deps);
}

const initFor = (user) => signInitData({ user });

test("/api/me: админ и не админ", async () => {
  assert.deepEqual(await (await call("/api/me", { initData: initFor(ADMIN) })).json(), { ok: true, admin: true });
  assert.deepEqual(await (await call("/api/me", { initData: initFor(GUEST) })).json(), { ok: true, admin: false });
});

test("чужой Origin и неверная подпись отклоняются", async () => {
  assert.equal((await call("/api/me", { initData: initFor(ADMIN) }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/api/me", { initData: initFor(ADMIN).replace("hash=", "hash=00") })).status, 401);
});

test("не админ не получает ни preview, ни publish и ничего не уходит в Telegram", async () => {
  const { deps, sent } = makeDeps();
  const a = await call("/api/preview", { initData: initFor(GUEST), start: "2026-11-29" }, { deps });
  const b = await call("/api/publish", { initData: initFor(GUEST), date: "2026-11-29", requestId: "req-12345678" }, { deps });
  assert.deepEqual([a.status, b.status], [403, 403]);
  assert.equal(sent.length, 0);
});

test("preview: 7 дней, правило D-1 и запрет на даты вне календаря", async () => {
  const res = await (await call("/api/preview", { initData: initFor(ADMIN), start: "2026-11-29" })).json();
  assert.equal(res.days.length, 7);
  const byDate = Object.fromEntries(res.days.map((d) => [d.date, d]));
  assert.equal(byDate["2026-11-29"].count, 2); // вывоз 30-го -> выставить 29-го (Achterbergweg + дом на Alter Markt)
  assert.equal(byDate["2026-11-30"].count, 1); // вывоз 1 декабря
  assert.equal(byDate["2026-12-02"].count, 0);
  assert.match(byDate["2026-11-29"].messages.join("\n"), /Шпера 29 November 2026/);
  const far = await (await call("/api/preview", { initData: initFor(ADMIN), start: "2027-06-01", days: 1 })).json();
  assert.equal(far.days[0].canPublish, false);
});

test("publish: отправляет в канал, экранирует HTML, один день за запрос", async () => {
  const { deps, sent } = makeDeps();
  const r = await call("/api/publish", { initData: initFor(ADMIN), date: "2026-11-30", requestId: "req-12345678" }, { deps });
  const out = await r.json();
  assert.ok(out.ok && out.sent === 1 && out.count === 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, "@chan");
  assert.equal(sent[0].parse_mode, "HTML");
  assert.match(sent[0].text, /Bachstr &amp; Co/);
  assert.ok(sent[0].text.includes("startapp=2026-11-30") && sent[0].text.endsWith("#шпера"));
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test("publish: дата вне календаря AWG отклоняется (нет ложного «выходной»)", async () => {
  const { deps, sent } = makeDeps();
  const r = await call("/api/publish", { initData: initFor(ADMIN), date: "2027-06-01", requestId: "req-12345678" }, { deps });
  assert.equal(r.status, 409);
  assert.equal(sent.length, 0);
});

test("publish: повтор с тем же requestId не дублирует пост (KV)", async () => {
  const store = new Map();
  const env = makeEnv({ STATE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) } });
  const { deps, sent } = makeDeps();
  const payload = { initData: initFor(ADMIN), date: "2026-11-30", requestId: "req-12345678" };
  await call("/api/publish", payload, { env, deps });
  const again = await (await call("/api/publish", payload, { env, deps })).json();
  assert.ok(again.duplicate);
  assert.equal(sent.length, 1);
});

test("publish: ошибка Telegram возвращается админу без токена и не помечается выполненной", async () => {
  const store = new Map();
  const env = makeEnv({ STATE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) } });
  const { deps } = makeDeps({ tgFail: () => true });
  const r = await call("/api/publish", { initData: initFor(ADMIN), date: "2026-11-30", requestId: "req-12345678" }, { env, deps });
  const out = await r.json();
  assert.equal(r.status, 502);
  assert.match(out.message, /not a member/);
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  assert.equal(store.size, 0);
});

test("publish: плохие входные данные", async () => {
  const base = { initData: initFor(ADMIN) };
  assert.equal((await call("/api/publish", { ...base, date: "2026-13-40", requestId: "req-12345678" })).status, 400);
  assert.equal((await call("/api/publish", { ...base, date: "2026-11-30" })).status, 400);
  assert.equal((await call("/api/publish", { ...base, date: "2026-11-30", requestId: "x" })).status, 400);
});

test("длинный день режется на части не длиннее 4000 символов", () => {
  const stops = Array.from({ length: 400 }, (_, i) => ({ name: `Teststraße ${i}` }));
  const text = buildDayMessage({ iso: "2026-11-29", stops, coords: {}, miniappUrl: "https://t.me/b/a" });
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 4000));
  assert.equal(chunks.join("\n").replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"));
});

test("формат поста совпадает с рабочим main.py", () => {
  const text = buildDayMessage({ iso: "2026-11-29", stops: [{ name: "Bachstr" }], coords: { Bachstr: [51.25, 7.15] }, miniappUrl: "https://t.me/b/a" });
  assert.match(text, /^🗑 <b>Шпера 29 November 2026:<\/b>\n\nBachstr <a href=".*query=Bachstr%2C%20Wuppertal">map<\/a>/);
  assert.ok(text.includes("\n🗺 Маршрут (часть 1): <a href=\"https://www.google.com/maps/dir/Bachstr%2C%20Wuppertal/\">map</a>"));
  assert.ok(text.includes("\n📍Полная карта на 29 November 2026: <a href=\"https://t.me/b/a?startapp=2026-11-29\">map</a>"));
  assert.equal(buildDayMessage({ iso: "2026-11-29", stops: [], coords: {} }), "✅ 29 November 2026 выходной.\n\n#шпера");
});
