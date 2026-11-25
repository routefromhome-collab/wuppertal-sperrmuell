// Панель админа: обновление данных AWG, тестовая отправка себе и публикация в канал.
// Панель только интерфейс: права, отправку и запуск обновления выполняет Worker (проверяет подпись Telegram и ADMIN_IDS).
import { API_URL } from "../config.js";
import { formatLong } from "./dates.js";
import { confirmDialog, haptic, initData, inTelegram, openExternal, telegramUserId } from "./tg.js";

const $ = (id) => document.getElementById(id);
const requestIds = new Map(); // дата -> id запроса (повтор того же дня не продублирует пост в канал)
let busy = false;
let pollTimer = null;
let wired = false;

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Текст поста для показа: HTML Telegram -> простой текст (ничего не исполняется). */
const toPlain = (html) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

async function api(path, payload = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: initData(), ...payload }),
    });
  } catch {
    throw Object.assign(new Error("Нет связи с сервером публикации."), { code: "network" });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ответ не JSON */
  }
  if (!res.ok || !data?.ok) {
    throw Object.assign(new Error(data?.message ?? `Ошибка сервера (${res.status}).`), { code: data?.error ?? "http", reason: data?.reason, status: res.status });
  }
  return data;
}

/** @returns {Promise<null | {canUpdate: boolean}>} null, если пользователь не админ или панель выключена */
export async function detectAdmin() {
  if (!API_URL || !inTelegram) return null;
  try {
    const r = await api("/api/me");
    return r.admin === true ? { canUpdate: r.canUpdate === true, canManage: r.canManage === true } : null;
  } catch {
    return null;
  }
}

// ---------- список админов ----------
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString("ru-RU") : "");

function renderTeam(t) {
  const list = $("adminTeamList");
  list.replaceChildren();
  const add = (id, note, removable) => {
    const li = document.createElement("li");
    li.className = "adm__item";
    const line = document.createElement("div");
    line.className = "adm__line";
    const span = document.createElement("span");
    span.style.flex = "1";
    span.textContent = `${id}${id === t.me ? " (вы)" : ""} · ${note}`;
    line.append(span);
    if (removable) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = "Удалить";
      b.addEventListener("click", () => removeTeam(id));
      line.append(b);
    }
    li.append(line);
    list.append(li);
  };
  t.owners.forEach((id) => add(id, "владелец (ADMIN_IDS)", false));
  t.extra.forEach((a) => add(a.id, `добавлен ${fmtDate(a.at)}${a.by ? `, кем: ${a.by}` : ""}`, true));
  $("adminTeamSummary").textContent = `Админы: ${t.owners.length + t.extra.length}`;
}

async function loadTeam() {
  try {
    renderTeam(await api("/api/admins"));
  } catch (e) {
    $("adminTeamHint").textContent = `Не удалось загрузить список: ${e.message}`;
  }
}

async function changeTeam(path, id) {
  $("adminTeamHint").textContent = "";
  try {
    const r = await api(path, { id });
    renderTeam(r);
    return r;
  } catch (e) {
    $("adminTeamHint").textContent = e.message;
    return null;
  }
}

async function removeTeam(id) {
  if (!(await confirmDialog(`Убрать права админа у ${id}?`))) return;
  await changeTeam("/api/admins/remove", id);
}

async function addTeam(e) {
  e.preventDefault();
  const id = $("adminTeamId").value.trim();
  if (!/^\d{5,15}$/.test(id)) {
    $("adminTeamHint").textContent = "Telegram ID это число из 5-15 цифр. Его покажет бот @userinfobot или 5 нажатий на заголовок «Шпера» в приложении.";
    return;
  }
  if (!(await confirmDialog(`Дать права админа пользователю ${id}? Он сможет публиковать в канал и добавлять других админов.`))) return;
  const r = await changeTeam("/api/admins/add", id);
  if (r) {
    $("adminTeamId").value = "";
    $("adminTeamHint").textContent = r.already ? "Этот пользователь уже админ." : "Добавлено. Права появятся после перезапуска приложения у него (до минуты).";
  }
}

/** Объясняет простыми словами, почему кнопки админа нет. Показывается по 5 нажатиям на заголовок. */
export async function diagnose() {
  const lines = [`Диагностика админ-панели`, `Адрес приложения: ${location.origin}`];
  if (!API_URL) return [...lines, "❌ В web/config.js пуст API_URL: панель выключена."];
  lines.push(`Worker: ${API_URL}`);
  if (!inTelegram) {
    return [...lines, "❌ Telegram не передал данные (initData пуст). Откройте приложение через бота: кнопка меню или ссылка t.me/…; запуск с кнопки клавиатуры и обычный браузер данных не дают."];
  }
  const id = telegramUserId();
  lines.push(`Ваш Telegram ID: ${id ?? "не определён"}`);
  try {
    const r = await api("/api/me");
    if (r.admin) return [...lines, "✅ Подпись верна, вы админ: кнопка 📣 должна быть рядом с заголовком. Если её нет, закройте и откройте приложение заново."];
    return [...lines, `❌ Подпись верна, но ID ${id} нет в ADMIN_IDS. Проверьте секрет: в папке worker выполните npx wrangler secret put ADMIN_IDS и введите только число, без кавычек и пробелов. Если переменную добавляли в панели Cloudflare, команда wrangler deploy могла её удалить: используйте именно secret put.`];
  } catch (e) {
    if (e.code === "network") {
      return [...lines, `❌ Нет ответа от Worker. Либо адрес неверный/Worker не развёрнут, либо ALLOWED_ORIGIN в worker/wrangler.toml не равен ${location.origin} (без слеша в конце), после правки нужен npx wrangler deploy.`];
    }
    if (e.code === "forbidden_origin") return [...lines, `❌ ALLOWED_ORIGIN в wrangler.toml не совпадает с ${location.origin}. Исправьте и выполните npx wrangler deploy.`];
    if (e.code === "unauthorized") {
      const hint = { bad_signature: "BOT_TOKEN в Worker не от того бота, через которого открыто приложение (или в токене опечатка). Задайте заново: npx wrangler secret put BOT_TOKEN.", malformed: "Telegram прислал некорректные данные запуска.", no_user: "В данных запуска нет пользователя." }[e.reason] ?? "Неизвестная причина.";
      return [...lines, `❌ Подпись Telegram не принята (${e.reason ?? "?"}): ${hint}`];
    }
    if (e.code === "expired") return [...lines, "❌ Сессия устарела: закройте и откройте приложение заново."];
    return [...lines, `❌ ${e.message} (код ${e.code ?? e.status ?? "?"})`];
  }
}

const setStatus = (text) => ($("adminStatus").textContent = text);

function setBusy(value) {
  busy = value;
  for (const id of ["adminSend", "adminTest", "adminReload"]) $(id).disabled = value;
  document.querySelectorAll("#adminList input[type=checkbox]").forEach((c) => {
    c.disabled = value || c.dataset.locked === "1";
  });
}

// ---------- данные расписания ----------
const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

function describeRun(run, error) {
  if (error) return `GitHub: ${error}`;
  if (!run) return "Запусков обновления ещё не было.";
  if (run.status !== "completed") return `⏳ Обновление идёт с ${fmtTime(run.created_at)}…`;
  if (run.conclusion === "success") return `✅ Последнее обновление успешно: ${fmtTime(run.updated_at)}. Сайт обновится в течение пары минут.`;
  return `❌ Последнее обновление не удалось (${run.conclusion}): ${fmtTime(run.updated_at)}.`;
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

async function refreshStatus({ canUpdate }) {
  stopPolling();
  try {
    const st = await api("/api/status");
    const s = st.schedule;
    const empty = !s || !s.with_data;
    $("adminDataSummary").textContent = empty ? "⚠ Данные расписания: нет" : `Данные расписания: до ${s.covered_until ?? "?"}`;
    $("adminDataInfo").textContent = s
      ? `Обновлено: ${fmtTime(s.generated_at)} · улиц в базе: ${s.streets} · с вывозом: ${s.with_data}${s.covered_until ? ` · календарь AWG до ${s.covered_until}` : ""}`
      : "Не удалось прочитать расписание с сайта.";
    $("adminRunInfo").textContent = st.canUpdate ? describeRun(st.run, st.runError) : "";
    $("adminUpdateBox").hidden = !st.canUpdate;
    $("adminUpdateHint").hidden = st.canUpdate;
    const running = st.run && st.run.status !== "completed";
    $("adminData").open = empty || running || (st.run && st.run.conclusion !== "success");
    $("adminUpdate").disabled = Boolean(running);
    if (running) pollTimer = setTimeout(() => refreshStatus({ canUpdate }), 15_000);
    return st;
  } catch (e) {
    $("adminDataInfo").textContent = `❌ ${e.message}`;
    return null;
  }
}

async function startUpdate(ctx) {
  const quick = $("adminQuick").checked;
  const force = $("adminForce").checked;
  const ok = await confirmDialog(
    quick
      ? "Запустить пробный прогон обновления (20 улиц)? Данные на сайте изменятся только если всё прошло успешно."
      : `Запустить ${force ? "полное " : ""}обновление расписания из AWG? Это займёт от нескольких минут до часа.`,
  );
  if (!ok) return;
  $("adminUpdate").disabled = true;
  $("adminRunInfo").textContent = "Запускаю…";
  try {
    await api("/api/update", { quick, force });
    haptic("medium");
    $("adminRunInfo").textContent = "✅ Запущено. Статус обновляется сам.";
    pollTimer = setTimeout(() => refreshStatus(ctx), 5_000);
  } catch (e) {
    $("adminRunInfo").textContent = `❌ ${e.message}`;
    $("adminUpdate").disabled = false;
  }
}

// ---------- список дней ----------
function itemNode(day) {
  const li = document.createElement("li");
  li.className = "adm__item";
  li.dataset.date = day.date;

  const line = document.createElement("div");
  line.className = "adm__line";
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = day.canPublish;
  box.dataset.locked = "0";
  const title = document.createElement("span");
  title.textContent = `${formatLong(day.date)} · ${day.count} ул.`;
  label.append(box, title);
  const status = document.createElement("span");
  status.className = "adm__status";
  status.dataset.role = "status";
  line.append(label, status);
  li.append(line);

  for (const w of day.warnings) {
    const p = document.createElement("div");
    p.className = "adm__warn";
    p.textContent = `⚠ ${w}`;
    li.append(p);
  }
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  sum.textContent = "Текст поста";
  const pre = document.createElement("pre");
  pre.textContent = day.messages.map(toPlain).join("\n\n— — —\n\n");
  det.append(sum, pre);
  li.append(det);
  li.dataset.canPublish = day.canPublish ? "1" : "0";
  return li;
}

async function loadPreview(start, count) {
  setBusy(true);
  setStatus("Загрузка превью…");
  $("adminList").replaceChildren();
  try {
    const res = await api("/api/preview", { start, days: count });
    $("adminList").replaceChildren(...res.days.map(itemNode));
    const ok = res.days.filter((d) => d.canPublish).length;
    setStatus(
      ok
        ? "Отметьте дни. «Тест себе» отправит в ваш админ-чат, «Отправить в канал» опубликует для всех."
        : "Нет дней, которые можно опубликовать в канал (тест себе всё равно доступен).",
    );
  } catch (e) {
    setStatus(`❌ ${e.message}`);
  } finally {
    setBusy(false);
  }
}

const itemOf = (date) => document.querySelector(`#adminList li[data-date="${date}"]`);

/** @param {boolean} test true: в админ-чат; false: в канал */
async function send(test) {
  const items = [...document.querySelectorAll("#adminList li")].filter((li) => li.querySelector("input[type=checkbox]").checked);
  const selected = items.map((li) => li.dataset.date);
  if (!selected.length) return setStatus("Не выбрано ни одного дня.");
  if (!test) {
    const blocked = items.filter((li) => li.dataset.canPublish !== "1");
    if (blocked.length) return setStatus("Среди выбранных есть дни без данных AWG: в канал их отправить нельзя (только тест).");
    const ok = await confirmDialog(`Отправить в канал ${selected.length} дн.: ${selected[0]} … ${selected.at(-1)}?\nЭто увидят все подписчики.`);
    if (!ok) return;
  }

  setBusy(true);
  let done = 0;
  let failed = 0;
  let lastError = "";
  for (const date of selected) {
    const li = itemOf(date);
    const st = li.querySelector('[data-role="status"]');
    st.textContent = "⏳";
    // для тестов всегда новый id: тест можно повторять сколько угодно
    const requestId = test ? newId() : (requestIds.get(date) ?? requestIds.set(date, newId()).get(date));
    try {
      const r = await api("/api/publish", { date, requestId, test });
      st.textContent = test ? "🧪 в чате" : r.duplicate ? "✅ уже отправлено" : "✅ отправлено";
      if (!test) {
        const box = li.querySelector("input[type=checkbox]");
        box.checked = false;
        box.dataset.locked = "1";
      }
      done++;
    } catch (e) {
      st.textContent = "❌";
      failed++;
      lastError = `${date}: ${e.message}`;
      if (["expired", "unauthorized", "forbidden"].includes(e.code)) break; // дальше нет смысла
    }
    setStatus(`${test ? "Тест" : "Отправлено"}: ${done} из ${selected.length}…`);
  }
  haptic(failed ? "heavy" : "medium");
  setBusy(false);
  setStatus(
    failed
      ? `❌ Успешно ${done}, не удалось ${failed}. Последняя ошибка: ${lastError}. Неудачные дни остались отмеченными: исправьте причину и повторите.`
      : test
        ? `🧪 Готово: ${done} дн. отправлено в ваш админ-чат, в канал ничего не ушло.`
        : `✅ Готово: отправлено в канал ${done} дн.`,
  );
}

export function openAdmin({ start, days: count = 7, canUpdate = false, canManage = false }) {
  requestIds.clear();
  const ctx = { canUpdate };
  $("adminHint").textContent = `Список на ${count} дн. от ${formatLong(start)}. Дата выставления, вывоз AWG на следующий день.`;
  $("adminDlg").showModal();
  refreshStatus(ctx);
  loadPreview(start, count);
  $("adminTeam").hidden = false;
  $("adminTeamForm").hidden = !canManage;
  $("adminTeamHint").textContent = canManage ? "" : "Добавление админов из приложения выключено: подключите KV STATE (см. README, «Админы из приложения»). Сейчас админы задаются секретом ADMIN_IDS.";
  loadTeam();

  $("adminReload").onclick = () => !busy && loadPreview(start, count);
  $("adminSend").onclick = () => !busy && send(false);
  $("adminTest").onclick = () => !busy && send(true);
  $("adminUpdate").onclick = () => startUpdate(ctx);
  $("adminClose").onclick = () => $("adminDlg").close();
  if (!wired) {
    wired = true;
    $("adminDlg").addEventListener("close", stopPolling);
    $("adminTeamForm").addEventListener("submit", addTeam);
    $("adminRunInfo").addEventListener("click", (e) => e.target.tagName === "A" && (e.preventDefault(), openExternal(e.target.href)));
  }
}
