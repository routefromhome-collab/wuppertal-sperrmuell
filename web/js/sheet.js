// Нижняя шторка со списком: перетаскивание за «ручку» и три положения (свёрнута, половина, почти весь экран).
// Список внутри прокручивается обычным жестом; тянуть шторку можно за шапку (она крупная, под палец).

const MIN_H = 64;

/**
 * @param {{sheet: HTMLElement, handle: HTMLElement, container: HTMLElement, onChange?: () => void}} o
 * container: элемент, высота которого задаёт максимум (карта + шторка).
 */
export function setupSheet({ sheet, handle, container, onChange = () => {} }) {
  let snap = "mid";
  let dragging = null;

  const heights = () => {
    const full = container.clientHeight;
    return { min: MIN_H, mid: Math.round(full * 0.46), max: Math.round(full * 0.88) };
  };
  const apply = (px) => sheet.style.setProperty("--sheet-h", `${px}px`);

  function snapTo(name, { silent = false } = {}) {
    snap = name;
    sheet.dataset.snap = name;
    sheet.classList.remove("sheet--drag");
    apply(heights()[name]);
    handle.setAttribute("aria-expanded", String(name !== "min"));
    if (!silent) setTimeout(onChange, 230); // после завершения анимации высоты
  }

  handle.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    handle.setPointerCapture(e.pointerId);
    dragging = { y: e.clientY, h: sheet.getBoundingClientRect().height, t: performance.now(), moved: false, lastY: e.clientY, lastT: performance.now(), v: 0 };
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = dragging.y - e.clientY;
    if (!dragging.moved && Math.abs(dy) < 6) return;
    dragging.moved = true;
    sheet.classList.add("sheet--drag");
    sheet.dataset.snap = "drag";
    const hs = heights();
    const h = Math.min(hs.max, Math.max(hs.min, dragging.h + dy));
    apply(h);
    const now = performance.now();
    const dt = now - dragging.lastT;
    if (dt > 0) dragging.v = (dragging.lastY - e.clientY) / dt; // px/мс, вверх > 0
    dragging.lastY = e.clientY;
    dragging.lastT = now;
  });
  const end = (e) => {
    if (!dragging) return;
    const d = dragging;
    dragging = null;
    if (!d.moved) return; // это тап: его обработает click
    const hs = heights();
    const cur = sheet.getBoundingClientRect().height + d.v * 120; // небольшая инерция броска
    const order = ["min", "mid", "max"];
    const nearest = order.reduce((a, b) => (Math.abs(hs[b] - cur) < Math.abs(hs[a] - cur) ? b : a));
    handle.dataset.dragged = "1"; // подавляем следующий click
    setTimeout(() => delete handle.dataset.dragged, 0);
    snapTo(nearest);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);

  handle.addEventListener("click", () => {
    if (handle.dataset.dragged) return;
    snapTo(snap === "min" ? "mid" : snap === "mid" ? "max" : "min");
  });

  window.addEventListener("resize", () => snapTo(snap === "drag" ? "mid" : snap, { silent: true }));
  snapTo("mid", { silent: true });

  return { snapTo, get snap() { return snap; } };
}
