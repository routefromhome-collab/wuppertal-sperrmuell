"""Клиент и парсер календаря AWG Wuppertal.

Разбор HTML вынесен в чистые функции (parse_calendar, classify_page, ...): их можно
тестировать на сохранённых страницах без сети. Сетевая часть (AwgClient) тонкая.

Структуры страниц, которые знал старый main.py:
  * календарь улицы: div.month > (h3|span "November 2026") + div.day > span (число) + i[title=Sperrmüll]
  * у улицы несколько календарей (по номерам домов): текст «mehrere Abfallkalender»
    и ссылки a[href*=streetname] с номером дома; календарь дома рисуется таблицей (td)
  * неточное имя улицы: список похожих улиц, те же ссылки a[href*=streetname]

Если вёрстка AWG изменится, classify_page вернёт UNKNOWN: сборщик посчитает это
сбоем и не затрёт прежние данные.
"""

from __future__ import annotations

import logging
import random
import re
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup, Tag

from .dates import month_from_de

log = logging.getLogger(__name__)

FORM_URL = "https://awg-wuppertal.de/privatkunden/abfallkalender.html"
STREET_FIELD = "tx_bwwastecalendar_pi1[demand][streetname]"
HOUSES_MARKER = "mehrere Abfallkalender"

_MONTH_HEADER = re.compile(r"([A-Za-zÄÖÜäöüß]+)\s+(\d{4})")
_DIGITS = re.compile(r"\d+")


class PageKind(str, Enum):
    CALENDAR = "calendar"  # календарь с днями
    HOUSES = "houses"  # выбор номера дома
    SIMILAR = "similar"  # список похожих улиц
    UNKNOWN = "unknown"  # вёрстка не распознана


def normalize_street_name(name: str) -> str:
    """Сравнение имён улиц без учёта регистра, str/strasse/straße и пунктуации."""
    s = unicodedata.normalize("NFKC", str(name).strip().lower())
    s = re.sub(r"\bstr(?:\.|asse)?\b", "straße", s)
    s = re.sub(r"[-/_,.\\\"'()\[\]]+", " ", s)
    s = re.sub(r"str(?:\.|asse)?(?=[\s,]|$)", "straße", s)
    return re.sub(r"\s+", " ", s).strip()


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


def _month_of(month_div: Tag) -> tuple[int, int] | None:
    """(год, месяц) из заголовка блока месяца."""
    for el in month_div.find_all(["h2", "h3", "h4", "strong", "span"]):
        m = _MONTH_HEADER.fullmatch(el.get_text(" ", strip=True))
        if m:
            month = month_from_de(m.group(1))
            if month:
                return int(m.group(2)), month
    return None


def _has_sperrmuell(cell: Tag) -> bool:
    return cell.find(attrs={"title": re.compile("sperrm", re.I)}) is not None


def _day_of(cell: Tag) -> int | None:
    span = cell.find("span") if cell.name == "div" else None
    text = (span or cell).get_text(" ", strip=True)
    m = _DIGITS.search(text)
    return int(m.group()) if m else None


def parse_calendar(html: str) -> list[date]:
    """Все даты вывоза Sperrmüll (по AWG, без сдвига D-1) на странице календаря."""
    result: set[date] = set()
    for month_div in _soup(html).find_all("div", class_="month"):
        ym = _month_of(month_div)
        if not ym:
            continue
        for cell in month_div.select("div.day, td"):
            if cell.name == "td" and cell.find("div", class_="day"):
                continue  # ячейка-обёртка, день посчитаем во вложенном div
            if not _has_sperrmuell(cell):
                continue
            day = _day_of(cell)
            if day is None:
                continue
            try:
                result.add(date(ym[0], ym[1], day))
            except ValueError:
                # ячейка не день календаря (легенда, итоги и т.п.): пропускаем
                log.debug("Пропущена ячейка с числом %s в %s-%s", day, ym[0], ym[1])
    return sorted(result)


def classify_page(html: str) -> PageKind:
    soup = _soup(html)
    if HOUSES_MARKER in soup.get_text(" ", strip=True):
        return PageKind.HOUSES
    month_divs = soup.find_all("div", class_="month")
    if any(d.find("div") or d.find("td") for d in month_divs):
        return PageKind.CALENDAR
    if soup.select('a[href*="streetname"]'):
        return PageKind.SIMILAR
    return PageKind.UNKNOWN


def extract_links(html: str, base_url: str) -> list[tuple[str, str]]:
    """[(текст ссылки, абсолютный URL)] для ссылок выбора дома / похожей улицы."""
    out = []
    for a in _soup(html).select('a[href*="streetname"]'):
        text = a.get_text(strip=True)
        if text and a.get("href"):
            out.append((text, urljoin(base_url, a["href"])))
    return out


@dataclass
class StreetResult:
    status: str  # ok | not_found | unrecognized | error
    dates: list[date] = field(default_factory=list)  # улица целиком
    houses: dict[str, list[date]] = field(default_factory=dict)  # по номерам домов


class AwgClient:
    """Вежливый клиент: общий лимит частоты на все потоки, ретраи с backoff."""

    def __init__(
        self,
        min_delay: float = 0.12,
        timeout: int = 25,
        retries: int = 5,
        debug_dir: str | None = None,
    ):
        self.debug_dir = debug_dir
        self._dumped: dict[str, int] = {}
        self.session = requests.Session()
        self.min_delay = min_delay
        self.timeout = timeout
        self.retries = retries
        self._lock = threading.Lock()
        self._last = 0.0
        self.post_url = FORM_URL
        self.form_data: dict[str, str] = {}
        self.requests_made = 0

    # --- сеть ---
    def _headers(self) -> dict[str, str]:
        return {
            "User-Agent": "Mozilla/5.0 (compatible; wuppertal-sperrmuell/1.0; "
            "+https://github.com/routefromhome-collab/wuppertal-sperrmuell)",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "de-DE,de;q=0.9,ru;q=0.5",
        }

    def _throttle(self) -> None:
        with self._lock:
            wait = self._last + self.min_delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.requests_made += 1

    def _request(self, method: str, url: str, **kw) -> str | None:
        for attempt in range(self.retries):
            self._throttle()
            try:
                r = self.session.request(
                    method, url, headers=self._headers(), timeout=self.timeout, **kw
                )
                if r.status_code == 429 or r.status_code >= 500:
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                r.raise_for_status()
                return r.text
            except requests.RequestException as e:
                wait = min(2**attempt + random.random(), 30)
                log.warning("%s %s: %s, повтор через %.1fs", method, url, e, wait)
                time.sleep(wait)
        return None

    def load_form(self) -> None:
        html = self._request("GET", FORM_URL)
        if not html:
            raise RuntimeError("Не удалось загрузить страницу с формой AWG")
        form = _soup(html).find("form", attrs={"name": "demand"})
        if not form:
            raise RuntimeError("Форма name=demand не найдена: вёрстка AWG изменилась?")
        self.post_url = urljoin(FORM_URL, form.get("action") or "")
        self.form_data = {
            i.get("name"): i.get("value") or ""
            for i in form.find_all("input")
            if i.get("name")
        }

    def _dump(self, street: str, kind: PageKind, html: str) -> None:
        """Сохраняет HTML для диагностики: все нераспознанные (до 25) и по 3 образца остальных."""
        if not self.debug_dir:
            return
        limit = 25 if kind in (PageKind.UNKNOWN, PageKind.SIMILAR) else 3
        with self._lock:
            n = self._dumped.get(kind.value, 0)
            if n >= limit:
                return
            self._dumped[kind.value] = n + 1
        safe = re.sub(r"[^\w.-]+", "_", street)[:60]
        path = Path(self.debug_dir)
        path.mkdir(parents=True, exist_ok=True)
        (path / f"{kind.value}__{safe}.html").write_text(html, encoding="utf-8")

    # --- разбор одной улицы ---
    def fetch_street(self, street: str) -> StreetResult:
        data = dict(self.form_data)
        data[STREET_FIELD] = street
        html = self._request("POST", self.post_url, data=data)
        if html is None:
            return StreetResult("error")
        return self._resolve(html, self.post_url, street, depth=0)

    def _resolve(self, html: str, url: str, street: str, depth: int) -> StreetResult:
        kind = classify_page(html)
        self._dump(street, kind, html)
        if kind is PageKind.CALENDAR:
            return StreetResult("ok", dates=parse_calendar(html))

        if kind is PageKind.HOUSES:
            houses: dict[str, list[date]] = {}
            for house, link in extract_links(html, url):
                page = self._request("GET", link)
                if page is None:
                    return StreetResult("error")
                houses[house] = parse_calendar(page)
            return StreetResult("ok", houses=houses)

        if kind is PageKind.SIMILAR and depth == 0:
            wanted = normalize_street_name(street)
            for text, link in extract_links(html, url):
                if normalize_street_name(text) == wanted:
                    page = self._request("GET", link)
                    if page is None:
                        return StreetResult("error")
                    return self._resolve(page, link, street, depth=1)
            return StreetResult("not_found")

        if kind is PageKind.SIMILAR:
            return StreetResult("not_found")
        return StreetResult("unrecognized")
