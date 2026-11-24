// Cloudflare Worker: публикация списка улиц в канал из Mini App (только для админов).
//
//   POST /api/me       {initData}                          -> {ok, admin}
//   POST /api/preview  {initData, start, days}             -> {ok, days:[{date, count, canPublish, warnings, messages}]}
//   POST /api/publish  {initData, date, requestId, test?}  -> {ok, sent}   (один день за запрос; test=true: в ADMIN_CHAT_ID, не в канал)
//   POST /api/status   {initData}                          -> {ok, schedule, run, canUpdate}   (возраст данных, последний запуск Update schedule)
//   POST /api/update   {initData, force?, quick?}          -> {ok}         (запускает workflow Update schedule в GitHub)
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
  if (!env.BOT_TOKEN) {
    console.error("BOT_TOKEN не задан");
    return { error: fail(request, env, 500, "misconfigured", "В Worker не задан BOT_TOKEN.") };
  }
  const v = await verifyInitData(body.initData, env.BOT_TOKEN, { maxAgeSec, nowMs: deps.now() });
  if (!v.ok) {
    console.warn("подпись Telegram не принята:", v.reason);
    const expired = v.reason === "expired";
    // reason безопасен для показа: подделать подпись он не помогает, а админу сразу видно причину
    return {
      error: json(request, env, 401, {
        ok: false,
        error: expired ? "expired" : "unauthorized",
        reason: v.reason,
        message: expired ? "Сессия устарела: закройте и откройте приложение заново." : "Не удалось подтвердить Telegram.",
      }),
    };
  }
  return { user: v.user };
}

// ---------- запуск обновления расписания (GitHub Actions) ----------
const WORKFLOW = "update-schedule.yml";
const ACTIVE_RUN = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const canUpdate = (env) => Boolean(env.GH_TOKEN && env.GITHUB_REPO);

function github(env, deps, path, init = {}) {
  return deps.fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GH_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "sperrmuell-admin-worker",
      ...(init.headers ?? {}),
    },
  });
}

function githubError(res, data) {
  if (res.status === 401 || res.status === 403) return "GitHub отклонил токен: проверьте GH_TOKEN (нужно право Actions: Read and write на этот репозиторий).";
  if (res.status === 404) return "GitHub: репозиторий или workflow не найден (проверьте GITHUB_REPO и права токена).";
  return `GitHub: ${String(data?.message ?? res.status)}`;
}

async function latestRun(env, deps) {
  const res = await github(env, deps, `/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: githubError(res, data) };
  const r = data.workflow_runs?.[0];
  if (!r) return { run: null };
  return { run: { status: r.status, conclusion: r.conclusion, created_at: r.created_at, updated_at: r.updated_at, html_url: r.html_url, event: r.event } };
}

async function status(request, env, deps) {
  let schedule = null;
  try {
    const base = String(env.DATA_BASE_URL ?? "").replace(/\/$/, "");
    const r = await deps.fetch(`${base}/schedule.json`, { cf: { cacheTtl: 30, cacheEverything: true } });
    if (r.ok) {
      const s = await r.json();
      const streets = Object.values(s.streets ?? {});
      schedule = { generated_at: s.generated_at ?? null, covered_until: s.covered_until ?? null, streets: streets.length, with_data: streets.filter((e) => e.dates?.length || Object.keys(e.houses ?? {}).length).length };
    }
  } catch {
    /* данные недоступны: покажем null */
  }
  const out = { ok: true, schedule, canUpdate: canUpdate(env), run: null };
  if (canUpdate(env)) {
    const l = await latestRun(env, deps);
    if (l.error) out.runError = l.error;
    else out.run = l.run;
  }
  return json(request, env, 200, out);
}

async function update(request, env, deps, body, user) {
  if (!canUpdate(env)) return fail(request, env, 501, "not_configured", "Запуск обновления не настроен: задайте секрет GH_TOKEN и переменную GITHUB_REPO в Worker.");
  const force = body.force === true;
  const limit = body.quick === true ? 20 : null; // пробный прогон: только 20 улиц

  const l = await latestRun(env, deps);
  if (l.error) return fail(request, env, 502, "github_error", l.error);
  if (l.run && ACTIVE_RUN.has(l.run.status)) return fail(request, env, 409, "already_running", "Обновление уже идёт. Дождитесь завершения.");

  const res = await github(env, deps, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { force: String(force), limit: limit ? String(limit) : "" } }),
  });
  if (res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    console.error("github dispatch failed", res.status, data?.message);
    return fail(request, env, 502, "github_error", githubError(res, data));
  }
  console.log("update dispatched by", user.id, { force, limit });
  return json(request, env, 200, { ok: true, force, limit });
}

export async function handle(request, env, deps) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (request.method !== "POST" || !["/api/me", "/api/preview", "/api/publish", "/api/status", "/api/update"].includes(url.pathname)) {
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
  if (!admin) console.warn("пользователь не админ, id =", auth.user.id, "| ADMIN_IDS задан:", Boolean(env.ADMIN_IDS));

  if (url.pathname === "/api/me") return json(request, env, 200, { ok: true, admin, canUpdate: admin && canUpdate(env) });
  if (!admin) return fail(request, env, 403, "forbidden", "Нет прав администратора.");

  if (url.pathname === "/api/status") return status(request, env, deps);
  if (url.pathname === "/api/update") return update(request, env, deps, body, auth.user);

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

  // --- publish: ровно один день. test=true: отправка в ADMIN_CHAT_ID, канал не затрагивается ---
  if (!isValidIso(body.date)) return fail(request, env, 400, "bad_request", "Некорректная дата.");
  if (!UUID.test(String(body.requestId ?? ""))) return fail(request, env, 400, "bad_request", "Нужен requestId.");
  const test = body.test === true;
  const target = test ? env.ADMIN_CHAT_ID : env.CHANNEL_ID;
  if (!target || !env.BOT_TOKEN) {
    return fail(request, env, 500, "misconfigured", test ? "Для тестовой отправки не настроен ADMIN_CHAT_ID." : "Не настроены CHANNEL_ID / BOT_TOKEN.");
  }

  const day = describeDay(body.date, data, env, deps.now());
  if (!test && !day.canPublish) return fail(request, env, 409, "no_data", day.warnings[0]);

  // Защита от двойного нажатия и повторов сети: тот же requestId+день не отправляется в канал дважды.
  const doneKey = `done:${body.requestId}:${body.date}`;
  if (!test && env.STATE && (await env.STATE.get(doneKey))) return json(request, env, 200, { ok: true, duplicate: true, sent: 0 });

  const chunks = chunkText(day.text);
  if (test) chunks[0] = `🧪 ТЕСТ: в канал это не отправлялось\n\n${chunks[0]}`;
  let sent = 0;
  for (const chunk of chunks) {
    const r = await sendMessage(deps.fetch, env.BOT_TOKEN, target, chunk);
    if (!r.ok) {
      console.error("telegram send failed", r.status, r.description, "chunk", sent + 1, "of", chunks.length);
      return json(request, env, 502, { ok: false, error: "telegram_error", message: `Telegram: ${r.description}. Отправлено частей: ${sent} из ${chunks.length}.`, sent, total: chunks.length });
    }
    sent++;
    if (sent < chunks.length) await deps.sleep(300);
  }
  if (!test && env.STATE) await env.STATE.put(doneKey, String(deps.now()), { expirationTtl: 3600 });

  if (!test && env.ADMIN_CHAT_ID) {
    const who = auth.user.username ? `@${auth.user.username}` : String(auth.user.id);
    await sendMessage(deps.fetch, env.BOT_TOKEN, env.ADMIN_CHAT_ID, `📣 Опубликовано ${body.date} (${day.count} ул.), отправил ${who}`, { html: false });
  }
  return json(request, env, 200, { ok: true, sent, total: chunks.length, count: day.count, test });
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
