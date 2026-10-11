// Обработка входящих запросов обновления на телефоне, у которого запросили точку.
// Каналы: poll (приложение открыто, опрос сервера), fix_response (сервер вернул запрос в ответ
// на фоновую отправку точки). Push (APNs/FCM) — этап D, в этой сборке не подключён.
import type * as Location from 'expo-location';
import type { PendingRefresh, RefreshDeliveryChannel } from '@blizkie/shared';
import { ApiError, incomingRefresh, refreshProgress } from './api';
import { logEvent } from './diag';
import { appStateNow, measureNow, toFix } from './location';
import { enqueue, flush } from './queue';
import { getSettings } from './storage';

const handled = new Map<string, number>(); // id → время начала обработки (в пределах процесса)
const REUSE_MAX_AGE_MS = 15_000;

function failureReason(e: unknown): string {
  const m = (e as Error)?.message ?? '';
  if (/timeout_on_device/.test(m)) return 'timeout_on_device';
  if (/permission|denied|not authorized|unauthori/i.test(m)) return 'permission_denied';
  if (/services|disabled|turned off|location is unavailable|unsatisfied/i.test(m)) return 'location_unavailable';
  return 'unknown';
}

export async function handleRefreshRequests(reqs: PendingRefresh[], channel: RefreshDeliveryChannel, recent?: Location.LocationObject | null): Promise<void> {
  for (const r of reqs) {
    if (handled.has(r.id)) continue;
    handled.set(r.id, Date.now());
    await handleOne(r, channel, recent ?? null);
  }
  // чистим старые отметки
  for (const [id, t] of handled) if (Date.now() - t > 10 * 60_000) handled.delete(id);
}

async function handleOne(r: PendingRefresh, channel: RefreshDeliveryChannel, recent: Location.LocationObject | null) {
  const appState = appStateNow();
  void logEvent('refresh_seen', { requestId: r.id, channel, from: r.requesterName, state: r.state });
  try {
    await refreshProgress(r.id, 'device_received', { channel, appState });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      void logEvent('refresh_failed', { requestId: r.id, reason: 'already_closed', serverState: e.body?.state });
      return;
    }
    // Нет сети: продолжаем — точка уйдёт в очередь с refreshRequestId
    void logEvent('refresh_failed', { requestId: r.id, stage: 'ack', error: (e as Error).message });
  }
  const s = await getSettings();
  if (s.mode === 'OFF') {
    await refreshProgress(r.id, 'failed', { reason: 'sharing_off', channel }).catch(() => undefined);
    return;
  }
  try {
    const reuse = recent && Date.now() - recent.timestamp <= REUSE_MAX_AGE_MS;
    const fix = reuse
      ? await toFix(recent!, 'refresh', { refreshRequestId: r.id })
      : await measureNow('refresh', { refreshRequestId: r.id });
    await refreshProgress(r.id, 'fix_measured', { channel, accuracyM: fix.accuracyM, reusedRecentFix: Boolean(reuse) }).catch(() => undefined);
    await enqueue([fix]);
    const fr = await flush(true);
    void logEvent('refresh_answered', {
      requestId: r.id,
      channel,
      accuracyM: Math.round(fix.accuracyM),
      fixAgeMs: Date.now() - fix.measuredAt,
      reused: Boolean(reuse),
      uploaded: fr.sent > 0,
      error: fr.error,
    });
  } catch (e) {
    const reason = failureReason(e);
    void logEvent('refresh_failed', { requestId: r.id, stage: 'measure', reason, message: (e as Error).message });
    await refreshProgress(r.id, 'failed', { reason, channel, message: (e as Error).message }).catch(() => undefined);
  }
}

/** Опрос входящих запросов, пока приложение открыто. */
export async function pollIncoming(): Promise<number> {
  const s = await getSettings();
  if (s.mode === 'OFF' || !s.deviceId) return 0;
  const r = await incomingRefresh();
  if (r.requests.length) await handleRefreshRequests(r.requests, 'poll');
  return r.requests.length;
}
