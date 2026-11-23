// Тонкая обёртка над Telegram WebApp SDK. Вне Telegram (обычный браузер) всё работает без него.

export const tg = window.Telegram?.WebApp ?? null;
export const inTelegram = Boolean(tg?.initData);

const atLeast = (v) => Boolean(tg?.isVersionAtLeast?.(v));

export function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  if (atLeast("6.1")) {
    tg.setHeaderColor?.("secondary_bg_color");
    tg.setBackgroundColor?.("secondary_bg_color");
  }
  // Вертикальный свайп не должен закрывать приложение, пока пользователь двигает карту/список.
  if (atLeast("7.7")) tg.disableVerticalSwipes?.();
}

/** Параметр ?startapp=YYYY-MM-DD из ссылки t.me/<bot>/<app>?startapp=... */
export function startParam() {
  return tg?.initDataUnsafe?.start_param ?? new URLSearchParams(location.search).get("startapp");
}

export function openExternal(url) {
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

export function haptic(kind = "light") {
  try {
    tg?.HapticFeedback?.impactOccurred(kind);
  } catch {
    /* не критично */
  }
}

/** Главная кнопка Telegram; вне Telegram возвращает false, и UI рисует свою. */
export function setMainButton(text, onClick) {
  if (!inTelegram || !tg.MainButton) return false;
  const mb = tg.MainButton;
  if (setMainButton._handler) mb.offClick(setMainButton._handler);
  if (!text) {
    mb.hide();
    return true;
  }
  setMainButton._handler = onClick;
  mb.setText(text);
  mb.onClick(onClick);
  mb.show();
  return true;
}
