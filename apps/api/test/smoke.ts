// Смоук-тест работающего сервера (локального или удалённого) двумя виртуальными устройствами.
// Запуск: node test/smoke.ts https://ваш-сервер   (по умолчанию http://localhost:8080)
// Создаёт тестовые устройства и в конце удаляет их. Реальный GPS не проверяет.
import { randomUUID } from 'node:crypto';

const base = (process.argv[2] ?? process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const regKey = process.env.REGISTRATION_KEY;
let step = 0;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
function check(cond: unknown, what: string, extra?: unknown) {
  step++;
  if (!cond) {
    console.error(`✗ ${step}. ${what}`, extra ?? '');
    process.exit(1);
  }
  console.log(`✓ ${step}. ${what}`);
}

const t0 = Date.now();
const health = await call('GET', '/health');
check(health.status === 200 && health.body.ok, `сервер отвечает (${base})`, health);
const skew = health.body.serverTime - Date.now();
console.log(`   часы сервера − часы этой машины ≈ ${skew} мс; PostGIS: ${health.body.postgis}; push: ${health.body.push}`);

const reg = async (name: string, platform: string) => {
  const r = await call('POST', '/v1/devices/register', undefined, { platform, displayName: name, model: 'smoke', osVersion: '0', registrationKey: regKey });
  check(r.status === 201, `регистрация ${name}`, r);
  return r.body as { deviceId: string; token: string };
};
const A = await reg('Смоук-A', 'test');
const B = await reg('Смоук-B', 'test');
try {
  const inv = await call('POST', '/v1/invites', A.token);
  check(inv.status === 201, `приглашение ${inv.body.codePretty}`);
  const pv = await call('POST', '/v1/invites/preview', B.token, { code: inv.body.code });
  check(pv.status === 200 && pv.body.inviterName === 'Смоук-A', 'предпросмотр кода');
  const acc = await call('POST', '/v1/invites/accept', B.token, { code: inv.body.code, confirm: true });
  check(acc.status === 201, 'связь подтверждена вторым устройством');
  const pairId = acc.body.pairId;

  const off = await call('GET', `/v1/pairs/${pairId}/peer-location`, B.token);
  check(off.body.access === 'peer_sharing_off' && off.body.fix === null, 'до включения обмена координат нет');

  for (const d of [A, B]) {
    await call('PUT', '/v1/me/mode', d.token, { mode: 'ECO' });
    const s = await call('PUT', `/v1/pairs/${pairId}/sharing`, d.token, { enabled: true });
    check(s.status === 200, 'обмен включён');
  }
  const measuredAt = health.body.serverTime + (Date.now() - t0) - 1500;
  const fx = await call('POST', '/v1/fixes', A.token, {
    sentAt: Date.now() + skew,
    fixes: [{ clientFixId: randomUUID(), measuredAt, lat: 45.0355, lon: 38.9753, accuracyM: 15, source: 'manual', appState: 'active', scenario: 'smoke' }],
  });
  check(fx.status === 200 && fx.body.results[0].status === 'accepted', 'точка A принята', fx.body);
  const loc = await call('GET', `/v1/pairs/${pairId}/peer-location`, B.token);
  check(loc.body.access === 'ok' && Math.abs(loc.body.fix.lat - 45.0355) < 1e-9, `B видит точку A (возраст ${loc.body.serverTime - loc.body.fix.measuredAt} мс)`);

  const rq = await call('POST', `/v1/pairs/${pairId}/refresh-requests`, B.token, { clientRequestId: randomUUID() });
  check(rq.status === 201, `запрос обновления создан: ${rq.body.state}`);
  const inc = await call('GET', '/v1/refresh-requests/incoming', A.token);
  check(inc.body.requests.some((r: any) => r.id === rq.body.id), 'A видит входящий запрос');
  await call('POST', `/v1/refresh-requests/${rq.body.id}/progress`, A.token, { stage: 'device_received', channel: 'poll' });
  await call('POST', `/v1/refresh-requests/${rq.body.id}/progress`, A.token, { stage: 'fix_measured', channel: 'poll' });
  await call('POST', '/v1/fixes', A.token, {
    sentAt: Date.now() + skew,
    fixes: [{ clientFixId: randomUUID(), measuredAt: Date.now() + skew - 300, lat: 45.0356, lon: 38.9754, accuracyM: 9, source: 'refresh', refreshRequestId: rq.body.id }],
  });
  const st = await call('GET', `/v1/refresh-requests/${rq.body.id}`, B.token);
  check(st.body.request.state === 'delivered', `запрос выполнен: ${st.body.request.events.map((e: any) => e.state).join(' → ')}`);

  const rv = await call('DELETE', `/v1/pairs/${pairId}`, A.token);
  check(rv.status === 200, 'связь разорвана');
  const after = await call('GET', `/v1/pairs/${pairId}/peer-location`, B.token);
  check(after.status === 403, 'после разрыва координаты не выдаются (403)');
} finally {
  await call('DELETE', '/v1/me', A.token);
  await call('DELETE', '/v1/me', B.token);
  console.log('   тестовые устройства удалены');
}
console.log('СМОУК ПРОЙДЕН');
