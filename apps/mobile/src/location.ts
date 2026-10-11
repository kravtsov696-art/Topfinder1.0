// Геолокационный движок P0. Источник точек — системные обновления (startLocationUpdatesAsync),
// а не таймер «каждые N секунд». ОС сама решает, когда присылать точки; мы это измеряем.
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import type { AppStateValue, DeviceStatusReport, FixInput, FixSource, SharingMode } from '@blizkie/shared';
import { ACTIVE_TRIP_DEFAULT_MINUTES } from '@blizkie/shared';
import { appVersion, putStatus, setMode as apiSetMode } from './api';
import { logEvent } from './diag';
import { clearQueue, enqueue, flush } from './queue';
import { getSettings, updateSettings } from './storage';

export const LOCATION_TASK = 'blizkie-location-updates';
export const GEOFENCE_TASK = 'blizkie-geofence';

export function appStateNow(): AppStateValue {
  const s = AppState.currentState;
  return s === 'active' || s === 'background' || s === 'inactive' ? s : 'unknown';
}

let netCache: { type: string; at: number } | null = null;
export async function networkType(): Promise<string> {
  if (netCache && Date.now() - netCache.at < 5000) return netCache.type;
  try {
    const n = await NetInfo.fetch();
    const type = n.isConnected === false ? 'none' : String(n.type);
    netCache = { type, at: Date.now() };
    return type;
  } catch {
    return 'unknown';
  }
}

async function batteryLevel(): Promise<number | null> {
  try {
    const v = await Battery.getBatteryLevelAsync();
    return v >= 0 ? Math.round(v * 100) / 100 : null;
  } catch {
    return null;
  }
}

let reducedAccuracyCache: boolean | null = null;

export async function toFix(loc: Location.LocationObject, source: FixSource, extra: Partial<FixInput> = {}): Promise<FixInput> {
  const s = await getSettings();
  return {
    clientFixId: Crypto.randomUUID(),
    measuredAt: Math.round(loc.timestamp),
    lat: loc.coords.latitude,
    lon: loc.coords.longitude,
    // accuracy бывает null только в вебе; на телефоне — радиус неопределённости ОС
    accuracyM: loc.coords.accuracy ?? -1,
    altitude: loc.coords.altitude,
    altitudeAccuracyM: loc.coords.altitudeAccuracy,
    speedMps: loc.coords.speed !== null && loc.coords.speed >= 0 ? loc.coords.speed : null,
    headingDeg: loc.coords.heading !== null && loc.coords.heading >= 0 ? loc.coords.heading : null,
    isMocked: typeof loc.mocked === 'boolean' ? loc.mocked : null,
    source,
    appState: appStateNow(),
    networkType: await networkType(),
    batteryLevel: await batteryLevel(),
    sharingMode: s.mode,
    reducedAccuracy: reducedAccuracyCache,
    scenario: s.scenario || null,
    ...extra,
  };
}

// ---------------- разрешения ----------------
export interface PermissionSnapshot {
  foreground: 'granted' | 'denied' | 'undetermined';
  background: 'granted' | 'denied' | 'undetermined' | 'unknown';
  accuracy: DeviceStatusReport['accuracyPermission'];
  canAskAgainForeground: boolean;
  servicesEnabled: boolean | null;
  gpsAvailable: boolean | null;
  networkProviderAvailable: boolean | null;
  backgroundTaskRunning: boolean | null;
  geofenceRunning: boolean | null;
  batteryLevel: number | null;
  lowPowerMode: boolean | null;
  batteryOptimization: boolean | null; // Android: включена ли оптимизация батареи для приложения
}

export async function permissionSnapshot(): Promise<PermissionSnapshot> {
  const fg = await Location.getForegroundPermissionsAsync();
  let bg: PermissionSnapshot['background'] = 'unknown';
  try {
    bg = (await Location.getBackgroundPermissionsAsync()).status as PermissionSnapshot['background'];
  } catch {
    bg = 'unknown';
  }
  let accuracy: PermissionSnapshot['accuracy'] = 'unknown';
  if (Platform.OS === 'ios' && fg.ios) accuracy = fg.ios.accuracy;
  if (Platform.OS === 'android' && fg.android) accuracy = fg.android.accuracy;
  reducedAccuracyCache = accuracy === 'reduced' || accuracy === 'coarse' ? true : accuracy === 'unknown' ? null : false;
  let servicesEnabled: boolean | null = null;
  let gps: boolean | null = null;
  let net: boolean | null = null;
  try {
    const p = await Location.getProviderStatusAsync();
    servicesEnabled = p.locationServicesEnabled;
    gps = typeof p.gpsAvailable === 'boolean' ? p.gpsAvailable : null; // iOS не сообщает
    net = typeof p.networkAvailable === 'boolean' ? p.networkAvailable : null;
  } catch {
    /* нет данных — честно оставляем null */
  }
  const safe = async <T,>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  return {
    foreground: fg.status as PermissionSnapshot['foreground'],
    background: bg,
    accuracy,
    canAskAgainForeground: fg.canAskAgain,
    servicesEnabled,
    gpsAvailable: gps,
    networkProviderAvailable: net,
    backgroundTaskRunning: await safe(() => Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)),
    geofenceRunning: await safe(() => Location.hasStartedGeofencingAsync(GEOFENCE_TASK)),
    batteryLevel: await batteryLevel(),
    lowPowerMode: await safe(() => Battery.isLowPowerModeEnabledAsync()),
    batteryOptimization: Platform.OS === 'android' ? await safe(() => Battery.isBatteryOptimizationEnabledAsync()) : null,
  };
}

let lastStatusSentAt = 0;
let lastStatusKey = '';
export async function reportStatus(force = false): Promise<PermissionSnapshot | null> {
  try {
    const p = await permissionSnapshot();
    const report: DeviceStatusReport = {
      reportedAt: Date.now(),
      foregroundPermission: p.foreground,
      backgroundPermission: p.background,
      accuracyPermission: p.accuracy,
      servicesEnabled: p.servicesEnabled,
      gpsAvailable: p.gpsAvailable,
      networkProviderAvailable: p.networkProviderAvailable,
      backgroundTaskRunning: p.backgroundTaskRunning,
      notificationsPermission: Platform.OS === 'android' ? notifPermCache : 'unknown',
      batteryLevel: p.batteryLevel,
      lowPowerMode: p.lowPowerMode,
      appVersion: appVersion(),
    };
    const key = JSON.stringify({ ...report, reportedAt: 0, batteryLevel: Math.round((p.batteryLevel ?? 0) * 10) });
    if (key !== lastStatusKey) void logEvent('permission', { ...p });
    if (force || key !== lastStatusKey || Date.now() - lastStatusSentAt > 10 * 60_000) {
      await putStatus(report);
      lastStatusSentAt = Date.now();
      lastStatusKey = key;
    }
    return p;
  } catch (e) {
    void logEvent('error', { where: 'reportStatus', message: (e as Error).message });
    return null;
  }
}

// Android 13+: без разрешения на уведомления foreground service работает, но его уведомление
// не видно в шторке. Индикатор передачи должен быть видимым — просим разрешение явно.
let notifPermCache: DeviceStatusReport['notificationsPermission'] = 'unknown';
export async function ensureAndroidNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android' || (typeof Platform.Version === 'number' && Platform.Version < 33)) return;
  try {
    const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    const has = await PermissionsAndroid.check(perm);
    if (has) {
      notifPermCache = 'granted';
      return;
    }
    const r = await PermissionsAndroid.request(perm);
    notifPermCache = r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
    void logEvent('permission', { requested: 'post_notifications', result: r });
  } catch (e) {
    void logEvent('permission', { requested: 'post_notifications', error: (e as Error).message });
  }
}

// ---------------- режимы ----------------
function taskOptions(mode: SharingMode, until: number | null, ecoWithoutService: boolean): Location.LocationTaskOptions {
  const untilStr = until ? new Date(until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
  if (mode === 'ACTIVE_TRIP') {
    return {
      accuracy: Location.Accuracy.BestForNavigation,
      distanceInterval: 10,
      timeInterval: 5_000, // Android: минимум между обновлениями
      deferredUpdatesInterval: 0,
      deferredUpdatesDistance: 0,
      pausesUpdatesAutomatically: false, // нативный дефолт expo-location на iOS = true (расходится с документацией) — задаём явно
      activityType: Location.ActivityType.Other,
      showsBackgroundLocationIndicator: true, // iOS: синяя плашка — видимый индикатор
      foregroundService: {
        notificationTitle: 'Близкие: активная поездка',
        notificationBody: `Частая передача точки до ${untilStr}. Остановить — в приложении.`,
        notificationColor: '#D9480F',
        killServiceOnDestroy: false,
      },
    };
  }
  const eco: Location.LocationTaskOptions = {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 50,
    timeInterval: 60_000,
    deferredUpdatesInterval: 0,
    deferredUpdatesDistance: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: false,
  };
  if (Platform.OS === 'android' && !ecoWithoutService) {
    eco.foregroundService = {
      notificationTitle: 'Близкие: обмен включён',
      notificationBody: 'Эконом-режим. Остановить — в приложении.',
      notificationColor: '#1C7ED6',
      killServiceOnDestroy: false,
    };
  }
  return eco;
}

export type EnsureResult = { ok: true } | { ok: false; reason: string };

/** Запросить разрешения по контексту (после явного действия пользователя). */
export async function requestPermissions(wantBackground: boolean): Promise<PermissionSnapshot> {
  const fg = await Location.requestForegroundPermissionsAsync();
  void logEvent('permission', { requested: 'foreground', result: fg.status, ios: fg.ios ?? null, android: fg.android ?? null });
  if (fg.status === 'granted' && wantBackground) {
    try {
      const bg = await Location.requestBackgroundPermissionsAsync();
      void logEvent('permission', { requested: 'background', result: bg.status });
    } catch (e) {
      void logEvent('permission', { requested: 'background', error: (e as Error).message });
    }
  }
  return permissionSnapshot();
}

/**
 * Применить режим: запустить/перенастроить/остановить системные обновления.
 * Вызывать из UI (Android запрещает запуск foreground service из фона).
 */
export async function applyMode(mode: SharingMode, opts: { activeTripMinutes?: number; fromBackground?: boolean; syncServer?: boolean } = {}): Promise<EnsureResult> {
  const prev = await getSettings();
  let until: number | null = null;
  if (mode === 'ACTIVE_TRIP') {
    // Восстановление после перезапуска не должно продлевать поездку
    until = opts.syncServer === false && prev.activeTripUntil ? prev.activeTripUntil : Date.now() + (opts.activeTripMinutes ?? ACTIVE_TRIP_DEFAULT_MINUTES) * 60_000;
  }

  if (opts.syncServer !== false) {
    try {
      const r = await apiSetMode(mode, mode === 'ACTIVE_TRIP' ? opts.activeTripMinutes ?? ACTIVE_TRIP_DEFAULT_MINUTES : undefined);
      until = r.activeTripUntil ?? until;
    } catch (e) {
      // Выключение работает локально даже без сети; включение без сервера — нет
      void logEvent('error', { where: 'setMode', message: (e as Error).message });
      if (mode !== 'OFF') return { ok: false, reason: `Сервер недоступен: ${(e as Error).message}` };
    }
  }
  await updateSettings({ mode, activeTripUntil: until });

  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (mode === 'OFF') {
    if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);
    await clearQueue('sharing_off');
    void logEvent('mode_changed', { from: prev.mode, to: mode });
    void logEvent('bg_task_stopped', { reason: 'mode_off' });
    void reportStatus(true);
    return { ok: true };
  }

  const p = await permissionSnapshot();
  if (p.foreground !== 'granted') return { ok: false, reason: 'Нет разрешения на геолокацию' };
  if (!opts.fromBackground) await ensureAndroidNotificationPermission();
  if (p.servicesEnabled === false) return { ok: false, reason: 'Геолокация выключена в настройках телефона' };
  try {
    // повторный вызов перенастраивает уже запущенную задачу
    await Location.startLocationUpdatesAsync(LOCATION_TASK, taskOptions(mode, until, prev.androidEcoWithoutService));
    void logEvent('bg_task_started', {
      mode,
      background: p.background,
      accuracyPermission: p.accuracy,
      restarted: started,
      fromBackground: Boolean(opts.fromBackground),
    });
  } catch (e) {
    void logEvent('bg_task_error', { where: 'startLocationUpdatesAsync', message: (e as Error).message });
    return { ok: false, reason: `Не удалось запустить обновления: ${(e as Error).message}` };
  }
  void logEvent('mode_changed', { from: prev.mode, to: mode, until });
  void reportStatus(true);
  return { ok: true };
}

/** При запуске приложения: восстановить задачу, если режим не OFF (после перезагрузки/обновления). */
export async function restoreOnLaunch(): Promise<void> {
  const s = await getSettings();
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => null);
  void logEvent('app_launch', { savedMode: s.mode, taskAlreadyRunning: started, registered: TaskManager.isTaskDefined(LOCATION_TASK) });
  if (s.mode === 'ACTIVE_TRIP' && s.activeTripUntil && s.activeTripUntil < Date.now()) {
    await applyMode('ECO');
    return;
  }
  if (s.mode !== 'OFF' && started === false) {
    const r = await applyMode(s.mode, { syncServer: false });
    void logEvent('bg_task_started', { reason: 'restore_on_launch', ok: r.ok, error: r.ok ? undefined : r.reason });
  }
}

/** Разовая точка «сейчас» (кнопка или запрос обновления) */
export async function measureNow(source: FixSource, extra: Partial<FixInput> = {}, timeoutMs = 30_000): Promise<FixInput> {
  const loc = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('timeout_on_device')), timeoutMs)),
  ]);
  return toFix(loc, source, extra);
}

export async function sendNow(source: FixSource = 'manual'): Promise<FixInput> {
  const f = await measureNow(source);
  void logEvent('fg_location', { source, accuracyM: Math.round(f.accuracyM), ageMs: Date.now() - f.measuredAt });
  await enqueue([f]);
  await flush(true);
  return f;
}

// ---------------- геозона (эксперимент) ----------------
export async function startTestGeofence(radius = 150): Promise<EnsureResult> {
  const p = await permissionSnapshot();
  if (p.background !== 'granted') return { ok: false, reason: 'Для геозоны нужен доступ к геолокации «Всегда»' };
  const f = await measureNow('manual');
  await Location.startGeofencingAsync(GEOFENCE_TASK, [
    { identifier: 'test-zone', latitude: f.lat, longitude: f.lon, radius, notifyOnEnter: true, notifyOnExit: true },
  ]);
  await updateSettings({ geofence: { lat: f.lat, lon: f.lon, radius, since: Date.now() } });
  void logEvent('geofence', { action: 'start', radius, centerAccuracyM: Math.round(f.accuracyM) });
  return { ok: true };
}

export async function stopTestGeofence(): Promise<void> {
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) await Location.stopGeofencingAsync(GEOFENCE_TASK);
  await updateSettings({ geofence: null });
  void logEvent('geofence', { action: 'stop' });
}
