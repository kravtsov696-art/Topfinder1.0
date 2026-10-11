// Фоновые задачи. Должны определяться на верхнем уровне модуля, который импортируется
// ПЕРВЫМ (index.ts): ОС может запустить JS только ради задачи, без интерфейса.
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { logEvent } from './diag';
import { applyMode, appStateNow, GEOFENCE_TASK, LOCATION_TASK, reportStatus, toFix } from './location';
import { enqueue, flush } from './queue';
import { handleRefreshRequests } from './refresh';
import { getSettings } from './storage';

type LocationTaskData = { locations?: Location.LocationObject[] };
type GeofenceTaskData = { eventType?: Location.GeofencingEventType; region?: Location.LocationRegion };

TaskManager.defineTask<LocationTaskData>(LOCATION_TASK, async ({ data, error, executionInfo }) => {
  if (error) {
    void logEvent('bg_task_error', { message: error.message, code: error.code });
    return;
  }
  const locations = data?.locations ?? [];
  if (locations.length === 0) return;
  try {
    const s = await getSettings();
    if (s.mode === 'OFF') {
      // Задача ещё зарегистрирована, а пользователь выключил обмен — ничего не отправляем
      void logEvent('bg_locations', { count: locations.length, ignored: 'mode_off' });
      await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);
      return;
    }
    const fixes = [];
    const taskAppState = executionInfo?.appState ?? appStateNow();
    for (const l of locations) fixes.push(await toFix(l, 'bg_task', { appState: taskAppState }));
    const newest = locations.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
    void logEvent('bg_locations', {
      count: locations.length,
      newestAgeMs: Date.now() - newest.timestamp,
      bestAccuracyM: Math.round(Math.min(...locations.map((l) => l.coords.accuracy ?? 1e9))),
      appState: taskAppState,
      taskEvent: executionInfo?.eventId ?? null,
    });
    await enqueue(fixes);
    const r = await flush(false);
    // Запросы обновления, которые сервер вернул в ответ — отвечаем свежей точкой
    if (r.pending.length) await handleRefreshRequests(r.pending, 'fix_response', newest);
    // ACTIVE_TRIP закончился — возвращаемся в ECO (FGS уже запущен, перенастройка допустима)
    if (s.mode === 'ACTIVE_TRIP' && s.activeTripUntil && s.activeTripUntil < Date.now()) {
      await applyMode('ECO', { fromBackground: true });
    }
    void reportStatus(false);
  } catch (e) {
    void logEvent('bg_task_error', { message: (e as Error).message });
  }
});

TaskManager.defineTask<GeofenceTaskData>(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    void logEvent('bg_task_error', { task: 'geofence', message: error.message });
    return;
  }
  const t = data?.eventType;
  const kind = t === Location.GeofencingEventType.Enter ? 'enter' : t === Location.GeofencingEventType.Exit ? 'exit' : 'unknown';
  // Системное событие геозоны — это ещё не «подтверждённый вход»: пишем как «вероятно»
  void logEvent('geofence_event', { event: kind, region: data?.region?.identifier ?? null, radius: data?.region?.radius ?? null, appState: appStateNow() });
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    if (last) {
      await enqueue([await toFix(last, 'geofence')]);
      await flush(false);
    }
  } catch (e) {
    void logEvent('bg_task_error', { task: 'geofence', message: (e as Error).message });
  }
});
