// Локальная очередь точек при отсутствии сети.
// Политика (docs/ARCHITECTURE.md §Очередь):
//  • до 500 точек, при переполнении удаляются самые старые (с записью в журнал);
//  • точка старше 24 ч не отправляется — удаляется (сервер всё равно отклонил бы её как expired);
//  • при режиме OFF очередь очищается — пользователь остановил обмен;
//  • повтор с экспоненциальной паузой 15 с → 15 мин, не более 60 попыток на точку;
//  • исходное measuredAt никогда не меняется.
import type { FixInput, FixResult, PendingRefresh } from '@blizkie/shared';
import { FIX_POLICY } from '@blizkie/shared';
import { ApiError, NetworkError, postDiagnostics, postFixes } from './api';
import { logEvent, uploadDiag } from './diag';
import { createMutex, getSettings, readList, writeList } from './storage';

const QUEUE_KEY = 'blizkie_queue_v1';
const SENT_KEY = 'blizkie_sent_log_v1';
const MAX_SENT_LOG = 1000;
const MAX_ATTEMPTS = 60;

export interface QueuedFix extends FixInput {
  enqueuedAt: number;
  attempt: number;
}

export interface SentRecord {
  clientFixId: string;
  measuredAt: number;
  enqueuedAt: number;
  sentAt: number | null; // часы устройства, когда ушла последняя попытка
  receivedAt: number | null; // время сервера
  status: FixResult['status'] | 'dropped';
  reason?: string;
  late?: boolean;
  attempts: number;
  accuracyM: number;
  source: string;
  appState?: string;
  networkType?: string | null;
  scenario?: string | null;
}

const lock = createMutex();
let backoffUntil = 0;
let consecutiveFailures = 0;
let lastFlushError: string | null = null;
let lastFlushOkAt: number | null = null;

export function queueHealth() {
  return { backoffUntil, consecutiveFailures, lastFlushError, lastFlushOkAt };
}

export async function enqueue(fixes: FixInput[]): Promise<void> {
  if (fixes.length === 0) return;
  await lock(async () => {
    const q = await readList<QueuedFix>(QUEUE_KEY);
    const now = Date.now();
    for (const f of fixes) q.push({ ...f, enqueuedAt: f.enqueuedAt ?? now, attempt: 0 });
    q.sort((a, b) => a.measuredAt - b.measuredAt);
    let dropped = 0;
    while (q.length > FIX_POLICY.localQueueMax) {
      const old = q.shift()!;
      dropped++;
      await recordSent([{ ...baseRecord(old), status: 'dropped', reason: 'queue_overflow' }]);
    }
    await writeList(QUEUE_KEY, q);
    if (dropped) void logEvent('queue_dropped', { count: dropped, reason: 'queue_overflow' });
  });
}

export async function queueSize(): Promise<number> {
  return (await readList<QueuedFix>(QUEUE_KEY)).length;
}

export async function clearQueue(reason: string): Promise<number> {
  return lock(async () => {
    const q = await readList<QueuedFix>(QUEUE_KEY);
    if (q.length) {
      await recordSent(q.map((f) => ({ ...baseRecord(f), status: 'dropped' as const, reason })));
      void logEvent('queue_dropped', { count: q.length, reason });
    }
    await writeList(QUEUE_KEY, []);
    return q.length;
  });
}

export async function readSentLog(): Promise<SentRecord[]> {
  return readList<SentRecord>(SENT_KEY);
}

function baseRecord(f: QueuedFix): SentRecord {
  return {
    clientFixId: f.clientFixId,
    measuredAt: f.measuredAt,
    enqueuedAt: f.enqueuedAt,
    sentAt: null,
    receivedAt: null,
    status: 'dropped',
    attempts: f.attempt,
    accuracyM: f.accuracyM,
    source: f.source,
    appState: f.appState,
    networkType: f.networkType,
    scenario: f.scenario,
  };
}

async function recordSent(recs: SentRecord[]) {
  const list = await readList<SentRecord>(SENT_KEY);
  list.push(...recs);
  if (list.length > MAX_SENT_LOG) list.splice(0, list.length - MAX_SENT_LOG);
  await writeList(SENT_KEY, list);
}

export function resetBackoff() {
  backoffUntil = 0;
}

export interface FlushResult {
  sent: number;
  remaining: number;
  pending: PendingRefresh[];
  skipped?: 'backoff' | 'empty' | 'sharing_off';
  error?: string;
}

let inFlight: Promise<FlushResult> | null = null;

/** Отправить очередь. force — игнорировать паузу (возврат сети, ручная кнопка, ответ на запрос). */
export function flush(force = false): Promise<FlushResult> {
  if (inFlight) return inFlight;
  inFlight = doFlush(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doFlush(force: boolean): Promise<FlushResult> {
  const settings = await getSettings();
  if (settings.mode === 'OFF') {
    const n = await clearQueue('sharing_off');
    return { sent: 0, remaining: 0, pending: [], skipped: n ? 'sharing_off' : 'empty' };
  }
  const now = Date.now();
  if (!force && now < backoffUntil) return { sent: 0, remaining: await queueSize(), pending: [], skipped: 'backoff' };

  // Отбрасываем истёкшие и исчерпавшие попытки
  const batch = await lock(async () => {
    const q = await readList<QueuedFix>(QUEUE_KEY);
    const keep: QueuedFix[] = [];
    const drop: SentRecord[] = [];
    for (const f of q) {
      if (now - f.measuredAt > FIX_POLICY.localQueueMaxAgeMs) drop.push({ ...baseRecord(f), status: 'dropped', reason: 'expired_local' });
      else if (f.attempt >= MAX_ATTEMPTS) drop.push({ ...baseRecord(f), status: 'dropped', reason: 'max_attempts' });
      else keep.push(f);
    }
    if (drop.length) {
      await recordSent(drop);
      void logEvent('queue_dropped', { count: drop.length, reason: drop[0].reason });
    }
    await writeList(QUEUE_KEY, keep);
    return keep.slice(0, FIX_POLICY.maxBatch).map((f) => ({ ...f, attempt: f.attempt + 1 }));
  });
  if (batch.length === 0) return { sent: 0, remaining: 0, pending: [], skipped: 'empty' };

  const sentAt = Date.now();
  try {
    const resp = await postFixes(batch);
    consecutiveFailures = 0;
    backoffUntil = 0;
    lastFlushError = null;
    lastFlushOkAt = Date.now();
    const byId = new Map(resp.results.map((r) => [r.clientFixId.toLowerCase(), r]));
    const records: SentRecord[] = [];
    const rejected: Record<string, number> = {};
    await lock(async () => {
      const q = await readList<QueuedFix>(QUEUE_KEY);
      const done = new Set<string>();
      for (const f of batch) {
        const r = byId.get(f.clientFixId.toLowerCase());
        if (!r) continue;
        done.add(f.clientFixId);
        records.push({ ...baseRecord(f), attempts: f.attempt, sentAt, receivedAt: r.receivedAt ?? resp.serverTime, status: r.status, reason: r.reason, late: r.late });
        if (r.status === 'rejected') rejected[r.reason ?? '?'] = (rejected[r.reason ?? '?'] ?? 0) + 1;
      }
      await writeList(QUEUE_KEY, q.filter((f) => !done.has(f.clientFixId)));
      await recordSent(records);
    });
    const delays = records.filter((r) => r.receivedAt).map((r) => (r.receivedAt as number) - r.measuredAt);
    void logEvent('upload_ok', {
      count: batch.length,
      maxAttempt: Math.max(...batch.map((f) => f.attempt)),
      clockSkewMs: resp.clockSkewMs,
      maxDelayMs: delays.length ? Math.max(...delays) : null,
      pendingRefresh: resp.pendingRefreshRequests.length,
    });
    if (Object.keys(rejected).length) void logEvent('fix_rejected', { reasons: rejected });
    // попутно отправим журнал (без ожидания ошибок)
    uploadDiag(postDiagnostics).catch(() => undefined);
    return { sent: batch.length, remaining: await queueSize(), pending: resp.pendingRefreshRequests };
  } catch (e) {
    consecutiveFailures++;
    const delay = Math.min(15 * 60_000, 15_000 * 2 ** Math.min(consecutiveFailures - 1, 6)) * (0.8 + Math.random() * 0.4);
    backoffUntil = Date.now() + delay;
    const msg = e instanceof ApiError ? `${e.status} ${e.code}` : e instanceof NetworkError ? e.kind : (e as Error).message;
    lastFlushError = msg;
    // Увеличиваем счётчик попыток у отправленных
    await lock(async () => {
      const q = await readList<QueuedFix>(QUEUE_KEY);
      const ids = new Set(batch.map((f) => f.clientFixId));
      for (const f of q) if (ids.has(f.clientFixId)) f.attempt += 1;
      await writeList(QUEUE_KEY, q);
    });
    // 4xx (кроме 401/408/429) — пакет никогда не пройдёт: удаляем, чтобы не крутиться бесконечно
    if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status)) {
      await lock(async () => {
        const q = await readList<QueuedFix>(QUEUE_KEY);
        const ids = new Set(batch.map((f) => f.clientFixId));
        await recordSent(batch.map((f) => ({ ...baseRecord(f), status: 'dropped' as const, reason: `http_${e.status}` })));
        await writeList(QUEUE_KEY, q.filter((f) => !ids.has(f.clientFixId)));
      });
    }
    void logEvent('upload_failed', { error: msg, count: batch.length, retryInMs: Math.round(delay), failures: consecutiveFailures });
    return { sent: 0, remaining: await queueSize(), pending: [], error: msg };
  }
}
