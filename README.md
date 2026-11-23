# Шпера Wuppertal: Telegram Mini App

Карта и список улиц, где жители выставляют Sperrmüll (крупногабаритный мусор) в ближайшие 7 дней.
Пользователь вводит дату: она становится днём 1, дальше идут ещё 6 дней.

> **Правило дат D-1 (намеренное).** AWG вывозит 30 ноября → жители выставляют 29 ноября →
> улица показывается в списке **29-го**. В данных хранятся «сырые» даты вывоза AWG, сдвиг
> применяется в одном месте на каждый язык: `sperrmuell/dates.py` и `web/js/dates.js` (оба покрыты тестами).

## Архитектура

```
GitHub Actions (Python)                        GitHub Pages (чистый JS, без сборщика)
┌──────────────────────────┐   commit JSON    ┌───────────────────────────────────────┐
│ build_schedule  ─ AWG ──►│ web/data/        │ index.html + js/*.js + Leaflet (CDN)  │
│ geocode ─ Nominatim ────►│  schedule.json ─►│ окно 7 дней, D-1, карта, маршруты     │
│ publish ─► Telegram-канал│  coords.json     │ Telegram WebApp SDK (тема, MainButton)│
└──────────────────────────┘  streets.json    └───────────────────────────────────────┘
```

Главное отличие от старого `main.py`: один запрос на улицу отдаёт календарь целиком, поэтому парсер
забирает **все даты сразу**, а окно в 7 дней считает клиент. Запросов к AWG примерно в 7 раз меньше,
записи младше 25 дней не перезапрашиваются, а ввод даты не требует нового парсинга.

| Что | Где |
|---|---|
| Парсер AWG (чистые функции + тонкий клиент) | `sperrmuell/awg.py` |
| Сборка расписания, защита от сбоев | `sperrmuell/build_schedule.py` |
| Геокодирование (Nominatim → Photon, рамка Wuppertal) | `sperrmuell/geocode.py` |
| Публикация в канал (ручная, по введённой дате) | `sperrmuell/publish.py` |
| TSP-маршруты, ссылки Google Maps по 20 точек | `sperrmuell/routing.py` и `web/js/routing.js` |
| Mini App | `web/` |

## Первый запуск

1. Создайте репозиторий (например `wuppertal-sperrmuell`), загрузите содержимое этой папки.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions:**
   - secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_CHAT_ID`
   - variable: `MINIAPP_URL` (ссылка на Mini App вида `https://t.me/<бот>/<имя_приложения>`, нужна после шага 6)
4. **Actions → Update schedule → Run workflow**, сначала с `limit = 20` (испытание), затем без лимита.
   Первый полный прогон геокодирует ~370 улиц, которых нет в сидовом кэше (~10 мин, Nominatim 1 запрос/сек).
5. Дождитесь **Deploy Pages**: приложение появится на `https://<аккаунт>.github.io/<репозиторий>/`.
6. В @BotFather: `/newapp` (или Bot Settings → Menu Button) и укажите этот URL.
7. Публикация в канал: **Actions → Publish → Run workflow**, `start_date`, сначала с `dry_run = true`.

## Локальная разработка

```bash
pip install -r requirements.txt pytest && python -m pytest -q   # 20 тестов
npm test                                                          # 8 тестов
python -m sperrmuell.build_schedule --only "Bachstr" --force --dry-run
cd web && python -m http.server 8000                              # http://localhost:8000
```

Ссылка с датой: `https://t.me/<бот>/<приложение>?startapp=2026-11-29` откроет приложение на этой дате.

## Что осталось проверить на реальных данных

- **Фикстуры в `tests/fixtures/` синтетические**: они повторяют вёрстку, известную из старого кода
  (`div.month`, `div.day`, `i[title=Sperrmüll]`, таблицы `td` для домов, страница «mehrere Abfallkalender»).
  Из среды разработки AWG недоступен, поэтому первый запуск на Actions проверит парсер на живой вёрстке.
  Если вёрстка изменилась, сборщик не затрёт данные (порог сбоев 5%, код выхода 2, сообщение в админ-чат).
  Замените фикстуры сохранёнными HTML из испытаний 3a: тесты станут golden.
- Leaflet и Telegram SDK подключаются с CDN без SRI-хешей; для усиления защиты добавьте `integrity`
  или положите файлы в `web/vendor/`.
- Тайлы `tile.openstreetmap.org` годятся для небольшой аудитории; при росте нагрузки перейдите на
  собственного провайдера тайлов (политика использования OSM).

## Дальше

Геометрия улиц (Overpass) для подсветки линий и точного «ближайшая улица»; сейчас используются точки.
`initData` не проверяется: в v1 нет персональных данных и действий от имени пользователя. Когда появятся
избранное или подписки, понадобится серверная проверка (Cloudflare Worker).
