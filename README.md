# «Близкие» — P0: испытание геолокации iPhone ↔ Android

Испытательный стенд для двух добровольно связанных взрослых телефонов: обмен координатами через защищённый сервер, честные статусы свежести, запрос обновления с реальными стадиями, журнал и экспорт для сравнения устройств.

**Главное правило:** карта отличает свежую точку от устаревшей, приблизительной и недоступной. Старая точка никогда не выдаётся за текущую.

## Что внутри

```
apps/api        сервер: Node 22 (node:http) + PostgreSQL/PostGIS, тесты, смоук
apps/mobile     приложение: Expo SDK 57 / React Native 0.86 (своя сборка, не Expo Go)
packages/shared общие типы, пороги свежести, политика приёма точек
scripts/        summarize.ts — выгрузка результатов и сводка p50/p90
deploy/vps      сервер на любом VPS с автоматическим HTTPS (Caddy)
docs/           RUNBOOK, TEST_MATRIX, ARCHITECTURE, API, KNOWN_LIMITATIONS, IMPLEMENTATION_STATUS
.github/        CI, сборка Android APK, проверка/сборка iOS
```

## Быстрый старт

- **Пошагово для испытаний на телефонах:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Что проверено, а что нет:** [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)
- **Протокол испытаний:** [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md)

Для разработчика:
```bash
npm install                          # Node ≥ 22.18
docker compose up --build            # API + PostGIS на http://localhost:8080
TEST_DATABASE_URL=postgres://… npm run api:test
node apps/api/test/smoke.ts http://localhost:8080
cd apps/mobile && npx expo prebuild && npx expo run:android   # нужен Android SDK
```

## Безопасность и приватность P0

Обмен выключен по умолчанию и включается каждым участником отдельно; связь — только по одноразовому коду с подтверждением; отзыв действует сразу; координаты хранятся 24 ч; в логах сервера нет координат и токенов. **Сквозное шифрование (E2EE) в P0 не реализовано** — сервер видит координаты (TLS + проверка доступа). Никакого скрытого режима наблюдения, детского режима и поиска незнакомцев. Данные P0 не используются для продукта «Люди рядом».
