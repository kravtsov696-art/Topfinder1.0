import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import type {
  DeviceStatusReport,
  DiagnosticEventInput,
  FixBatchResponse,
  FixInput,
  PeerLocationResponse,
  PendingRefresh,
  RefreshProgressStage,
  RefreshRequestView,
  SharingMode,
} from '@blizkie/shared';
import { getSettings, getToken, setToken, updateSettings } from './storage';

export class ApiError extends Error {
  status: number;
  code: string;
  body: any;
  constructor(status: number, code: string, message: string, body: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Сетевая ошибка (нет связи, таймаут) — отличаем от ответа сервера */
export class NetworkError extends Error {
  kind: 'timeout' | 'network';
  constructor(kind: 'timeout' | 'network', message: string) {
    super(message);
    this.kind = kind;
  }
}

// Смещение часов: serverTime − локальное время (оценка по середине запроса)
let serverOffsetMs = 0;
let offsetSamples = 0;
export function serverNow(): number {
  return Date.now() + serverOffsetMs;
}
export function getServerOffsetMs(): number {
  return serverOffsetMs;
}
function noteServerTime(serverTime: unknown, t0: number, t1: number) {
  if (typeof serverTime !== 'number') return;
  const est = serverTime - (t0 + t1) / 2;
  serverOffsetMs = offsetSamples === 0 ? est : serverOffsetMs * 0.7 + est * 0.3;
  offsetSamples++;
}

export function appVersion(): string {
  return `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;
}

async function baseUrl(): Promise<string> {
  const s = await getSettings();
  const url = s.apiUrl.trim().replace(/\/+$/, '');
  if (!url) throw new ApiError(0, 'no_server', 'Адрес сервера не задан', null);
  return url;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const url = (await baseUrl()) + path;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth !== false) {
    const t = await getToken();
    if (!t) throw new ApiError(401, 'not_registered', 'Устройство не зарегистрировано', null);
    headers.authorization = `Bearer ${t}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    throw new NetworkError(aborted ? 'timeout' : 'network', aborted ? 'Таймаут запроса' : `Нет связи с сервером: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const t1 = Date.now();
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (json && typeof json === 'object' && 'serverTime' in json) noteServerTime(json.serverTime, t0, t1);
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `http_${res.status}`, json?.message ?? `Ошибка сервера ${res.status}`, json);
  return json as T;
}

export async function requestText(path: string): Promise<string> {
  const url = (await baseUrl()) + path;
  const t = await getToken();
  const res = await fetch(url, { headers: { authorization: `Bearer ${t ?? ''}` } });
  if (!res.ok) throw new ApiError(res.status, `http_${res.status}`, `Ошибка ${res.status}`, null);
  return res.text();
}

// ---------- методы ----------
export async function health() {
  return request<{ ok: boolean; serverTime: number; postgis: boolean; push: string; locationTtlHours: number }>('GET', '/health', undefined, { auth: false, timeoutMs: 10_000 });
}

export async function registerDevice(displayName: string, registrationKey?: string) {
  const r = await request<{ deviceId: string; token: string }>('POST', '/v1/devices/register', {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    displayName,
    model: Device.modelName ?? Device.modelId ?? null,
    osVersion: `${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`.trim(),
    appVersion: appVersion(),
    registrationKey: registrationKey || undefined,
  }, { auth: false });
  await setToken(r.token);
  await updateSettings({ deviceId: r.deviceId, displayName });
  return r;
}

export interface MeResponse {
  serverTime: number;
  device: { id: string; displayName: string; platform: string; sharingMode: SharingMode; activeTripUntil: number | null; hasPushToken: boolean };
  lastFix: null | { measuredAt: number; receivedAt: number; accuracyM: number; lat: number; lon: number; source: string; quality: string };
  lastServerReceiveAt: number | null;
}
export const getMe = () => request<MeResponse>('GET', '/v1/me');
export const setMode = (mode: SharingMode, activeTripMinutes?: number) =>
  request<{ ok: boolean; sharingMode: SharingMode; activeTripUntil: number | null }>('PUT', '/v1/me/mode', { mode, activeTripMinutes });
export const putStatus = (s: DeviceStatusReport) => request<{ ok: boolean }>('PUT', '/v1/me/status', s);
export const putProfile = (displayName: string) => request('PUT', '/v1/me/profile', { displayName });

export const createInvite = () => request<{ code: string; codePretty: string; expiresAt: number }>('POST', '/v1/invites');
export const previewInvite = (code: string) =>
  request<{ inviterName: string; inviterPlatform: string; expiresAt: number }>('POST', '/v1/invites/preview', { code });
export const acceptInvite = (code: string) => request<{ pairId: string; peerName: string }>('POST', '/v1/invites/accept', { code, confirm: true });

export interface PairView {
  pairId: string;
  peerDeviceId: string;
  peerName: string;
  peerPlatform: string;
  initiatedByMe: boolean;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  active: boolean;
  iShare: boolean;
  peerShares: boolean;
}
export const listPairs = () => request<{ serverTime: number; pairs: PairView[] }>('GET', '/v1/pairs');
export const setSharing = (pairId: string, enabled: boolean) => request('PUT', `/v1/pairs/${pairId}/sharing`, { enabled });
export const revokePair = (pairId: string) => request('DELETE', `/v1/pairs/${pairId}`);
export const peerLocation = (pairId: string) => request<PeerLocationResponse>('GET', `/v1/pairs/${pairId}/peer-location`);

export const postFixes = (fixes: FixInput[]) =>
  request<FixBatchResponse>('POST', '/v1/fixes', { sentAt: Date.now(), fixes }, { timeoutMs: 25_000 });

export const createRefresh = (pairId: string, clientRequestId: string) =>
  request<RefreshRequestView>('POST', `/v1/pairs/${pairId}/refresh-requests`, { clientRequestId });
export const getRefresh = (id: string) => request<{ serverTime: number; request: RefreshRequestView }>('GET', `/v1/refresh-requests/${id}`);
export const incomingRefresh = () => request<{ serverTime: number; requests: PendingRefresh[] }>('GET', '/v1/refresh-requests/incoming', undefined, { timeoutMs: 10_000 });
export const refreshProgress = (id: string, stage: RefreshProgressStage, extra: Record<string, unknown>) =>
  request<{ ok: boolean; state: string }>('POST', `/v1/refresh-requests/${id}/progress`, { stage, deviceTime: Date.now(), ...extra });

export const postDiagnostics = (events: DiagnosticEventInput[]) =>
  request<{ accepted: number; duplicates: number; rejected: number }>('POST', '/v1/diagnostics', { events });

export const deleteMyData = () => request<{ fixesDeleted: number; diagnosticsDeleted: number; pairsRevoked: number }>('DELETE', '/v1/me/data');
