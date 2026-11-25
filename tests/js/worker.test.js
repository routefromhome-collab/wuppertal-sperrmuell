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
  return { BOT_TOKEN: TOKEN, CHANNEL_ID: "@chan", ADMIN_IDS: "111", ALLOWED_ORIGIN: ORIGIN, DATA_BASE_URL: "https://data.test/data", MAP_URL: "https://site.test/map.html", ...extra };
}

const PROFILES_TG = { 222333444: { id: 222333444, first_name: "Ivan", last_name: "Petrov", username: "ivan_p" } };

function makeDeps({ tgFail = null, runs = [], dispatchStatus = 204 } = {}) {
  const sent = [];
  const gh = [];
  const fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith("https://api.github.com/")) {
      gh.push({ url, method: init?.method ?? "GET", headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null });
      if (url.includes("/runs")) return new Response(JSON.stringify({ workflow_runs: runs }));
      if (url.endsWith("/dispatches")) return new Response(dispatchStatus === 204 ? null : JSON.stringify({ message: "Not Found" }), { status: dispatchStatus });
    }
    if (url.endsWith("/schedule.json")) return new Response(JSON.stringify(SCHEDULE));
    if (url.endsWith("/coords.json")) return new Response(JSON.stringify(COORDS));
    if (url.startsWith("https://api.telegram.org/") && url.includes("/getChat")) {
      const id = new URL(url).searchParams.get("chat_id");
      return PROFILES_TG[id] ? new Response(JSON.stringify({ ok: true, result: PROFILES_TG[id] })) : new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });
    }
    if (url.startsWith("https://api.telegram.org/")) {
      const body = JSON.parse(init.body);
      if (tgFail && tgFail(body, sent.length)) return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot is not a member" }), { status: 403 });
      sent.push(body);
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response("nope", { status: 404 });
  };
  return { deps: { fetch, now: () => NOW, sleep: async () => {} }, sent, gh };
}

function call(path, payload, { env = makeEnv(), deps, origin = ORIGIN } = {}) {
  const req = new Request(`https://worker.test${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(payload) });
  return handle(req, env, deps ?? makeDeps().deps);
}

const initFor = (user) => signInitData({ user });

test("/api/me: админ и не админ", async () => {
  assert.deepEqual(await (await call("/api/me", { initData: initFor(ADMIN) })).json(), { ok: true, admin: true, canUpdate: false, canManage: false });
  assert.deepEqual(await (await call("/api/me", { initData: initFor(GUEST) })).json(), { ok: true, admin: false, canUpdate: false, canManage: false });
  const withGh = makeEnv({ GH_TOKEN: "ghp_secret", GITHUB_REPO: "o/r" });
  assert.equal((await (await call("/api/me", { initData: initFor(ADMIN) }, { env: withGh })).json()).canUpdate, true);
  assert.equal((await (await call("/api/me", { initData: initFor(GUEST) }, { env: withGh })).json()).canUpdate, false);
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
  assert.ok(sent[0].text.includes("map.html?d=2026-11-30") && sent[0].text.endsWith("#шпера"));
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
  const text = buildDayMessage({ iso: "2026-11-29", stops, coords: {}, mapUrl: "https://site.test/map.html" });
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 4000));
  assert.equal(chunks.join("\n").replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"));
});

test("формат поста совпадает с рабочим main.py", () => {
  const text = buildDayMessage({ iso: "2026-11-29", stops: [{ name: "Bachstr" }], coords: { Bachstr: [51.25, 7.15] }, mapUrl: "https://site.test/map.html" });
  assert.match(text, /^🗑 <b>Шпера 29 November 2026:<\/b>\n\nBachstr <a href=".*query=Bachstra%C3%9Fe%2C%20Wuppertal">map<\/a>/);
  assert.ok(text.includes("\n🗺 Маршрут (часть 1): <a href=\"https://www.google.com/maps/dir/51.25,7.15/\">map</a>"));
  assert.ok(text.includes("\n📍Полная карта на 29 November 2026: <a href=\"https://site.test/map.html?d=2026-11-29\">map</a>"));
  assert.equal(buildDayMessage({ iso: "2026-11-29", stops: [], coords: {} }), "✅ 29 November 2026 выходной.\n\n#шпера");
});


// ---------- тест, статус и запуск обновления ----------
test("test=true уходит в ADMIN_CHAT_ID, а не в канал, и не помечает день выполненным", async () => {
  const store = new Map();
  const env = makeEnv({ ADMIN_CHAT_ID: "999", STATE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) } });
  const { deps, sent } = makeDeps();
  const payload = { initData: initFor(ADMIN), date: "2026-11-30", requestId: "req-12345678", test: true };
  const out = await (await call("/api/publish", payload, { env, deps })).json();
  assert.ok(out.ok && out.test);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, "999");
  assert.ok(sent[0].text.startsWith("🧪 ТЕСТ"));
  assert.equal(store.size, 0);
  // после теста настоящая публикация с тем же requestId проходит и идёт в канал
  const real = await (await call("/api/publish", { ...payload, test: false }, { env, deps })).json();
  assert.ok(real.ok && !real.duplicate);
  assert.equal(sent.at(-2).chat_id, "@chan");
});

test("test=true без ADMIN_CHAT_ID: отказ, канал не затронут", async () => {
  const { deps, sent } = makeDeps();
  const r = await call("/api/publish", { initData: initFor(ADMIN), date: "2026-11-30", requestId: "req-12345678", test: true }, { deps });
  assert.equal(r.status, 500);
  assert.equal(sent.length, 0);
});

test("test разрешён и на дату вне календаря (это только проверка), публикация в канал нет", async () => {
  const env = makeEnv({ ADMIN_CHAT_ID: "999" });
  const { deps, sent } = makeDeps();
  const base = { initData: initFor(ADMIN), date: "2027-06-01", requestId: "req-12345678" };
  assert.equal((await call("/api/publish", { ...base, test: true }, { env, deps })).status, 200);
  assert.equal((await call("/api/publish", base, { env, deps })).status, 409);
  assert.deepEqual(sent.map((m) => m.chat_id), ["999"]);
});

const GH_ENV = { GH_TOKEN: "ghp_secret", GITHUB_REPO: "o/r", ADMIN_CHAT_ID: "999" };

test("update: запускает workflow с нужными параметрами; токен GitHub не утекает", async () => {
  const { deps, gh } = makeDeps();
  const r = await call("/api/update", { initData: initFor(ADMIN), force: true, quick: true }, { env: makeEnv(GH_ENV), deps });
  const out = await r.json();
  assert.ok(out.ok && out.limit === 20 && out.force === true);
  const d = gh.find((c) => c.url.endsWith("/actions/workflows/update-schedule.yml/dispatches"));
  assert.equal(d.method, "POST");
  assert.deepEqual(d.body, { ref: "main", inputs: { force: "true", limit: "20" } });
  assert.equal(d.headers.authorization, "Bearer ghp_secret");
  assert.ok(!JSON.stringify(out).includes("ghp_secret"));
  const full = makeDeps();
  await call("/api/update", { initData: initFor(ADMIN) }, { env: makeEnv(GH_ENV), deps: full.deps });
  assert.deepEqual(full.gh.at(-1).body.inputs, { force: "false", limit: "" });
});

test("update: не админ, нет GH_TOKEN, уже идёт запуск, ошибка GitHub", async () => {
  const guest = makeDeps();
  assert.equal((await call("/api/update", { initData: initFor(GUEST) }, { env: makeEnv(GH_ENV), deps: guest.deps })).status, 403);
  assert.equal(guest.gh.length, 0);

  assert.equal((await call("/api/update", { initData: initFor(ADMIN) })).status, 501);

  const busy = makeDeps({ runs: [{ status: "in_progress", conclusion: null }] });
  const b = await call("/api/update", { initData: initFor(ADMIN) }, { env: makeEnv(GH_ENV), deps: busy.deps });
  assert.equal(b.status, 409);
  assert.ok(!busy.gh.some((c) => c.url.endsWith("/dispatches")));

  const bad = makeDeps({ dispatchStatus: 404 });
  const e = await call("/api/update", { initData: initFor(ADMIN) }, { env: makeEnv(GH_ENV), deps: bad.deps });
  const out = await e.json();
  assert.equal(e.status, 502);
  assert.match(out.message, /не найден/);
  assert.ok(!JSON.stringify(out).includes("ghp_secret"));
});

test("status: возраст данных и последний запуск; для не админа закрыт", async () => {
  const run = { status: "completed", conclusion: "success", created_at: "2026-11-24T10:00:00Z", updated_at: "2026-11-24T10:20:00Z", html_url: "https://github.com/o/r/actions/runs/1", event: "workflow_dispatch" };
  const { deps } = makeDeps({ runs: [run] });
  const out = await (await call("/api/status", { initData: initFor(ADMIN) }, { env: makeEnv(GH_ENV), deps })).json();
  assert.equal(out.schedule.streets, 3);
  assert.equal(out.schedule.covered_until, "2027-04-30");
  assert.equal(out.schedule.with_data, 3);
  assert.equal(out.run.conclusion, "success");
  assert.equal(out.canUpdate, true);
  const noGh = await (await call("/api/status", { initData: initFor(ADMIN) }, { deps: makeDeps().deps })).json();
  assert.equal(noGh.canUpdate, false);
  assert.equal(noGh.run, null);
  assert.equal((await call("/api/status", { initData: initFor(GUEST) }, { env: makeEnv(GH_ENV), deps: makeDeps({ runs: [run] }).deps })).status, 403);
});

test("отказ подписи объясняет причину; без BOT_TOKEN понятная ошибка", async () => {
  const wrongToken = signInitData({ user: ADMIN, token: "999:another-bot" });
  const r = await call("/api/me", { initData: wrongToken });
  const out = await r.json();
  assert.equal(r.status, 401);
  assert.deepEqual([out.error, out.reason], ["unauthorized", "bad_signature"]);
  const noToken = await call("/api/me", { initData: initFor(ADMIN) }, { env: makeEnv({ BOT_TOKEN: "" }) });
  assert.equal(noToken.status, 500);
  assert.match((await noToken.json()).message, /BOT_TOKEN/);
  const old = await (await call("/api/me", { initData: signInitData({ user: ADMIN, authDate: NOW / 1000 - 999999 }) })).json();
  assert.equal(old.error, "expired");
});

const kvEnv = (extra = {}) => {
  const store = new Map();
  return makeEnv({ STATE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) }, ...extra });
};

test("админы из приложения: добавить, пользоваться правами, удалить; владельца удалить нельзя", async () => {
  const env = kvEnv();
  const NEW = { id: 222333444, first_name: "New" };
  // до добавления прав нет
  assert.equal((await (await call("/api/me", { initData: initFor(NEW) }, { env })).json()).admin, false);
  // не админ не может управлять
  assert.equal((await call("/api/admins/add", { initData: initFor(NEW), id: "222333444" }, { env })).status, 403);
  await call("/api/me", { initData: initFor(ADMIN) }, { env }); // Worker запоминает ник владельца
  // админ добавляет
  const add = await call("/api/admins/add", { initData: initFor(ADMIN), id: " 222333444 " }, { env });
  const added = await add.json();
  assert.equal(add.status, 200);
  assert.deepEqual(added.extra.map((a) => [a.id, a.by]), [["222333444", "111"]]);
  // теперь новый пользователь админ и сам может управлять списком
  const me = await (await call("/api/me", { initData: initFor(NEW) }, { env })).json();
  assert.deepEqual([me.admin, me.canManage], [true, true]);
  const list = await (await call("/api/admins", { initData: initFor(NEW) }, { env })).json();
  assert.deepEqual([list.owners.map((o) => o.id), list.me], [["111"], "222333444"]);
  // ники: у нового админа через getChat, у владельца запомнен, когда он сам открыл приложение
  assert.equal(added.extra[0].label, "@ivan_p"); // сразу после добавления имя берётся через getChat
  assert.equal(list.extra[0].label, "New"); // потом обновляется профилем, который прислал сам пользователь
  assert.equal(list.owners[0].label, "@boss");
  assert.equal(list.extra[0].byLabel, "@boss");
  // повторное добавление безвредно; владельца удалить нельзя
  assert.equal((await (await call("/api/admins/add", { initData: initFor(ADMIN), id: "222333444" }, { env })).json()).already, true);
  const own = await call("/api/admins/remove", { initData: initFor(NEW), id: "111" }, { env });
  assert.equal(own.status, 409);
  // удаление
  const rm = await call("/api/admins/remove", { initData: initFor(ADMIN), id: "222333444" }, { env });
  assert.equal((await rm.json()).extra.length, 0);
  assert.equal((await (await call("/api/me", { initData: initFor(NEW) }, { env })).json()).admin, false);
});

test("админы из приложения: проверка ID и отсутствие KV", async () => {
  const env = kvEnv();
  for (const bad of ["abc", "12", "1234567890123456", "1 2 3 4 5", ""]) {
    const r = await call("/api/admins/add", { initData: initFor(ADMIN), id: bad }, { env });
    assert.equal(r.status, 400, bad);
  }
  const noKv = await call("/api/admins/add", { initData: initFor(ADMIN), id: "222333444" });
  assert.equal(noKv.status, 501);
  assert.equal((await (await call("/api/me", { initData: initFor(ADMIN) })).json()).canManage, false);
});
