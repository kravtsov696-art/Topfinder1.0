import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.ts';
import { createDb, migrate, type Sql } from '../src/db.ts';
import type { Config } from '../src/config.ts';
import type { PushSender } from '../src/push.ts';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/blizkie_test';

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: TEST_DB,
    locationTtlHours: 24,
    diagTtlDays: 7,
    pairTtlDays: 14,
    refreshTimeoutMs: 90_000,
    pushProvider: 'none',
    expoAccessToken: null,
    adminToken: 'test-admin-token-0123456789abcdef',
    registrationKey: null,
    sweepIntervalMs: 60_000,
    logRequests: false,
    ...over,
  };
}

export interface Harness {
  sql: Sql;
  base: string;
  clock: { now: number };
  app: ReturnType<typeof buildApp>;
  server: Server;
  close: () => Promise<void>;
}

let sqlSingleton: Sql | null = null;

export async function startHarness(opts: { config?: Partial<Config>; push?: PushSender } = {}): Promise<Harness> {
  if (!sqlSingleton) {
    sqlSingleton = createDb(TEST_DB);
    await migrate(sqlSingleton);
  }
  const sql = sqlSingleton;
  await sql`TRUNCATE users, devices, invites, pairs, pair_grants, location_fixes, refresh_requests, refresh_request_events, diagnostic_events CASCADE`;
  const clock = { now: Date.UTC(2026, 9, 11, 12, 0, 0) };
  const app = buildApp({ sql, config: testConfig(opts.config), clock: () => clock.now, push: opts.push, log: () => {} });
  const server = await app.listen(0, '127.0.0.1');
  const port = (server.address() as AddressInfo).port;
  return {
    sql,
    base: `http://127.0.0.1:${port}`,
    clock,
    app,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function endDb() {
  if (sqlSingleton) await sqlSingleton.end({ timeout: 2 });
  sqlSingleton = null;
}

export interface Res {
  status: number;
  body: any;
  text: string;
}

export async function call(h: Harness, method: string, path: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(h.base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: r.status, body: parsed, text };
}

export async function register(h: Harness, name: string, platform = 'test') {
  const r = await call(h, 'POST', '/v1/devices/register', null, { platform, displayName: name, model: 'x', osVersion: '1' });
  if (r.status !== 201) throw new Error(`register ${r.status} ${r.text}`);
  return { id: r.body.deviceId as string, token: r.body.token as string };
}

/** Две связанные устройства, оба включили обмен и режим ECO. */
export async function pairedDevices(h: Harness, opts: { enableSharing?: boolean } = {}) {
  const a = await register(h, 'Android A', 'android');
  const b = await register(h, 'iPhone B', 'ios');
  const inv = await call(h, 'POST', '/v1/invites', a.token);
  const acc = await call(h, 'POST', '/v1/invites/accept', b.token, { code: inv.body.code, confirm: true });
  if (acc.status !== 201) throw new Error(`accept ${acc.status} ${acc.text}`);
  const pairId = acc.body.pairId as string;
  if (opts.enableSharing !== false) {
    for (const d of [a, b]) {
      await call(h, 'PUT', '/v1/me/mode', d.token, { mode: 'ECO' });
      await call(h, 'PUT', `/v1/pairs/${pairId}/sharing`, d.token, { enabled: true });
    }
  }
  return { a, b, pairId };
}

export function fix(over: Record<string, unknown> = {}) {
  return {
    clientFixId: randomUUID(),
    measuredAt: Date.UTC(2026, 9, 11, 12, 0, 0) - 5_000,
    lat: 45.0355,
    lon: 38.9753,
    accuracyM: 12,
    source: 'fg_watch',
    appState: 'active',
    ...over,
  };
}

export async function postFixes(h: Harness, token: string, fixes: unknown[], sentAt?: number) {
  return call(h, 'POST', '/v1/fixes', token, { sentAt: sentAt ?? h.clock.now, fixes });
}
