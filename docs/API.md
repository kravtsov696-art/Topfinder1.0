# API «Близкие» P0 (v1)

Все запросы — JSON по HTTPS. Авторизация устройства: `Authorization: Bearer <token>` (токен выдаётся при регистрации, на сервере хранится только SHA-256). Ошибки: `{ "error": "<код>", "message": "…" }`.

Чужая пара/запрос → **404** (не раскрываем существование). Разорванная/истёкшая связь → **403** `pair_revoked` / `pair_expired`. Эндпоинта «координаты по device_id» нет.

| Метод и путь | Назначение | Идемпотентность / защита |
|---|---|---|
| `GET /health` | состояние, `serverTime`, PostGIS, push | — |
| `POST /v1/devices/register` | `{platform, displayName, model?, osVersion?, appVersion?, registrationKey?}` → `{deviceId, token}` | лимит 20/мин с IP; `REGISTRATION_KEY` при наличии |
| `GET /v1/me` | мой режим, **моя** последняя точка, время приёма сервером | — |
| `PUT /v1/me/mode` | `{mode: OFF|ECO|ACTIVE_TRIP, activeTripMinutes?}` (поездка ≤ 240 мин) | OFF закрывает открытые запросы к устройству (`access_denied`) |
| `PUT /v1/me/status` | отчёт о разрешениях/батарее (без координат) | координатные ключи вырезаются |
| `PUT /v1/me/push-token` | `{token, kind:'expo'}` (этап D) | — |
| `POST /v1/invites` | одноразовый код (8 символов, 10 мин) | новое приглашение отменяет старое |
| `POST /v1/invites/preview` | `{code}` → имя пригласившего | ≤ 8 неверных попыток / 10 мин на устройство |
| `POST /v1/invites/accept` | `{code, confirm:true}` → `{pairId}`; создаёт 2 направленных grant, **оба выключены** | код одноразовый (атомарно) |
| `GET /v1/pairs` | мои связи и состояние grant'ов | — |
| `PUT /v1/pairs/:id/sharing` | `{enabled}` — показывать ли **мою** точку собеседнику | выключение закрывает его открытые запросы |
| `DELETE /v1/pairs/:id` | разорвать связь (любая сторона) | сразу: чтения, запросы, выдача → 403 |
| `GET /v1/pairs/:id/peer-location` | последняя **разрешённая** точка собеседника + `serverTime`, `lastSeenAt`, статус его телефона | только при grant собеседника → мне, режим ≠ OFF, точка не старше TTL и не старше включения обмена (−2 мин) |
| `POST /v1/fixes` | `{sentAt, fixes:[FixInput…≤100]}` → результат по каждой точке + ожидающие запросы обновления | ключ `clientFixId` (uuid): повтор → `duplicate` |
| `POST /v1/pairs/:id/refresh-requests` | `{clientRequestId}` → запрос обновления | повтор того же id → тот же запрос; один открытый на направление; ≤ 30/час |
| `GET /v1/refresh-requests/:id` | состояние и временная шкала | только участники |
| `GET /v1/refresh-requests/incoming` | открытые запросы ко мне (опрос при открытом приложении) | — |
| `POST /v1/refresh-requests/:id/progress` | `{stage: device_received|fix_measured|failed, channel, reason?}` — только целевой телефон | закрытый запрос → 409 + событие `late_*` |
| `POST /v1/diagnostics` | `{events:[{clientEventId, occurredAt, type, data}]}` | ключ `clientEventId`; координаты вырезаются |
| `GET /v1/diagnostics` | мои события | — |
| `GET /v1/export?format=json|csv&kind=fixes|diagnostics|refresh|devices` | выгрузка **своих** данных | — |
| `GET /v1/admin/export?…` | выгрузка всего испытания | заголовок `X-Admin-Token`; без токена → 404 |
| `DELETE /v1/me/data` | удалить мои точки/журнал, разорвать связи, режим OFF | — |
| `DELETE /v1/me` | то же + аннулировать токен | — |

## Точка (FixInput)

`clientFixId` (uuid), `measuredAt` (мс, время измерения ОС), `lat`, `lon`, `accuracyM` (>0, ≤ 50 000), `source` (`bg_task|fg_watch|refresh|manual|geofence`), необязательно: `altitude`, `speedMps`, `headingDeg`, `isMocked` (Android), `appState`, `networkType`, `batteryLevel`, `reducedAccuracy`, `refreshRequestId`, `scenario`, `enqueuedAt`, `attempt`.

Результат: `accepted` · `low_quality` (погрешность > 1 км) · `suspect` (физически невозможный скачок; хранится, **не показывается**) · `duplicate` · `rejected` с причиной `invalid_lat|invalid_lon|null_island|invalid_accuracy|invalid_timestamp|future_timestamp (>2 мин вперёд)|expired (старше TTL)|sharing_off|invalid_payload`. Флаг `late: true` — точка старее уже имеющейся; «последней» она не становится.

## Состояния запроса обновления

`created → server_accepted → (push_sent | push_not_configured | push_failed) → device_received → fix_measured → delivered`, либо `timeout` (90 с), `failed` (телефон сообщил причину), `access_denied`, `access_revoked`. `push_sent` означает лишь, что push-провайдер **принял** сообщение. `device_received` ставится **только** по явному сообщению телефона, с указанием канала (`poll`, `fix_response`, `push`).
