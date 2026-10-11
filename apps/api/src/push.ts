// Отправка «тихого» push для запроса обновления.
// ВАЖНО: успех здесь = провайдер (Expo → FCM/APNs) ПРИНЯЛ сообщение. Это НЕ подтверждение,
// что телефон получил push. Подтверждение телефона приходит отдельно (device_received).

export type PushResult = { ok: true; ticket: string | null } | { ok: false; error: string };

export interface PushSender {
  readonly configured: boolean;
  sendRefresh(token: string, kind: string, payload: { requestId: string; requesterName: string }): Promise<PushResult>;
}

export class NoPush implements PushSender {
  readonly configured = false;
  async sendRefresh(): Promise<PushResult> {
    return { ok: false, error: 'push_not_configured' };
  }
}

export class ExpoPush implements PushSender {
  readonly configured = true;
  private accessToken: string | null;
  constructor(accessToken: string | null) {
    this.accessToken = accessToken;
  }
  async sendRefresh(token: string, kind: string, payload: { requestId: string; requesterName: string }): Promise<PushResult> {
    if (kind !== 'expo') return { ok: false, error: `unsupported_token_kind:${kind}` };
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          to: token,
          // data-only: без title/body — фоновая доставка; ОС вправе задержать или не доставить
          data: { type: 'blizkie_refresh', requestId: payload.requestId },
          priority: 'high',
          _contentAvailable: true,
          ttl: 90,
        }),
      });
      const json = (await r.json().catch(() => null)) as any;
      const d = json?.data;
      const ticket = Array.isArray(d) ? d[0] : d;
      if (!r.ok || !ticket) return { ok: false, error: `http_${r.status}` };
      if (ticket.status === 'ok') return { ok: true, ticket: ticket.id ?? null };
      return { ok: false, error: String(ticket.details?.error ?? ticket.message ?? 'expo_error').slice(0, 200) };
    } catch (e) {
      return { ok: false, error: (e as Error).name === 'AbortError' ? 'push_timeout' : 'push_network_error' };
    } finally {
      clearTimeout(t);
    }
  }
}
