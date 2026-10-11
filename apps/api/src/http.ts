// Минимальный HTTP-слой на node:http. Без фреймворка: см. docs/ARCHITECTURE.md (ADR-API-1).
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message?: string, extra?: Record<string, unknown>) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface Ctx<D = unknown> {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  device: D;
  now: number;
}

export type Handler<D> = (ctx: Ctx<D>) => Promise<Reply | object>;

interface Route<D> {
  method: string;
  pattern: RegExp;
  keys: string[];
  path: string;
  auth: 'device' | 'none' | 'admin';
  handler: Handler<D>;
}

export class Router<D> {
  routes: Route<D>[] = [];
  add(method: string, path: string, auth: Route<D>['auth'], handler: Handler<D>): void {
    const keys: string[] = [];
    const re = path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${re}$`), keys, path, auth, handler });
  }
  match(method: string, pathname: string): { route: Route<D>; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathMatched ? 'method' : null;
  }
}

const MAX_BODY = 512 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'json_required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export function send(res: ServerResponse, reply: Reply): void {
  const status = reply.status ?? 200;
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(reply.headers ?? {}),
  };
  if (reply.raw !== undefined) {
    headers['content-type'] = reply.contentType ?? 'text/plain; charset=utf-8';
    res.writeHead(status, headers);
    res.end(reply.raw);
    return;
  }
  if (reply.body === undefined) {
    res.writeHead(status === 200 ? 204 : status, headers);
    res.end();
    return;
  }
  headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(JSON.stringify(reply.body));
}

export function isReply(x: unknown): x is Reply {
  return typeof x === 'object' && x !== null && ('body' in x || 'raw' in x || 'status' in x);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}
export function requireUuid(s: unknown, what = 'id'): string {
  if (!isUuid(s)) throw new HttpError(404, 'not_found', `${what} не найден`);
  return s.toLowerCase();
}
export function str(v: unknown, max: number, field: string, required = true): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, 'invalid_payload', `${field} обязателен`);
    return null;
  }
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_payload', `${field} должен быть строкой`);
  return v.slice(0, max);
}
export function obj(v: unknown): Record<string, any> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'invalid_payload', 'ожидается JSON-объект');
  return v as Record<string, any>;
}
