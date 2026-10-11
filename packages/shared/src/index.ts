// Общие контракты «Близкие» P0. Один файл без внутренних импортов —
// чтобы его одинаково читали Node (type stripping) и Metro (React Native).
// Никаких enum/namespace: только типы и константы (совместимость с type stripping).

export const API_VERSION = 'v1';

// ---------- Режимы обмена ----------
export type SharingMode = 'OFF' | 'ECO' | 'ACTIVE_TRIP';
export const SHARING_MODES: readonly SharingMode[] = ['OFF', 'ECO', 'ACTIVE_TRIP'];
export const ACTIVE_TRIP_MAX_MINUTES = 240;
export const ACTIVE_TRIP_DEFAULT_MINUTES = 30;

// ---------- Пороги свежести (ЭКСПЕРИМЕНТАЛЬНЫЕ, не гарантия ОС) ----------
// Источник: блупринт §6.1. Меняются только по итогам полевых испытаний.
export const FRESHNESS_THRESHOLDS = {
  freshMaxAgeMs: 2 * 60_000,
  recentMaxAgeMs: 10 * 60_000,
  staleMaxAgeMs: 60 * 60_000,
  goodAccuracyM: 100,
} as const;

export type FreshnessStatus =
  | 'fresh' // свежая: ≤2 мин и точность ≤100 м
  | 'recent' // недавняя: ≤10 мин
  | 'approximate' // приблизительная: ≤10 мин, но погрешность >100 м или ОС дала только приблизительную
  | 'stale' // устаревшая: 10–60 мин
  | 'historical' // историческая: >60 мин — только «последнее известное место»
  | 'unavailable'; // нет достоверной позиции

export const FRESHNESS_LABEL_RU: Record<FreshnessStatus, string> = {
  fresh: 'Свежая',
  recent: 'Недавняя',
  approximate: 'Приблизительная',
  stale: 'Устаревшая',
  historical: 'Историческая (последнее известное место)',
  unavailable: 'Недоступна',
};

export function classifyFreshness(input: {
  ageMs: number | null;
  accuracyM: number | null;
  reducedAccuracy?: boolean;
}): FreshnessStatus {
  const { ageMs, accuracyM } = input;
  if (ageMs === null || accuracyM === null || !Number.isFinite(ageMs) || !Number.isFinite(accuracyM)) {
    return 'unavailable';
  }
  // Отрицательный возраст = точка «из будущего» (расхождение часов). Считаем возраст нулевым,
  // но UI отдельно показывает предупреждение о часах.
  const age = Math.max(0, ageMs);
  if (age > FRESHNESS_THRESHOLDS.staleMaxAgeMs) return 'historical';
  if (age > FRESHNESS_THRESHOLDS.recentMaxAgeMs) return 'stale';
  if (accuracyM > FRESHNESS_THRESHOLDS.goodAccuracyM || input.reducedAccuracy) return 'approximate';
  if (age <= FRESHNESS_THRESHOLDS.freshMaxAgeMs) return 'fresh';
  return 'recent';
}

/** Можно ли анимировать точку как «живую». Только свежая. */
export function isLive(status: FreshnessStatus): boolean {
  return status === 'fresh';
}

// ---------- Политика приёма точек ----------
export const FIX_POLICY = {
  maxBatch: 100,
  maxAccuracyM: 50_000, // больше — отклоняем как invalid_accuracy
  lowQualityAccuracyM: 1_000, // больше — принимаем, но качество low_quality
  futureToleranceMs: 2 * 60_000, // measured_at позже сервера больше чем на 2 мин — future_timestamp
  maxPlausibleSpeedMps: 340, // быстрее звука с учётом погрешностей — suspect (хранится, не показывается)
  // Точка, измеренная чуть раньше включения обмена (до 2 мин), показывается: телефон измеряет
  // до нажатия кнопки. Более старые точки до момента согласия не раскрываются.
  grantGraceMs: 2 * 60_000,
  localQueueMax: 500, // локальная очередь на устройстве
  localQueueMaxAgeMs: 24 * 60 * 60_000, // старше TTL — не отправляется (политика: отброс с записью в журнал)
} as const;

export type FixSource =
  | 'bg_task' // системные фоновые обновления (startLocationUpdatesAsync)
  | 'fg_watch' // подписка при открытом приложении
  | 'refresh' // ответ на ручной запрос обновления
  | 'manual' // кнопка «Отправить точку сейчас»
  | 'geofence'; // событие геозоны

export type AppStateValue = 'active' | 'background' | 'inactive' | 'unknown';

export interface FixInput {
  clientFixId: string; // uuid, генерирует устройство — ключ идемпотентности
  measuredAt: number; // мс epoch, время измерения ОС (location.timestamp)
  lat: number;
  lon: number;
  accuracyM: number;
  altitude?: number | null;
  altitudeAccuracyM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  isMocked?: boolean | null; // только Android даёт
  source: FixSource;
  appState?: AppStateValue;
  networkType?: string | null; // wifi / cellular / none / unknown — как сообщила ОС
  batteryLevel?: number | null; // 0..1
  sharingMode?: SharingMode;
  reducedAccuracy?: boolean | null; // iOS reduced / Android coarse
  refreshRequestId?: string | null;
  scenario?: string | null; // метка сценария испытаний
  enqueuedAt?: number | null; // когда точка попала в локальную очередь
  attempt?: number | null; // номер попытки отправки
}

export interface FixBatchRequest {
  sentAt: number; // часы устройства в момент отправки
  fixes: FixInput[];
}

export type FixResultStatus = 'accepted' | 'low_quality' | 'suspect' | 'duplicate' | 'rejected';
export type FixRejectReason =
  | 'invalid_lat'
  | 'invalid_lon'
  | 'null_island'
  | 'invalid_accuracy'
  | 'invalid_timestamp'
  | 'future_timestamp'
  | 'expired'
  | 'sharing_off'
  | 'invalid_payload';

export interface FixResult {
  clientFixId: string;
  status: FixResultStatus;
  reason?: FixRejectReason | string;
  late?: boolean; // точка старее уже принятой — сохранена как историческая, «последней» не стала
  receivedAt?: number;
}

export interface FixBatchResponse {
  serverTime: number;
  clockSkewMs: number; // receivedAt - sentAt (включает сетевую задержку)
  results: FixResult[];
  pendingRefreshRequests: PendingRefresh[];
}

export interface PendingRefresh {
  id: string;
  requesterDeviceId: string;
  requesterName: string;
  createdAt: number;
  deadlineAt: number;
  state: RefreshState;
}

// ---------- Запрос обновления (конечный автомат) ----------
export type RefreshState =
  | 'created'
  | 'server_accepted'
  | 'push_sent' // отдан push-провайдеру. НЕ означает, что телефон получил
  | 'push_not_configured'
  | 'push_failed'
  | 'device_received' // телефон ЯВНО подтвердил получение
  | 'fix_measured' // телефон сообщил, что измерил точку
  | 'delivered' // точка дошла до сервера
  | 'timeout'
  | 'failed' // телефон сообщил отказ/ошибку
  | 'access_denied'
  | 'access_revoked'
  | 'unknown';

export const REFRESH_TERMINAL: readonly RefreshState[] = [
  'delivered',
  'timeout',
  'failed',
  'access_denied',
  'access_revoked',
];

export const REFRESH_STATE_RU: Record<RefreshState, string> = {
  created: 'Запрос создан',
  server_accepted: 'Принят сервером',
  push_sent: 'Передан push-провайдеру (это ещё не значит, что телефон получил)',
  push_not_configured: 'Push не настроен — ждём, пока телефон сам спросит сервер',
  push_failed: 'Push-провайдер отказал',
  device_received: 'Телефон подтвердил получение',
  fix_measured: 'Телефон измерил точку',
  delivered: 'Точка доставлена',
  timeout: 'Таймаут: ответа нет',
  failed: 'Телефон сообщил об ошибке',
  access_denied: 'Доступ запрещён',
  access_revoked: 'Связь разорвана',
  unknown: 'Причина неизвестна',
};

export type RefreshProgressStage = 'device_received' | 'fix_measured' | 'failed';
export type RefreshDeliveryChannel = 'poll' | 'push' | 'fix_response' | 'unknown';

export interface RefreshRequestView {
  id: string;
  pairId: string;
  requesterDeviceId: string;
  targetDeviceId: string;
  state: RefreshState;
  createdAt: number;
  deadlineAt: number;
  updatedAt: number;
  failureReason: string | null;
  fixMeasuredAt: number | null;
  fixReceivedAt: number | null;
  measuredBeforeRequest: boolean | null;
  events: { state: RefreshState; at: number; detail: Record<string, unknown> | null }[];
}

export const REFRESH_POLICY = {
  timeoutMs: 90_000,
  maxPerHourPerDirection: 30,
} as const;

// ---------- Пары / приглашения ----------
export const INVITE_POLICY = {
  ttlMs: 10 * 60_000,
  codeLength: 8,
  alphabet: '23456789ABCDEFGHJKMNPQRSTUVWXYZ', // без 0/O/1/I/L
  maxFailedAttemptsPerDeviceWindow: 8,
  attemptWindowMs: 10 * 60_000,
} as const;

export function normalizeInviteCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export interface DeviceStatusReport {
  reportedAt: number;
  foregroundPermission: 'granted' | 'denied' | 'undetermined';
  backgroundPermission: 'granted' | 'denied' | 'undetermined' | 'unknown';
  accuracyPermission: 'full' | 'reduced' | 'fine' | 'coarse' | 'none' | 'unknown';
  servicesEnabled: boolean | null;
  gpsAvailable: boolean | null; // только Android сообщает
  networkProviderAvailable: boolean | null; // только Android
  backgroundTaskRunning: boolean | null;
  notificationsPermission: 'granted' | 'denied' | 'undetermined' | 'unknown';
  batteryLevel: number | null;
  lowPowerMode: boolean | null;
  appVersion: string | null;
}

export interface PeerLocationResponse {
  serverTime: number;
  pairId: string;
  peer: { deviceId: string; name: string; platform: string; lastSeenAt: number | null };
  access:
    | 'ok'
    | 'peer_sharing_off' // собеседник выключил обмен (или режим OFF)
    | 'no_fix_since_enabled'; // обмен включён, но точек после включения ещё нет
  peerMode: SharingMode;
  activeTripUntil: number | null;
  fix: null | {
    measuredAt: number;
    receivedAt: number;
    lat: number;
    lon: number;
    accuracyM: number;
    source: FixSource;
    quality: 'accepted' | 'low_quality';
    reducedAccuracy: boolean | null;
    clockSkewMs: number | null;
    appState: string | null;
    networkType: string | null;
  };
  suspectFixesSinceLast: number;
  peerStatus: DeviceStatusReport | null;
}

// ---------- Диагностика ----------
export interface DiagnosticEventInput {
  clientEventId: string;
  occurredAt: number;
  type: string;
  data?: Record<string, unknown>;
}

// Человеческие названия событий журнала
export const DIAG_TYPE_RU: Record<string, string> = {
  app_launch: 'Приложение запущено',
  app_state: 'Состояние приложения изменилось',
  bg_task_started: 'Фоновые обновления включены',
  bg_task_stopped: 'Фоновые обновления выключены',
  bg_task_error: 'Ошибка фоновой задачи',
  bg_locations: 'Система прислала координаты (фон)',
  fg_location: 'Координата при открытом приложении',
  permission: 'Разрешения',
  mode_changed: 'Режим обмена изменён',
  upload_ok: 'Отправка на сервер: успех',
  upload_failed: 'Отправка на сервер: ошибка',
  fix_rejected: 'Сервер отклонил точку',
  queue_dropped: 'Точки удалены из очереди',
  network: 'Сеть изменилась',
  refresh_seen: 'Получен запрос обновления',
  refresh_answered: 'Ответ на запрос обновления',
  refresh_failed: 'Не удалось ответить на запрос',
  push_token: 'Push-токен',
  push_received: 'Получен push',
  geofence: 'Геозона',
  geofence_event: 'Событие геозоны',
  scenario: 'Сценарий испытания',
  pair: 'Связь',
  error: 'Ошибка',
};

export const LOCATION_TTL_HOURS_DEFAULT = 24;

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** Расстояние по большому кругу, м */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
