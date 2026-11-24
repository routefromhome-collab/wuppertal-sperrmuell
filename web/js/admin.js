// Админ-панель: публикация списка улиц в канал. Видна только админам (проверяет Worker по подписи Telegram).
// Сама панель ничего не решает: права и отправку выполняет Worker, здесь только интерфейс.
import { API_URL } from "../config.js";
import { formatLong } from "./dates.js";
import { confirmDialog, haptic, initData, inTelegram } from "./tg.js";

const $ = (id) => document.getElementById(id);
const requestIds = new Map(); // дата -> id запроса (повтор того же дня не продублирует пост)
let days = [];
let busy = false;

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Текст поста для показа: HTML Telegram -> простой текст (без исполнения чего-либо). */
const toPlain = (html) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

async function api(path, payload) {
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
    throw Object.assign(new Error(data?.message ?? `Ошибка сервера (${res.status}).`), { code: data?.error ?? "http" });
  }
  return data;
}

export async function detectAdmin() {
  if (!API_URL || !inTelegram) return false;
  try {
    return (await api("/api/me", {})).admin === true;
  } catch {
    return false;
  }
}

function setStatus(text) {
  $("adminStatus").textContent = text;
}

function setBusy(value) {
  busy = value;
  for (const id of ["adminSend", "adminReload"]) $(id).disabled = value;
  document.querySelectorAll("#adminList input[type=checkbox]").forEach((c) => {
    c.disabled = value || c.dataset.locked === "1";
  });
}

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
  box.disabled = !day.canPublish;
  box.dataset.locked = day.canPublish ? "0" : "1";
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
  return li;
}

async function loadPreview(start, count) {
  setBusy(true);
  setStatus("Загрузка превью…");
  $("adminList").replaceChildren();
  try {
    const res = await api("/api/preview", { start, days: count });
    days = res.days;
    $("adminList").replaceChildren(...days.map(itemNode));
    const ok = days.filter((d) => d.canPublish).length;
    setStatus(ok ? "Отметьте дни и нажмите «Отправить в канал»." : "Нет дней, которые можно опубликовать.");
  } catch (e) {
    days = [];
    setStatus(`❌ ${e.message}`);
  } finally {
    setBusy(false);
  }
}

function itemOf(date) {
  return document.querySelector(`#adminList li[data-date="${date}"]`);
}

async function send() {
  const selected = [...document.querySelectorAll("#adminList li")]
    .filter((li) => li.querySelector("input[type=checkbox]").checked)
    .map((li) => li.dataset.date);
  if (!selected.length) return setStatus("Не выбрано ни одного дня.");
  const ok = await confirmDialog(`Отправить в канал ${selected.length} дн.: ${selected[0]} … ${selected.at(-1)}?\nЭто увидят все подписчики.`);
  if (!ok) return;

  setBusy(true);
  let done = 0;
  let failed = 0;
  let lastError = "";
  for (const date of selected) {
    const li = itemOf(date);
    const st = li.querySelector('[data-role="status"]');
    st.textContent = "⏳";
    if (!requestIds.has(date)) requestIds.set(date, newId());
    try {
      const r = await api("/api/publish", { date, requestId: requestIds.get(date) });
      st.textContent = r.duplicate ? "✅ уже отправлено" : "✅ отправлено";
      const box = li.querySelector("input[type=checkbox]");
      box.checked = false;
      box.dataset.locked = "1";
      done++;
    } catch (e) {
      st.textContent = "❌";
      st.title = e.message;
      failed++;
      lastError = `${date}: ${e.message}`;
      if (e.code === "expired" || e.code === "unauthorized" || e.code === "forbidden") break; // дальше нет смысла
    }
    setStatus(`Отправлено ${done} из ${selected.length}…`);
  }
  haptic(failed ? "heavy" : "medium");
  setBusy(false);
  setStatus(
    failed
      ? `❌ Отправлено ${done}, не удалось ${failed}. Последняя ошибка: ${lastError}. Неудачные дни остались отмеченными: исправьте причину и нажмите «Отправить» ещё раз.`
      : `✅ Готово: отправлено ${done} дн.`,
  );
}

export function openAdmin({ start, days: count = 7 }) {
  requestIds.clear();
  $("adminHint").textContent = `Список на ${count} дн. от ${formatLong(start)}. Дата выставления, вывоз AWG на следующий день.`;
  $("adminDlg").showModal();
  loadPreview(start, count);
  $("adminReload").onclick = () => !busy && loadPreview(start, count);
  $("adminSend").onclick = () => !busy && send();
  $("adminClose").onclick = () => $("adminDlg").close();
}
