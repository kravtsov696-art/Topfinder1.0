// Локальное хранилище. Токен — в Keychain/Keystore (SecureStore) с доступом AFTER_FIRST_UNLOCK:
// иначе на iPhone фоновая задача при заблокированном экране НЕ сможет прочитать токен
// и отправка точек будет молча падать.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import type { SharingMode } from '@blizkie/shared';

const TOKEN_KEY = 'blizkie_device_token';
const SS_OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

let tokenCache: string | null | undefined;

export async function getToken(): Promise<string | null> {
  if (tokenCache !== undefined) return tokenCache;
  tokenCache = await SecureStore.getItemAsync(TOKEN_KEY, SS_OPTS);
  return tokenCache;
}
export async function setToken(token: string | null): Promise<void> {
  tokenCache = token;
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token, SS_OPTS);
  else await SecureStore.deleteItemAsync(TOKEN_KEY, SS_OPTS);
}

export interface Settings {
  apiUrl: string;
  deviceId: string | null;
  displayName: string;
  mode: SharingMode;
  activeTripUntil: number | null;
  scenario: string; // метка текущего сценария испытаний (попадает в точки и журнал)
  androidEcoWithoutService: boolean; // Android: ECO без foreground service (для сравнения)
  geofence: { lat: number; lon: number; radius: number; since: number } | null;
  activePairId: string | null;
}

const SETTINGS_KEY = 'blizkie_settings_v1';

export function defaultSettings(): Settings {
  const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string };
  return {
    apiUrl: extra.apiUrl ?? '',
    deviceId: null,
    displayName: '',
    mode: 'OFF',
    activeTripUntil: null,
    scenario: '',
    androidEcoWithoutService: false,
    geofence: null,
    activePairId: null,
  };
}

let settingsCache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  settingsCache = { ...defaultSettings(), ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
  return settingsCache;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  settingsCache = { ...cur, ...patch };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsCache));
  notify();
  return settingsCache;
}

/** Фоновая задача может изменить настройки — UI перечитывает через подписку. */
type Listener = () => void;
const listeners = new Set<Listener>();
export function onSettingsChanged(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
function notify() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}

// ---- простой JSON-список с ограничением длины (журнал, очередь, история отправок) ----
export async function readList<T>(key: string): Promise<T[]> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
export async function writeList<T>(key: string, items: T[]): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(items));
}

/** Мьютекс в пределах JS-процесса: фоновая задача и UI работают в одном JS-контексте. */
export function createMutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
}
