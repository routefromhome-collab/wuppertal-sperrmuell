// Cloudflare Worker: публикация списка улиц в канал из Mini App (только для админов).
//
//   POST /api/me       {initData}                          -> {ok, admin}
//   POST /api/preview  {initData, start, days}             -> {ok, days:[{date, count, canPublish, warnings, messages}]}
//   POST /api/publish  {initData, date, requestId}         -> {ok, sent}   (один день за запрос)
//
// Проверяется подпись Telegram (initData), свежесть и ID пользователя из ADMIN_IDS. Токен бота живёт
// только в секретах Worker. Логика дат (D-1), выборки улиц и маршрутов общая с приложением: web/js.
import { addDays, isValidIso, window7 } from "../../web/js/dates.js";
import { buildDayMessage, chunkText } from "../../web/js/message.js";
import { isStale, lastPickupDate, streetsForPutOut } from "../../web/js/schedule.js";
import { isAdmin, verifyInitData } from "./auth.js";
import { sendMessage } from "./telegram.js";

const MAX_BODY = 4096 + 512;
const MAX_DAYS = 14;
const UUID = /^[0-9a-zA-Z-]{8,64}$/;

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = env.ALLOWED_ORIGIN;
  const h = { vary: "Origin" };
  if (origin && allowed && origin === allowed) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-methods"] = "POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type";
    h["access-control-max-age"] = "600";
  }
  return h;
}

function json(request, env, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(request, env) },
  });
}
const fail = (request, env, status, error, message) => json(request, env, status, { ok: false, error, message });

async function loadData(env, fetchFn) {
  const base = String(env.DATA_BASE_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("DATA_BASE_URL не задан");
  const get = async (name) => {
    const r = await fetchFn(`${base}/${name}`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  };
  const [schedule, coords] = await Promise.all([get("schedule.json"), get("coords.json")]);
  return { schedule, coords };
}

/** Состояние дня: что бы мы опубликовали и можно ли это делать. */
export function describeDay(iso, { schedule, coords }, env, nowMs) {
  const stops = streetsForPutOut(schedule, iso);
  const covered = lastPickupDate(schedule);
  const pickup = addDays(iso, 1);
  const warnings = [];
  let canPublish = true;
  if (covered === null || pickup > covered) {
    canPublish = false;
    warnings.push("Календарь AWG на эту дату не опубликован: пост «выходной» был бы неверным.");
  }
  if (isStale(schedule, nowMs)) warnings.push("Данные расписания старше 45 дней: запустите Update schedule.");
  const text = buildDayMessage({ iso, stops, coords, miniappUrl: env.MINIAPP_URL });
  return { date: iso, count: stops.length, canPublish, warnings, text };
}

async function authenticate(request, env, body, deps, maxAgeSec) {
  const v = await verifyInitData(body.initData, env.BOT_TOKEN, { maxAgeSec, nowMs: deps.now() });
  if (!v.ok) {
    const expired = v.reason === "expired";
    return { error: fail(request, env, 401, expired ? "expired" : "unauthorized", expired ? "Сессия устарела: закройте и откройте приложение заново." : "Не удалось подтвердить Telegram.") };
  }
  return { user: v.user };
}

export async function handle(request, env, deps) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (request.method !== "POST" || !["/api/me", "/api/preview", "/api/publish"].includes(url.pathname)) {
    return fail(request, env, 404, "not_found", "Не найдено.");
  }
  // Только запросы со страницы приложения (CORS защищает браузер; здесь отсекаем чужие источники явно).
  const origin = request.headers.get("origin");
  if (!origin || origin !== env.ALLOWED_ORIGIN) return fail(request, env, 403, "forbidden_origin", "Недопустимый источник.");

  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail(request, env, 413, "too_large", "Слишком большой запрос.");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(request, env, 400, "bad_request", "Некорректный JSON.");
  }

  const isPublish = url.pathname === "/api/publish";
  const auth = await authenticate(request, env, body, deps, isPublish ? 3600 : 86400);
  if (auth.error) return auth.error;
  const admin = isAdmin(env, auth.user);

  if (url.pathname === "/api/me") return json(request, env, 200, { ok: true, admin });
  if (!admin) return fail(request, env, 403, "forbidden", "Нет прав администратора.");

  let data;
  try {
    data = await loadData(env, deps.fetch);
  } catch (e) {
    return fail(request, env, 502, "no_data", `Не удалось загрузить данные расписания: ${e.message}`);
  }

  if (url.pathname === "/api/preview") {
    const days = Math.min(Math.max(Number(body.days) || 7, 1), MAX_DAYS);
    if (!isValidIso(body.start)) return fail(request, env, 400, "bad_request", "Некорректная дата.");
    const out = window7(body.start, days).map((iso) => {
      const d = describeDay(iso, data, env, deps.now());
      return { date: d.date, count: d.count, canPublish: d.canPublish, warnings: d.warnings, messages: chunkText(d.text) };
    });
    return json(request, env, 200, { ok: true, days: out });
  }

  // --- publish: ровно один день ---
  if (!isValidIso(body.date)) return fail(request, env, 400, "bad_request", "Некорректная дата.");
  if (!UUID.test(String(body.requestId ?? ""))) return fail(request, env, 400, "bad_request", "Нужен requestId.");
  if (!env.CHANNEL_ID || !env.BOT_TOKEN) return fail(request, env, 500, "misconfigured", "Не настроены CHANNEL_ID / BOT_TOKEN.");

  const day = describeDay(body.date, data, env, deps.now());
  if (!day.canPublish) return fail(request, env, 409, "no_data", day.warnings[0]);

  // Защита от двойного нажатия и повторов сети: тот же requestId+день не отправляется дважды.
  const doneKey = `done:${body.requestId}:${body.date}`;
  if (env.STATE && (await env.STATE.get(doneKey))) return json(request, env, 200, { ok: true, duplicate: true, sent: 0 });

  const chunks = chunkText(day.text);
  let sent = 0;
  for (const chunk of chunks) {
    const r = await sendMessage(deps.fetch, env.BOT_TOKEN, env.CHANNEL_ID, chunk);
    if (!r.ok) {
      console.error("telegram send failed", r.status, r.description, "chunk", sent + 1, "of", chunks.length);
      return json(request, env, 502, { ok: false, error: "telegram_error", message: `Telegram: ${r.description}. Отправлено частей: ${sent} из ${chunks.length}.`, sent, total: chunks.length });
    }
    sent++;
    if (sent < chunks.length) await deps.sleep(300);
  }
  if (env.STATE) await env.STATE.put(doneKey, String(deps.now()), { expirationTtl: 3600 });

  if (env.ADMIN_CHAT_ID) {
    const who = auth.user.username ? `@${auth.user.username}` : String(auth.user.id);
    await sendMessage(deps.fetch, env.BOT_TOKEN, env.ADMIN_CHAT_ID, `📣 Опубликовано ${body.date} (${day.count} ул.), отправил ${who}`, { html: false });
  }
  return json(request, env, 200, { ok: true, sent, total: chunks.length, count: day.count });
}

export default {
  fetch(request, env) {
    return handle(request, env, {
      fetch: (...a) => fetch(...a),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  },
};
