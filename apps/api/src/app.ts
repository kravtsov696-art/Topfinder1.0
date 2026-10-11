import { createServer, type Server } from 'node:http';
import {
  ACTIVE_TRIP_MAX_MINUTES,
  ACTIVE_TRIP_DEFAULT_MINUTES,
  FIX_POLICY,
  INVITE_POLICY,
  REFRESH_POLICY,
  REFRESH_TERMINAL,
  SHARING_MODES,
  normalizeInviteCode,
  type FixBatchResponse,
  type PeerLocationResponse,
  type PendingRefresh,
  type RefreshRequestView,
  type RefreshState,
  type SharingMode,
} from '../../../packages/shared/src/index.ts';
import type { Config } from './config.ts';
import type { Sql } from './db.ts';
import { HttpError, Router, isReply, obj, readJson, requireUuid, send, str, isUuid, type Ctx } from './http.ts';
import { ingestFixes } from './fixes.ts';
import { NoPush, type PushSender } from './push.ts';
import { RateLimiter, newInviteCode, newToken, safeEqual, sha256, stripCoordinates, uuid } from './security.ts';
import { toCsv } from './csv.ts';

export interface Device {
  id: string;
  user_id: string;
  display_name: string;
  platform: string;
  sharing_mode: SharingMode;
  active_trip_until: Date | null;
}

export interface AppDeps {
  sql: Sql;
  config: Config;
  push?: PushSender;
  clock?: () => number;
  postgis?: boolean;
  log?: (line: string) => void;
}

const TERMINAL = new Set<string>(REFRESH_TERMINAL);
const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

export function buildApp(deps: AppDeps) {
  const { sql, config } = deps;
  const push = deps.push ?? new NoPush();
  const clock = deps.clock ?? (() => Date.now());
  const postgis = deps.postgis ?? false;
  const log = deps.log ?? ((l: string) => console.log(l));
  const ttlMs = config.locationTtlHours * 3600_000;
  const router = new Router<Device>();
  const apiLimiter = new RateLimiter(600, 60_000);
  const registerLimiter = new RateLimiter(20, 60_000);
  const inviteFailLimiter = new RateLimiter(INVITE_POLICY.maxFailedAttemptsPerDeviceWindow, INVITE_POLICY.attemptWindowMs);

  // ---------------- helpers ----------------
  async function authDevice(header: string | undefined, now: number): Promise<Device> {
    if (!header || !header.startsWith('Bearer ')) throw new HttpError(401, 'unauthorized');
    const token = header.slice(7).trim();
    if (token.length < 20 || token.length > 200) throw new HttpError(401, 'unauthorized');
    const [d] = await sql`
      SELECT id, user_id, display_name, platform, sharing_mode, active_trip_until, last_seen_at
      FROM devices WHERE token_hash = ${sha256(token)} AND deleted_at IS NULL`;
    if (!d) throw new HttpError(401, 'unauthorized');
    if (!d.last_seen_at || now - (d.last_seen_at as Date).getTime() > 15_000) {
      await sql`UPDATE devices SET last_seen_at = ${new Date(now)} WHERE id = ${d.id}`;
    }
    return d as unknown as Device;
  }

  /** Пара, в которой участвует устройство. Чужая пара → 404 (не раскрываем существование). */
  async function memberPair(pairId: string, deviceId: string, now: number, allowInactive = false) {
    const [p] = await sql`SELECT * FROM pairs WHERE id = ${pairId}`;
    if (!p || (p.initiator_device_id !== deviceId && p.acceptor_device_id !== deviceId)) {
      throw new HttpError(404, 'not_found');
    }
    const peerId: string = p.initiator_device_id === deviceId ? p.acceptor_device_id : p.initiator_device_id;
    if (!allowInactive) {
      if (p.revoked_at) throw new HttpError(403, 'pair_revoked', 'Связь разорвана');
      if ((p.expires_at as Date).getTime() <= now) throw new HttpError(403, 'pair_expired', 'Срок связи истёк');
      const [peer] = await sql`SELECT deleted_at FROM devices WHERE id = ${peerId}`;
      if (!peer || peer.deleted_at) throw new HttpError(403, 'pair_revoked', 'Устройство собеседника удалено');
    }
    return { pair: p, peerId };
  }

  async function addRefreshEvent(requestId: string, state: string, at: number, detail: Record<string, unknown> | null) {
    await sql`INSERT INTO refresh_request_events (request_id, state, at, detail) VALUES (${requestId}, ${state}, ${new Date(at)}, ${detail ? sql.json(detail as any) : null})`;
  }

  async function setRefreshState(requestId: string, state: RefreshState, at: number, detail: Record<string, unknown> | null, extra: { failureReason?: string; pushTicket?: string | null } = {}) {
    await sql`UPDATE refresh_requests SET state = ${state}, updated_at = ${new Date(at)},
      failure_reason = COALESCE(${extra.failureReason ?? null}, failure_reason),
      push_ticket = COALESCE(${extra.pushTicket ?? null}, push_ticket)
      WHERE id = ${requestId}`;
    await addRefreshEvent(requestId, state, at, detail);
  }

  /** Просроченные запросы → timeout. Вызывается перед чтением и периодически. */
  async function expireRefreshRequests(now: number): Promise<number> {
    const rows = await sql`
      UPDATE refresh_requests SET state = 'timeout', updated_at = ${new Date(now)}
      WHERE deadline_at <= ${new Date(now)} AND state NOT IN ${sql([...TERMINAL])}
      RETURNING id, state`;
    for (const r of rows) await addRefreshEvent(r.id, 'timeout', now, { reason: 'deadline_passed' });
    return rows.length;
  }

  async function refreshView(id: string): Promise<RefreshRequestView> {
    const [r] = await sql`SELECT * FROM refresh_requests WHERE id = ${id}`;
    const events = await sql`SELECT state, at, detail FROM refresh_request_events WHERE request_id = ${id} ORDER BY at, id`;
    return {
      id: r.id,
      pairId: r.pair_id,
      requesterDeviceId: r.requester_device_id,
      targetDeviceId: r.target_device_id,
      state: r.state,
      createdAt: ms(r.created_at)!,
      deadlineAt: ms(r.deadline_at)!,
      updatedAt: ms(r.updated_at)!,
      failureReason: r.failure_reason,
      fixMeasuredAt: ms(r.fix_measured_at),
      fixReceivedAt: ms(r.fix_received_at),
      measuredBeforeRequest: r.fix_measured_at ? (r.fix_measured_at as Date).getTime() < (r.created_at as Date).getTime() : null,
      events: events.map((e) => ({ state: e.state, at: ms(e.at)!, detail: e.detail })),
    };
  }

  async function pendingFor(deviceId: string, now: number): Promise<PendingRefresh[]> {
    await expireRefreshRequests(now);
    const rows = await sql`
      SELECT r.id, r.requester_device_id, d.display_name, r.created_at, r.deadline_at, r.state
      FROM refresh_requests r
      JOIN pairs p ON p.id = r.pair_id AND p.revoked_at IS NULL
      JOIN devices d ON d.id = r.requester_device_id
      WHERE r.target_device_id = ${deviceId} AND r.state NOT IN ${sql([...TERMINAL])}
        AND r.state NOT IN ('fix_measured')
      ORDER BY r.created_at`;
    return rows.map((r) => ({
      id: r.id,
      requesterDeviceId: r.requester_device_id,
      requesterName: r.display_name,
      createdAt: ms(r.created_at)!,
      deadlineAt: ms(r.deadline_at)!,
      state: r.state,
    }));
  }

  async function cancelOpenRefreshes(where: { pairId: string; targetId?: string; requesterId?: string }, state: 'access_revoked' | 'access_denied', now: number) {
    const rows = await sql`
      UPDATE refresh_requests SET state = ${state}, updated_at = ${new Date(now)}
      WHERE pair_id = ${where.pairId} AND state NOT IN ${sql([...TERMINAL])}
        ${where.targetId ? sql`AND target_device_id = ${where.targetId}` : sql``}
        ${where.requesterId ? sql`AND requester_device_id = ${where.requesterId}` : sql``}
      RETURNING id`;
    for (const r of rows) await addRefreshEvent(r.id, state, now, null);
  }

  // ---------------- routes ----------------
  router.add('GET', '/health', 'none', async ({ now }) => {
    await sql`SELECT 1`;
    return { ok: true, serverTime: now, postgis, push: push.configured ? 'expo' : 'none', locationTtlHours: config.locationTtlHours };
  });

  router.add('POST', '/v1/devices/register', 'none', async ({ body, req, now }) => {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    if (!registerLimiter.hit(`reg:${ip}`, now)) throw new HttpError(429, 'rate_limited');
    const b = obj(body);
    if (config.registrationKey && !(typeof b.registrationKey === 'string' && safeEqual(b.registrationKey, config.registrationKey))) {
      throw new HttpError(403, 'registration_key_invalid', 'Неверный тестовый ключ регистрации');
    }
    const platform = str(b.platform, 10, 'platform');
    if (!['ios', 'android', 'test'].includes(platform!)) throw new HttpError(400, 'invalid_payload', 'platform');
    const displayName = str(b.displayName, 40, 'displayName')!.trim() || 'Телефон';
    const token = newToken();
    const userId = uuid();
    const deviceId = uuid();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO users (id, created_at) VALUES (${userId}, ${new Date(now)})`;
      await tx`INSERT INTO devices (id, user_id, token_hash, platform, model, os_version, app_version, display_name, created_at, last_seen_at, mode_changed_at)
        VALUES (${deviceId}, ${userId}, ${sha256(token)}, ${platform}, ${str(b.model, 80, 'model', false)}, ${str(b.osVersion, 40, 'osVersion', false)},
                ${str(b.appVersion, 40, 'appVersion', false)}, ${displayName}, ${new Date(now)}, ${new Date(now)}, ${new Date(now)})`;
    });
    return { status: 201, body: { deviceId, token, serverTime: now } };
  });

  router.add('GET', '/v1/me', 'device', async ({ device, now }) => {
    const [d] = await sql`SELECT id, display_name, platform, model, os_version, app_version, sharing_mode, active_trip_until, mode_changed_at, push_token IS NOT NULL AS has_push, created_at FROM devices WHERE id = ${device.id}`;
    const [last] = await sql`SELECT measured_at, received_at, accuracy_m, lat, lon, source, quality FROM location_fixes WHERE device_id = ${device.id} ORDER BY measured_at DESC LIMIT 1`;
    const [lastRecv] = await sql`SELECT max(received_at) AS t FROM location_fixes WHERE device_id = ${device.id}`;
    return {
      serverTime: now,
      device: {
        id: d.id,
        displayName: d.display_name,
        platform: d.platform,
        sharingMode: d.sharing_mode,
        activeTripUntil: ms(d.active_trip_until),
        modeChangedAt: ms(d.mode_changed_at),
        hasPushToken: d.has_push,
      },
      // Последняя точка — только самому владельцу
      lastFix: last
        ? { measuredAt: ms(last.measured_at), receivedAt: ms(last.received_at), accuracyM: last.accuracy_m, lat: last.lat, lon: last.lon, source: last.source, quality: last.quality }
        : null,
      lastServerReceiveAt: ms(lastRecv?.t ?? null),
    };
  });

  router.add('PUT', '/v1/me/profile', 'device', async ({ device, body }) => {
    const name = str(obj(body).displayName, 40, 'displayName')!.trim();
    if (!name) throw new HttpError(400, 'invalid_payload');
    await sql`UPDATE devices SET display_name = ${name} WHERE id = ${device.id}`;
    return { ok: true };
  });

  router.add('PUT', '/v1/me/mode', 'device', async ({ device, body, now }) => {
    const b = obj(body);
    const mode = b.mode as SharingMode;
    if (!SHARING_MODES.includes(mode)) throw new HttpError(400, 'invalid_payload', 'mode');
    let until: Date | null = null;
    if (mode === 'ACTIVE_TRIP') {
      const minutes = typeof b.activeTripMinutes === 'number' ? b.activeTripMinutes : ACTIVE_TRIP_DEFAULT_MINUTES;
      if (!(minutes > 0 && minutes <= ACTIVE_TRIP_MAX_MINUTES)) throw new HttpError(400, 'invalid_payload', 'activeTripMinutes');
      until = new Date(now + minutes * 60_000);
    }
    await sql`UPDATE devices SET sharing_mode = ${mode}, active_trip_until = ${until}, mode_changed_at = ${new Date(now)} WHERE id = ${device.id}`;
    if (mode === 'OFF') {
      // Открытые запросы к этому устройству больше не могут быть выполнены
      const pairs = await sql`SELECT id FROM pairs WHERE (initiator_device_id = ${device.id} OR acceptor_device_id = ${device.id}) AND revoked_at IS NULL`;
      for (const p of pairs) await cancelOpenRefreshes({ pairId: p.id, targetId: device.id }, 'access_denied', now);
    }
    return { ok: true, sharingMode: mode, activeTripUntil: ms(until) };
  });

  router.add('PUT', '/v1/me/status', 'device', async ({ device, body, now }) => {
    const b = stripCoordinates(obj(body)) as Record<string, unknown>;
    const json = JSON.stringify(b);
    if (json.length > 4000) throw new HttpError(413, 'body_too_large');
    await sql`UPDATE devices SET status_report = ${sql.json(b as any)}, status_reported_at = ${new Date(now)} WHERE id = ${device.id}`;
    return { ok: true };
  });

  router.add('PUT', '/v1/me/push-token', 'device', async ({ device, body, now }) => {
    const b = obj(body);
    const token = str(b.token, 300, 'token', false);
    const kind = str(b.kind, 10, 'kind', false) ?? 'expo';
    await sql`UPDATE devices SET push_token = ${token}, push_token_kind = ${token ? kind : null}, push_token_updated_at = ${new Date(now)} WHERE id = ${device.id}`;
    return { ok: true };
  });

  // ----- приглашения -----
  router.add('POST', '/v1/invites', 'device', async ({ device, now }) => {
    // Одно активное приглашение на устройство: новое отменяет старое
    await sql`UPDATE invites SET cancelled_at = ${new Date(now)} WHERE inviter_device_id = ${device.id} AND consumed_at IS NULL AND cancelled_at IS NULL`;
    const code = newInviteCode();
    const expiresAt = now + INVITE_POLICY.ttlMs;
    await sql`INSERT INTO invites (id, code_hash, inviter_device_id, created_at, expires_at) VALUES (${uuid()}, ${sha256(code)}, ${device.id}, ${new Date(now)}, ${new Date(expiresAt)})`;
    return { status: 201, body: { code, codePretty: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt } };
  });

  async function findInvite(device: Device, rawCode: unknown, now: number) {
    if (inviteFailLimiter.count(`inv:${device.id}`, now) >= INVITE_POLICY.maxFailedAttemptsPerDeviceWindow) {
      throw new HttpError(429, 'too_many_attempts', 'Слишком много неверных попыток, подождите 10 минут');
    }
    const code = normalizeInviteCode(typeof rawCode === 'string' ? rawCode : '');
    const fail = (status: number, codeName: string, msg: string): never => {
      inviteFailLimiter.hit(`inv:${device.id}`, now);
      throw new HttpError(status, codeName, msg);
    };
    if (code.length !== INVITE_POLICY.codeLength) fail(404, 'invite_not_found', 'Код не найден');
    const [inv] = await sql`
      SELECT i.*, d.display_name AS inviter_name, d.platform AS inviter_platform, d.deleted_at AS inviter_deleted
      FROM invites i JOIN devices d ON d.id = i.inviter_device_id WHERE i.code_hash = ${sha256(code)}`;
    if (!inv || inv.cancelled_at || inv.inviter_deleted) return fail(404, 'invite_not_found', 'Код не найден');
    if (inv.consumed_at) return fail(410, 'invite_used', 'Код уже использован');
    if ((inv.expires_at as Date).getTime() <= now) return fail(410, 'invite_expired', 'Срок кода истёк');
    if (inv.inviter_device_id === device.id) throw new HttpError(400, 'own_invite', 'Это ваш собственный код');
    return inv;
  }

  router.add('POST', '/v1/invites/preview', 'device', async ({ device, body, now }) => {
    const inv = await findInvite(device, obj(body).code, now);
    return { inviterName: inv.inviter_name, inviterPlatform: inv.inviter_platform, expiresAt: ms(inv.expires_at) };
  });

  router.add('POST', '/v1/invites/accept', 'device', async ({ device, body, now }) => {
    const b = obj(body);
    if (b.confirm !== true) throw new HttpError(400, 'confirmation_required', 'Нужно явное подтверждение');
    const inv = await findInvite(device, b.code, now);
    const pairId = uuid();
    const result = await sql.begin(async (tx) => {
      const upd = await tx`UPDATE invites SET consumed_at = ${new Date(now)}, consumed_by_device_id = ${device.id}
        WHERE id = ${inv.id} AND consumed_at IS NULL AND cancelled_at IS NULL RETURNING id`;
      if (upd.length === 0) return null; // гонка: код уже использован
      // Повторная связь между теми же устройствами: старые активные пары закрываются
      await tx`UPDATE pairs SET revoked_at = ${new Date(now)}, revoked_by_device_id = ${device.id}
        WHERE revoked_at IS NULL AND ((initiator_device_id = ${inv.inviter_device_id} AND acceptor_device_id = ${device.id})
          OR (initiator_device_id = ${device.id} AND acceptor_device_id = ${inv.inviter_device_id}))`;
      await tx`INSERT INTO pairs (id, initiator_device_id, acceptor_device_id, invite_id, created_at, accepted_at, expires_at)
        VALUES (${pairId}, ${inv.inviter_device_id}, ${device.id}, ${inv.id}, ${new Date(now)}, ${new Date(now)}, ${new Date(now + config.pairTtlDays * 86400_000)})`;
      await tx`INSERT INTO pair_grants (pair_id, owner_device_id, viewer_device_id, enabled, changed_at) VALUES
        (${pairId}, ${inv.inviter_device_id}, ${device.id}, false, ${new Date(now)}),
        (${pairId}, ${device.id}, ${inv.inviter_device_id}, false, ${new Date(now)})`;
      return pairId;
    });
    if (!result) throw new HttpError(410, 'invite_used', 'Код уже использован');
    return { status: 201, body: { pairId, peerName: inv.inviter_name } };
  });

  // ----- пары -----
  router.add('GET', '/v1/pairs', 'device', async ({ device, now }) => {
    const rows = await sql`
      SELECT p.*,
        CASE WHEN p.initiator_device_id = ${device.id} THEN p.acceptor_device_id ELSE p.initiator_device_id END AS peer_id
      FROM pairs p WHERE (p.initiator_device_id = ${device.id} OR p.acceptor_device_id = ${device.id})
        AND (p.revoked_at IS NULL OR p.revoked_at > ${new Date(now - 7 * 86400_000)})
      ORDER BY p.created_at DESC LIMIT 20`;
    const out = [];
    for (const p of rows) {
      const [peer] = await sql`SELECT display_name, platform, deleted_at FROM devices WHERE id = ${p.peer_id}`;
      const grants = await sql`SELECT owner_device_id, enabled, enabled_since FROM pair_grants WHERE pair_id = ${p.id}`;
      const mine = grants.find((g) => g.owner_device_id === device.id);
      const theirs = grants.find((g) => g.owner_device_id === p.peer_id);
      const active = !p.revoked_at && (p.expires_at as Date).getTime() > now && !peer?.deleted_at;
      out.push({
        pairId: p.id,
        peerDeviceId: p.peer_id,
        peerName: peer?.display_name ?? '—',
        peerPlatform: peer?.platform ?? '—',
        initiatedByMe: p.initiator_device_id === device.id,
        createdAt: ms(p.created_at),
        expiresAt: ms(p.expires_at),
        revokedAt: ms(p.revoked_at),
        active,
        iShare: Boolean(mine?.enabled) && active,
        peerShares: Boolean(theirs?.enabled) && active,
      });
    }
    return { serverTime: now, pairs: out };
  });

  router.add('PUT', '/v1/pairs/:id/sharing', 'device', async ({ device, params, body, now }) => {
    const pairId = requireUuid(params.id);
    const { peerId } = await memberPair(pairId, device.id, now);
    const enabled = obj(body).enabled;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'invalid_payload', 'enabled');
    await sql`UPDATE pair_grants SET enabled = ${enabled}, changed_at = ${new Date(now)},
      enabled_since = CASE WHEN ${enabled} AND NOT enabled THEN ${new Date(now)} WHEN ${enabled} THEN enabled_since ELSE NULL END
      WHERE pair_id = ${pairId} AND owner_device_id = ${device.id}`;
    if (!enabled) await cancelOpenRefreshes({ pairId, targetId: device.id, requesterId: peerId }, 'access_denied', now);
    return { ok: true, enabled };
  });

  router.add('DELETE', '/v1/pairs/:id', 'device', async ({ device, params, now }) => {
    const pairId = requireUuid(params.id);
    await memberPair(pairId, device.id, now, true);
    await sql`UPDATE pairs SET revoked_at = COALESCE(revoked_at, ${new Date(now)}), revoked_by_device_id = COALESCE(revoked_by_device_id, ${device.id}) WHERE id = ${pairId}`;
    await sql`UPDATE pair_grants SET enabled = false, enabled_since = NULL, changed_at = ${new Date(now)} WHERE pair_id = ${pairId}`;
    await cancelOpenRefreshes({ pairId }, 'access_revoked', now);
    return { ok: true };
  });

  router.add('GET', '/v1/pairs/:id/peer-location', 'device', async ({ device, params, now }) => {
    const pairId = requireUuid(params.id);
    const { peerId } = await memberPair(pairId, device.id, now);
    const [peer] = await sql`SELECT id, display_name, platform, last_seen_at, sharing_mode, active_trip_until, status_report FROM devices WHERE id = ${peerId}`;
    const [grant] = await sql`SELECT enabled, enabled_since FROM pair_grants WHERE pair_id = ${pairId} AND owner_device_id = ${peerId}`;
    const base: PeerLocationResponse = {
      serverTime: now,
      pairId,
      peer: { deviceId: peer.id, name: peer.display_name, platform: peer.platform, lastSeenAt: ms(peer.last_seen_at) },
      access: 'peer_sharing_off',
      peerMode: peer.sharing_mode,
      activeTripUntil: ms(peer.active_trip_until),
      fix: null,
      suspectFixesSinceLast: 0,
      peerStatus: null,
    };
    if (!grant?.enabled || peer.sharing_mode === 'OFF') return base;
    base.peerStatus = peer.status_report ?? null;
    const since = grant.enabled_since as Date;
    const minTime = new Date(Math.max(since.getTime() - FIX_POLICY.grantGraceMs, now - ttlMs));
    const [f] = await sql`
      SELECT measured_at, received_at, lat, lon, accuracy_m, source, quality, reduced_accuracy, clock_skew_ms, app_state, network_type
      FROM location_fixes
      WHERE device_id = ${peerId} AND quality IN ('accepted', 'low_quality') AND measured_at >= ${minTime}
      ORDER BY measured_at DESC LIMIT 1`;
    if (!f) {
      base.access = 'no_fix_since_enabled';
      return base;
    }
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM location_fixes WHERE device_id = ${peerId} AND quality = 'suspect' AND measured_at > ${f.measured_at}`;
    base.access = 'ok';
    base.suspectFixesSinceLast = n;
    base.fix = {
      measuredAt: ms(f.measured_at)!,
      receivedAt: ms(f.received_at)!,
      lat: f.lat,
      lon: f.lon,
      accuracyM: f.accuracy_m,
      source: f.source,
      quality: f.quality,
      reducedAccuracy: f.reduced_accuracy,
      clockSkewMs: f.clock_skew_ms,
      appState: f.app_state,
      networkType: f.network_type,
    };
    return base;
  });

  // ----- точки -----
  router.add('POST', '/v1/fixes', 'device', async ({ device, body, now }) => {
    const b = obj(body);
    if (!Array.isArray(b.fixes)) throw new HttpError(400, 'invalid_payload', 'fixes');
    if (b.fixes.length > FIX_POLICY.maxBatch) throw new HttpError(413, 'batch_too_large');
    const sentAt = typeof b.sentAt === 'number' && Number.isFinite(b.sentAt) ? b.sentAt : null;
    const [cur] = await sql`SELECT sharing_mode FROM devices WHERE id = ${device.id}`;
    const ingested = await ingestFixes({ sql, deviceId: device.id, sharingMode: cur.sharing_mode, now, ttlMs, sentAt, postgis }, b.fixes);
    // Привязка к запросам обновления
    for (const it of ingested) {
      if (!it.fixId || !it.fix?.refreshRequestId) continue;
      const [r] = await sql`SELECT id, state, target_device_id, created_at FROM refresh_requests WHERE id = ${it.fix.refreshRequestId}`;
      if (!r || r.target_device_id !== device.id) continue;
      const detail = {
        fixMeasuredAt: it.fix.measuredAt,
        measuredBeforeRequest: it.fix.measuredAt < (r.created_at as Date).getTime(),
        accuracyM: Math.round(it.fix.accuracyM),
        quality: it.result.status,
      };
      if (TERMINAL.has(r.state)) {
        await addRefreshEvent(r.id, 'late_fix_after_terminal', now, detail);
        continue;
      }
      await sql`UPDATE refresh_requests SET state = 'delivered', updated_at = ${new Date(now)}, fix_id = ${it.fixId},
        fix_measured_at = ${new Date(it.fix.measuredAt)}, fix_received_at = ${new Date(now)} WHERE id = ${r.id}`;
      await addRefreshEvent(r.id, 'delivered', now, detail);
    }
    const resp: FixBatchResponse = {
      serverTime: now,
      clockSkewMs: sentAt !== null ? Math.round(now - sentAt) : 0,
      results: ingested.map((i) => i.result),
      pendingRefreshRequests: await pendingFor(device.id, now),
    };
    return resp;
  });

  // ----- запросы обновления -----
  router.add('POST', '/v1/pairs/:id/refresh-requests', 'device', async ({ device, params, body, now }) => {
    const pairId = requireUuid(params.id);
    const { peerId } = await memberPair(pairId, device.id, now);
    const b = obj(body);
    const clientRequestId = str(b.clientRequestId, 64, 'clientRequestId')!;
    const [dup] = await sql`SELECT id FROM refresh_requests WHERE requester_device_id = ${device.id} AND client_request_id = ${clientRequestId}`;
    if (dup) return { status: 200, body: await refreshView(dup.id) };
    await expireRefreshRequests(now);
    const [open] = await sql`SELECT id FROM refresh_requests WHERE pair_id = ${pairId} AND requester_device_id = ${device.id} AND state NOT IN ${sql([...TERMINAL])}`;
    if (open) throw new HttpError(409, 'refresh_in_progress', 'Предыдущий запрос ещё выполняется', { requestId: open.id });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM refresh_requests WHERE requester_device_id = ${device.id} AND target_device_id = ${peerId} AND created_at > ${new Date(now - 3600_000)}`;
    if (n >= REFRESH_POLICY.maxPerHourPerDirection) throw new HttpError(429, 'refresh_rate_limited', 'Лимит запросов в час исчерпан');

    const id = uuid();
    const deadline = now + config.refreshTimeoutMs;
    await sql`INSERT INTO refresh_requests (id, client_request_id, pair_id, requester_device_id, target_device_id, created_at, deadline_at, state, updated_at)
      VALUES (${id}, ${clientRequestId}, ${pairId}, ${device.id}, ${peerId}, ${new Date(now)}, ${new Date(deadline)}, 'created', ${new Date(now)})`;
    await addRefreshEvent(id, 'created', now, null);

    const [grant] = await sql`SELECT enabled FROM pair_grants WHERE pair_id = ${pairId} AND owner_device_id = ${peerId}`;
    const [peer] = await sql`SELECT sharing_mode, push_token, push_token_kind FROM devices WHERE id = ${peerId}`;
    if (!grant?.enabled || peer.sharing_mode === 'OFF') {
      await setRefreshState(id, 'access_denied', now, { reason: 'peer_sharing_off' }, { failureReason: 'peer_sharing_off' });
      return { status: 201, body: await refreshView(id) };
    }
    await setRefreshState(id, 'server_accepted', now, null);
    if (push.configured && peer.push_token) {
      const pr = await push.sendRefresh(peer.push_token, peer.push_token_kind ?? 'expo', { requestId: id, requesterName: device.display_name });
      const t = clock();
      if (pr.ok) await setRefreshState(id, 'push_sent', t, { ticket: pr.ticket, note: 'провайдер принял; доставка на телефон не подтверждена' }, { pushTicket: pr.ticket });
      else await setRefreshState(id, 'push_failed', t, { error: pr.error });
    } else {
      await setRefreshState(id, 'push_not_configured', now, { reason: push.configured ? 'no_device_token' : 'server_push_disabled' });
    }
    return { status: 201, body: await refreshView(id) };
  });

  router.add('GET', '/v1/refresh-requests/incoming', 'device', async ({ device, now }) => {
    return { serverTime: now, requests: await pendingFor(device.id, now) };
  });

  router.add('GET', '/v1/refresh-requests/:id', 'device', async ({ device, params, now }) => {
    const id = requireUuid(params.id);
    await expireRefreshRequests(now);
    const [r] = await sql`SELECT requester_device_id, target_device_id FROM refresh_requests WHERE id = ${id}`;
    if (!r || (r.requester_device_id !== device.id && r.target_device_id !== device.id)) throw new HttpError(404, 'not_found');
    return { serverTime: now, request: await refreshView(id) };
  });

  router.add('POST', '/v1/refresh-requests/:id/progress', 'device', async ({ device, params, body, now }) => {
    const id = requireUuid(params.id);
    await expireRefreshRequests(now);
    const b = obj(body);
    const stage = b.stage as string;
    const [r] = await sql`SELECT * FROM refresh_requests WHERE id = ${id}`;
    if (!r || r.target_device_id !== device.id) throw new HttpError(404, 'not_found');
    if (TERMINAL.has(r.state)) {
      await addRefreshEvent(id, `late_${stage}`, now, { channel: b.channel ?? null });
      throw new HttpError(409, 'request_closed', 'Запрос уже закрыт', { state: r.state });
    }
    const channel = ['poll', 'push', 'fix_response', 'unknown'].includes(b.channel) ? b.channel : 'unknown';
    const detail: Record<string, unknown> = { channel };
    if (typeof b.deviceTime === 'number') detail.deviceTime = b.deviceTime;
    if (typeof b.appState === 'string') detail.appState = b.appState.slice(0, 20);
    if (stage === 'device_received') {
      if (r.state === 'device_received' || r.state === 'fix_measured') return { ok: true, state: r.state };
      await setRefreshState(id, 'device_received', now, detail);
    } else if (stage === 'fix_measured') {
      if (typeof b.accuracyM === 'number') detail.accuracyM = Math.round(b.accuracyM);
      await setRefreshState(id, 'fix_measured', now, detail);
    } else if (stage === 'failed') {
      const allowed = ['permission_denied', 'location_unavailable', 'services_disabled', 'sharing_off', 'timeout_on_device', 'unknown'];
      const reason = allowed.includes(b.reason) ? b.reason : 'unknown';
      detail.reason = reason;
      if (typeof b.message === 'string') detail.message = b.message.slice(0, 200);
      await setRefreshState(id, 'failed', now, detail, { failureReason: reason });
    } else {
      throw new HttpError(400, 'invalid_payload', 'stage');
    }
    const [cur] = await sql`SELECT state FROM refresh_requests WHERE id = ${id}`;
    return { ok: true, state: cur.state };
  });

  // ----- диагностика -----
  router.add('POST', '/v1/diagnostics', 'device', async ({ device, body, now }) => {
    const b = obj(body);
    if (!Array.isArray(b.events) || b.events.length > 200) throw new HttpError(400, 'invalid_payload', 'events');
    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const e of b.events) {
      if (!e || !isUuid(e.clientEventId) || typeof e.type !== 'string' || typeof e.occurredAt !== 'number' || !Number.isFinite(e.occurredAt)) {
        rejected++;
        continue;
      }
      const data = stripCoordinates(e.data ?? {}) as Record<string, unknown>;
      if (JSON.stringify(data).length > 4000) {
        rejected++;
        continue;
      }
      const r = await sql`INSERT INTO diagnostic_events (device_id, client_event_id, occurred_at, received_at, type, data)
        VALUES (${device.id}, ${e.clientEventId.toLowerCase()}, ${new Date(e.occurredAt)}, ${new Date(now)}, ${e.type.slice(0, 40)}, ${sql.json(data as any)})
        ON CONFLICT (device_id, client_event_id) DO NOTHING RETURNING id`;
      if (r.length) accepted++;
      else duplicates++;
    }
    return { accepted, duplicates, rejected };
  });

  router.add('GET', '/v1/diagnostics', 'device', async ({ device, query }) => {
    const limit = Math.min(1000, Math.max(1, Number(query.get('limit') ?? 200) || 200));
    const rows = await sql`SELECT client_event_id, occurred_at, received_at, type, data FROM diagnostic_events WHERE device_id = ${device.id} ORDER BY occurred_at DESC LIMIT ${limit}`;
    return { events: rows.map((r) => ({ clientEventId: r.client_event_id, occurredAt: ms(r.occurred_at), receivedAt: ms(r.received_at), type: r.type, data: r.data })) };
  });

  // ----- экспорт / удаление -----
  async function exportData(deviceIds: string[] | null) {
    const devFilter = (col: string) => (deviceIds ? sql`WHERE ${sql(col)} IN ${sql(deviceIds)}` : sql``);
    const devices = await sql`SELECT id, display_name, platform, model, os_version, app_version, sharing_mode, created_at, last_seen_at, status_report, status_reported_at FROM devices ${devFilter('id')} ORDER BY created_at`;
    const fixes = await sql`SELECT f.device_id, d.display_name AS device_name, d.platform, f.client_fix_id, f.measured_at, f.received_at, f.device_sent_at, f.clock_skew_ms,
        EXTRACT(EPOCH FROM (f.received_at - f.measured_at)) * 1000 AS delay_ms,
        f.lat, f.lon, f.accuracy_m, f.altitude, f.speed_mps, f.heading_deg, f.is_mocked, f.reduced_accuracy, f.source, f.app_state, f.network_type,
        f.battery_level, f.sharing_mode, f.scenario, f.enqueued_at, f.attempt, f.quality, f.late, f.refresh_request_id
      FROM location_fixes f JOIN devices d ON d.id = f.device_id ${deviceIds ? sql`WHERE f.device_id IN ${sql(deviceIds)}` : sql``} ORDER BY f.measured_at`;
    const diagnostics = await sql`SELECT e.device_id, d.display_name AS device_name, e.client_event_id, e.occurred_at, e.received_at, e.type, e.data
      FROM diagnostic_events e JOIN devices d ON d.id = e.device_id ${deviceIds ? sql`WHERE e.device_id IN ${sql(deviceIds)}` : sql``} ORDER BY e.occurred_at`;
    const refresh = await sql`SELECT r.id, r.pair_id, r.requester_device_id, r.target_device_id, r.created_at, r.deadline_at, r.state, r.updated_at, r.failure_reason,
        r.fix_measured_at, r.fix_received_at,
        EXTRACT(EPOCH FROM (r.fix_received_at - r.created_at)) * 1000 AS total_ms,
        (SELECT json_agg(json_build_object('state', e.state, 'at', e.at, 'detail', e.detail) ORDER BY e.at, e.id) FROM refresh_request_events e WHERE e.request_id = r.id) AS events
      FROM refresh_requests r ${deviceIds ? sql`WHERE r.requester_device_id IN ${sql(deviceIds)} OR r.target_device_id IN ${sql(deviceIds)}` : sql``} ORDER BY r.created_at`;
    return { devices, fixes, diagnostics, refresh };
  }

  function exportReply(data: Awaited<ReturnType<typeof exportData>>, format: string, kind: string, now: number): any {
    if (format === 'json') {
      return { body: { exportedAt: now, note: 'Сырые тестовые данные P0. Координаты — только устройств-участников экспорта.', ...data } };
    }
    if (format !== 'csv') throw new HttpError(400, 'invalid_payload', 'format: json|csv');
    const table = (data as any)[kind];
    if (!table) throw new HttpError(400, 'invalid_payload', 'kind: devices|fixes|diagnostics|refresh');
    return {
      raw: toCsv(table as any[]),
      contentType: 'text/csv; charset=utf-8',
      headers: { 'content-disposition': `attachment; filename="blizkie_${kind}_${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv"` },
    };
  }

  router.add('GET', '/v1/export', 'device', async ({ device, query, now }) => {
    return exportReply(await exportData([device.id]), query.get('format') ?? 'json', query.get('kind') ?? 'fixes', now);
  });

  router.add('GET', '/v1/admin/export', 'admin', async ({ query, now }) => {
    return exportReply(await exportData(null), query.get('format') ?? 'json', query.get('kind') ?? 'fixes', now);
  });

  async function deleteData(deviceId: string, now: number) {
    const pairs = await sql`SELECT id FROM pairs WHERE (initiator_device_id = ${deviceId} OR acceptor_device_id = ${deviceId}) AND revoked_at IS NULL`;
    for (const p of pairs) {
      await sql`UPDATE pairs SET revoked_at = ${new Date(now)}, revoked_by_device_id = ${deviceId} WHERE id = ${p.id}`;
      await sql`UPDATE pair_grants SET enabled = false, enabled_since = NULL WHERE pair_id = ${p.id}`;
      await cancelOpenRefreshes({ pairId: p.id }, 'access_revoked', now);
    }
    await sql`UPDATE invites SET cancelled_at = ${new Date(now)} WHERE inviter_device_id = ${deviceId} AND consumed_at IS NULL AND cancelled_at IS NULL`;
    const f = await sql`DELETE FROM location_fixes WHERE device_id = ${deviceId}`;
    const d = await sql`DELETE FROM diagnostic_events WHERE device_id = ${deviceId}`;
    await sql`UPDATE devices SET status_report = NULL, sharing_mode = 'OFF' WHERE id = ${deviceId}`;
    return { fixesDeleted: f.count, diagnosticsDeleted: d.count, pairsRevoked: pairs.length };
  }

  router.add('DELETE', '/v1/me/data', 'device', async ({ device, now }) => ({ ok: true, ...(await deleteData(device.id, now)) }));

  router.add('DELETE', '/v1/me', 'device', async ({ device, now }) => {
    const r = await deleteData(device.id, now);
    await sql`UPDATE devices SET token_hash = NULL, push_token = NULL, deleted_at = ${new Date(now)} WHERE id = ${device.id}`;
    return { ok: true, ...r, deviceDeleted: true };
  });

  // ---------------- сервисные задачи ----------------
  async function sweep(now = clock()) {
    const timedOut = await expireRefreshRequests(now);
    const f = await sql`DELETE FROM location_fixes WHERE measured_at < ${new Date(now - ttlMs)} OR received_at < ${new Date(now - ttlMs)}`;
    const d = await sql`DELETE FROM diagnostic_events WHERE received_at < ${new Date(now - config.diagTtlDays * 86400_000)}`;
    await sql`DELETE FROM invites WHERE expires_at < ${new Date(now - 86400_000)}`;
    await sql`DELETE FROM refresh_requests WHERE created_at < ${new Date(now - 7 * 86400_000)}`;
    apiLimiter.gc(now);
    registerLimiter.gc(now);
    inviteFailLimiter.gc(now);
    return { timedOut, fixesPurged: f.count, diagnosticsPurged: d.count };
  }

  // ---------------- обработчик ----------------
  async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const started = performance.now();
    const now = clock();
    let routePath = '?';
    let status = 500;
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const m = router.match(req.method ?? 'GET', url.pathname);
      if (m === null) throw new HttpError(404, 'not_found');
      if (m === 'method') throw new HttpError(405, 'method_not_allowed');
      routePath = m.route.path;
      let device: Device = null as unknown as Device;
      if (m.route.auth === 'device') {
        device = await authDevice(req.headers.authorization, now);
        if (!apiLimiter.hit(`api:${device.id}`, now)) throw new HttpError(429, 'rate_limited');
      } else if (m.route.auth === 'admin') {
        const t = req.headers['x-admin-token'];
        if (!config.adminToken || typeof t !== 'string' || !safeEqual(t, config.adminToken)) throw new HttpError(404, 'not_found');
      }
      const body = await readJson(req);
      const ctx: Ctx<Device> = { req, params: m.params, query: url.searchParams, body, device, now };
      const out = await m.route.handler(ctx);
      const reply = isReply(out) ? out : { body: out };
      status = reply.status ?? 200;
      send(res, reply);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        send(res, { status: e.status, body: { error: e.code, message: e.message, ...(e.extra ?? {}) } });
      } else {
        status = 500;
        log(`[error] ${routePath} ${(e as Error).message}`);
        send(res, { status: 500, body: { error: 'internal_error' } });
      }
    } finally {
      // В логах: метод, шаблон пути, статус, время. Без тел запросов, токенов и координат.
      if (config.logRequests) log(`${req.method} ${routePath} ${status} ${(performance.now() - started).toFixed(0)}ms`);
    }
  }

  function listen(port = config.port, host = config.host): Promise<Server> {
    const server = createServer((req, res) => void handle(req, res));
    server.keepAliveTimeout = 65_000;
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }

  return { handle, listen, sweep, expireRefreshRequests, router };
}
