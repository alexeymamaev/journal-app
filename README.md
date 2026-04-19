# prototype/ — Kid Journal v5 (Record + Events)

Чистая сборка после сноса v1–v4. Архитектура v5 из [../architecture.md](../architecture.md).

## Как запустить локально

```
cd prototype
python3 -m http.server 8000
```

Открыть `http://localhost:8000` в Safari / Chrome.

Для теста на iPhone в той же Wi-Fi:
```
python3 -m http.server 8000 --bind 0.0.0.0
```
и зайти на `http://<ip-машины>:8000` с телефона.

## Сброс состояния

Открыть DevTools → Application → IndexedDB → `kidjournal` → Delete. Или в консоли:
```js
indexedDB.deleteDatabase('kidjournal')
```
После этого `location.reload()` — онбординг покажется заново.

## Что сделано (MVP1 v5)

- Обязательный онбординг: имя+возраст ребёнка → выбор профилей → выбор тэгов.
- Главный экран: плашка контекста, тайлы активных типов, inline-композер, секция «Сегодня», ссылка на историю.
- 7 встроенных типов (Стул, Еда, Реакция, Настроение, Сон, Лекарства, Симптом) с fields-schema.
- Один рендерер bottom-sheet поверх fields-schema (single/multi/text).
- Ретро-сдвиг: −2ч −90м −1ч −30м сейчас.
- Двухтабличная модель: `records` + `events` (Dexie v1).
- Draft-autosave: Record создаётся при первом Event, коммитится кнопкой «Сохранить запись».
- Draft recovery: при открытии с незавершённой записью — плашка «продолжить / удалить».
- Edit из истории: тап карточки → та же форма, добавление/удаление наблюдений, правка комментария.
- Удаление записи целиком — кнопка в edit-форме.
- PWA: manifest + service worker (минимальный кэш для офлайна).

## Что НЕ сделано (осознанные пропуски, см. architecture v5)

- Селектор контекста `(subject, profile)` — UI-плашка есть, смены пока нет (в MVP1 один контекст).
- Настройки → порядок тэгов на главном.
- Экспорт в PDF / CSV — фаза 4.
- Фото, шкалы 0–10 — MVP2.
- Синхронизация — MVP2+.
- Кастомные типы и пресеты — фаза 2.5.
- Full-picker даты/времени — бэклог.

## Структура

```
prototype/
├── index.html          — shell + <template> для экранов
├── style.css           — всё, монолитно
├── app.js              — state-machine + рендер
├── config/
│   ├── types.js        — 7 встроенных типов с fields-schema
│   └── profiles.js     — 4 встроенных профиля
├── manifest.json
├── sw.js
├── icons/README.md
└── README.md
```

## Что помнить при итерациях

- **Никаких фреймворков**, никакого bundler-а. Ванильный JS + Dexie через CDN.
- **Fields-schema = один источник правды** для UI и валидации. Менять тип = править только `config/types.js`.
- **Record без Events не коммитится** как `saved`. Draft-Record без Events удаляется автоматически.
- **labelSnapshot на Event** — чтобы при ребрендинге типа старые записи остались читабельны.
- Это прототип, не продакшн. Поломки/миграции БД решаются через `indexedDB.deleteDatabase`.
