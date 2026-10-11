// Локальный диагностический журнал: пишет события на устройстве (в том числе в фоне),
// показывает их на экране «Журнал» и порциями отправляет на сервер.
// Координаты в журнал НЕ пишем — только точность, возраст, состояния.
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import type { DiagnosticEventInput } from '@blizkie/shared';
import { createMutex, getSettings, readList, writeList } from './storage';

export interface DiagEntry extends DiagnosticEventInput {
  uploaded?: boolean;
}

const LOG_KEY = 'blizkie_diag_log_v1';
const MAX_LOG = 1500;
const lock = createMutex();

type Listener = (e: DiagEntry) => void;
const listeners = new Set<Listener>();
export function onDiag(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function logEvent(type: string, data: Record<string, unknown> = {}): Promise<void> {
  return lock(async () => {
    const s = await getSettings().catch(() => null);
    const entry: DiagEntry = {
      clientEventId: Crypto.randomUUID(),
      occurredAt: Date.now(),
      type,
      data: { ...data, appState: data.appState ?? AppState.currentState, scenario: s?.scenario || undefined, mode: s?.mode },
    };
    const list = await readList<DiagEntry>(LOG_KEY);
    list.push(entry);
    // Ограничение: сначала удаляем уже отправленные старые записи
    while (list.length > MAX_LOG) {
      const idx = list.findIndex((x) => x.uploaded);
      list.splice(idx >= 0 ? idx : 0, 1);
    }
    await writeList(LOG_KEY, list);
    listeners.forEach((l) => l(entry));
  }).catch(() => undefined);
}

export async function readDiag(): Promise<DiagEntry[]> {
  return readList<DiagEntry>(LOG_KEY);
}

export async function clearDiag(): Promise<void> {
  await lock(() => writeList(LOG_KEY, []));
}

/** Отправляет неотправленные события. Возвращает число отправленных. */
export async function uploadDiag(post: (e: DiagnosticEventInput[]) => Promise<unknown>): Promise<number> {
  const pending = (await readDiag()).filter((e) => !e.uploaded).slice(0, 200);
  if (pending.length === 0) return 0;
  await post(pending.map(({ uploaded: _u, ...rest }) => rest));
  const ids = new Set(pending.map((e) => e.clientEventId));
  await lock(async () => {
    const list = await readList<DiagEntry>(LOG_KEY);
    for (const e of list) if (ids.has(e.clientEventId)) e.uploaded = true;
    await writeList(LOG_KEY, list);
  });
  return pending.length;
}
