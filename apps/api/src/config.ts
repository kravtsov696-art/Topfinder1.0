// Конфигурация только из переменных окружения. Секретов в репозитории нет.

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  locationTtlHours: number;
  diagTtlDays: number;
  pairTtlDays: number;
  refreshTimeoutMs: number;
  pushProvider: 'none' | 'expo';
  expoAccessToken: string | null;
  adminToken: string | null;
  registrationKey: string | null;
  sweepIntervalMs: number;
  logRequests: boolean;
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Неверное число в env: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан (см. .env.example)');
  const pushProvider = (env.PUSH_PROVIDER ?? 'none') as Config['pushProvider'];
  if (pushProvider !== 'none' && pushProvider !== 'expo') throw new Error('PUSH_PROVIDER: none | expo');
  const adminToken = env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 24 ? env.ADMIN_TOKEN : null;
  if (env.ADMIN_TOKEN && !adminToken) throw new Error('ADMIN_TOKEN должен быть не короче 24 символов');
  return {
    port: num(env.PORT, 8080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl,
    locationTtlHours: num(env.LOCATION_TTL_HOURS, 24),
    diagTtlDays: num(env.DIAG_TTL_DAYS, 7),
    pairTtlDays: num(env.PAIR_TTL_DAYS, 14),
    refreshTimeoutMs: num(env.REFRESH_TIMEOUT_MS, 90_000),
    pushProvider,
    expoAccessToken: env.EXPO_ACCESS_TOKEN || null,
    adminToken,
    registrationKey: env.REGISTRATION_KEY || null,
    sweepIntervalMs: num(env.SWEEP_INTERVAL_MS, 60_000),
    logRequests: env.LOG_REQUESTS !== '0',
  };
}
