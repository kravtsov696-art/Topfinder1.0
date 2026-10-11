// Приём точек: проверка, классификация, идемпотентность, порядок по measured_at.
import {
  FIX_POLICY,
  haversineM,
  type FixInput,
  type FixResult,
  type FixRejectReason,
} from '../../../packages/shared/src/index.ts';
import { isUuid } from './http.ts';
import type { Sql } from './db.ts';

const SOURCES = new Set(['bg_task', 'fg_watch', 'refresh', 'manual', 'geofence']);

export type Validation = { ok: true; fix: FixInput } | { ok: false; reason: FixRejectReason };

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Чистая проверка одной точки (без БД). now — серверное время. */
export function validateFix(raw: unknown, now: number, ttlMs: number): Validation {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid_payload' };
  const f = raw as Record<string, unknown>;
  if (!isUuid(f.clientFixId)) return { ok: false, reason: 'invalid_payload' };
  if (typeof f.source !== 'string' || !SOURCES.has(f.source)) return { ok: false, reason: 'invalid_payload' };
  const lat = f.lat;
  const lon = f.lon;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, reason: 'invalid_lat' };
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return { ok: false, reason: 'invalid_lon' };
  if (lat === 0 && lon === 0) return { ok: false, reason: 'null_island' };
  const acc = f.accuracyM;
  if (typeof acc !== 'number' || !Number.isFinite(acc) || acc <= 0 || acc > FIX_POLICY.maxAccuracyM) {
    return { ok: false, reason: 'invalid_accuracy' };
  }
  const t = f.measuredAt;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 1_500_000_000_000) return { ok: false, reason: 'invalid_timestamp' };
  if (t > now + FIX_POLICY.futureToleranceMs) return { ok: false, reason: 'future_timestamp' };
  if (t < now - ttlMs) return { ok: false, reason: 'expired' };
  const fix: FixInput = {
    clientFixId: (f.clientFixId as string).toLowerCase(),
    measuredAt: Math.round(t),
    lat,
    lon,
    accuracyM: acc,
    altitude: finiteOrNull(f.altitude),
    altitudeAccuracyM: finiteOrNull(f.altitudeAccuracyM),
    speedMps: finiteOrNull(f.speedMps),
    headingDeg: finiteOrNull(f.headingDeg),
    isMocked: typeof f.isMocked === 'boolean' ? f.isMocked : null,
    source: f.source as FixInput['source'],
    appState: typeof f.appState === 'string' ? (f.appState.slice(0, 20) as FixInput['appState']) : 'unknown',
    networkType: typeof f.networkType === 'string' ? f.networkType.slice(0, 30) : null,
    batteryLevel: finiteOrNull(f.batteryLevel),
    sharingMode: typeof f.sharingMode === 'string' ? (f.sharingMode as FixInput['sharingMode']) : undefined,
    reducedAccuracy: typeof f.reducedAccuracy === 'boolean' ? f.reducedAccuracy : null,
    refreshRequestId: isUuid(f.refreshRequestId) ? (f.refreshRequestId as string).toLowerCase() : null,
    scenario: typeof f.scenario === 'string' ? f.scenario.slice(0, 80) : null,
    enqueuedAt: finiteOrNull(f.enqueuedAt),
    attempt: finiteOrNull(f.attempt),
  };
  return { ok: true, fix };
}

/**
 * Физическая правдоподобность относительно соседней принятой точки.
 * Расстояние сверх суммы погрешностей, делённое на интервал, не должно превышать скорость звука.
 * Самолёт и скачок после долгого отсутствия сети НЕ отбрасываются: при большом dt порог растёт линейно.
 */
export function isPlausible(
  a: { lat: number; lon: number; accuracyM: number; measuredAt: number },
  b: { lat: number; lon: number; accuracyM: number; measuredAt: number },
): boolean {
  const dist = haversineM(a.lat, a.lon, b.lat, b.lon);
  const slack = a.accuracyM + b.accuracyM;
  const dtS = Math.abs(a.measuredAt - b.measuredAt) / 1000;
  return dist - slack <= FIX_POLICY.maxPlausibleSpeedMps * Math.max(dtS, 1);
}

export interface IngestContext {
  sql: Sql;
  deviceId: string;
  sharingMode: string;
  now: number;
  ttlMs: number;
  sentAt: number | null;
  postgis: boolean;
}

export interface IngestedFix {
  result: FixResult;
  fixId?: string;
  fix?: FixInput;
}

export async function ingestFixes(ctx: IngestContext, rawFixes: unknown[]): Promise<IngestedFix[]> {
  const { sql, deviceId, now } = ctx;
  const clockSkewMs = ctx.sentAt !== null ? Math.round(now - ctx.sentAt) : null;
  const out: IngestedFix[] = new Array(rawFixes.length);

  // 1) Идемпотентность: уже принятые clientFixId → duplicate
  const ids = rawFixes
    .map((r) => (r && typeof r === 'object' ? (r as any).clientFixId : null))
    .filter(isUuid)
    .map((s) => s.toLowerCase());
  const existing = new Set<string>();
  if (ids.length) {
    const rows = await sql`SELECT client_fix_id FROM location_fixes WHERE device_id = ${deviceId} AND client_fix_id IN ${sql(ids)}`;
    for (const r of rows) existing.add(String(r.client_fix_id));
  }

  // 2) Проверка каждой точки
  const valid: { idx: number; fix: FixInput }[] = [];
  rawFixes.forEach((raw, idx) => {
    const id = raw && typeof raw === 'object' ? String((raw as any).clientFixId ?? '') : '';
    if (existing.has(id.toLowerCase())) {
      out[idx] = { result: { clientFixId: id, status: 'duplicate' } };
      return;
    }
    const v = validateFix(raw, now, ctx.ttlMs);
    if (!v.ok) {
      out[idx] = { result: { clientFixId: id, status: 'rejected', reason: v.reason } };
      return;
    }
    if (ctx.sharingMode === 'OFF') {
      out[idx] = { result: { clientFixId: id, status: 'rejected', reason: 'sharing_off' } };
      return;
    }
    valid.push({ idx, fix: v.fix });
  });

  // 3) Обработка в порядке measured_at, чтобы проверка правдоподобия шла по времени измерения
  valid.sort((a, b) => a.fix.measuredAt - b.fix.measuredAt);
  for (const { idx, fix } of valid) {
    const measured = new Date(fix.measuredAt);
    const [prev] = await sql`
      SELECT lat, lon, accuracy_m, measured_at FROM location_fixes
      WHERE device_id = ${deviceId} AND quality <> 'suspect' AND measured_at <= ${measured}
      ORDER BY measured_at DESC LIMIT 1`;
    const [next] = await sql`
      SELECT lat, lon, accuracy_m, measured_at FROM location_fixes
      WHERE device_id = ${deviceId} AND quality <> 'suspect' AND measured_at > ${measured}
      ORDER BY measured_at ASC LIMIT 1`;
    let quality: 'accepted' | 'low_quality' | 'suspect' = fix.accuracyM > FIX_POLICY.lowQualityAccuracyM ? 'low_quality' : 'accepted';
    for (const n of [prev, next]) {
      if (!n) continue;
      const other = { lat: n.lat, lon: n.lon, accuracyM: n.accuracy_m, measuredAt: (n.measured_at as Date).getTime() };
      if (!isPlausible(fix, other)) quality = 'suspect';
    }
    const late = Boolean(next); // есть точка новее по времени измерения → эта не станет «последней»

    const inserted = await sql`
      INSERT INTO location_fixes (
        device_id, client_fix_id, measured_at, received_at, device_sent_at, clock_skew_ms,
        lat, lon, accuracy_m, altitude, altitude_accuracy_m, speed_mps, heading_deg, is_mocked, reduced_accuracy,
        source, app_state, network_type, battery_level, sharing_mode, scenario, enqueued_at, attempt,
        quality, late, refresh_request_id
      ) VALUES (
        ${deviceId}, ${fix.clientFixId}, ${measured}, ${new Date(now)}, ${ctx.sentAt !== null ? new Date(ctx.sentAt) : null}, ${clockSkewMs},
        ${fix.lat}, ${fix.lon}, ${fix.accuracyM}, ${fix.altitude ?? null}, ${fix.altitudeAccuracyM ?? null}, ${fix.speedMps ?? null},
        ${fix.headingDeg ?? null}, ${fix.isMocked ?? null}, ${fix.reducedAccuracy ?? null},
        ${fix.source}, ${fix.appState ?? null}, ${fix.networkType ?? null}, ${fix.batteryLevel ?? null}, ${ctx.sharingMode},
        ${fix.scenario ?? null}, ${fix.enqueuedAt ? new Date(fix.enqueuedAt) : null}, ${fix.attempt ?? null},
        ${quality}, ${late}, ${fix.refreshRequestId ?? null}
      )
      ON CONFLICT (device_id, client_fix_id) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) {
      out[idx] = { result: { clientFixId: fix.clientFixId, status: 'duplicate' } };
      continue;
    }
    const fixId = String(inserted[0].id);
    if (ctx.postgis) {
      await sql`UPDATE location_fixes SET geog = ST_SetSRID(ST_MakePoint(${fix.lon}, ${fix.lat}), 4326)::geography WHERE id = ${fixId}`;
    }
    out[idx] = {
      result: { clientFixId: fix.clientFixId, status: quality, late, receivedAt: now },
      fixId,
      fix,
    };
  }
  return out;
}
