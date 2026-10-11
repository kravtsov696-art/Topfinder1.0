// Серверные тесты на настоящем PostgreSQL. Это НЕ проверка реального GPS — только логика сервера.
import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { call, endDb, fix, pairedDevices, postFixes, register, startHarness, type Harness } from './helpers.ts';
import type { PushSender } from '../src/push.ts';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});
after(endDb);

// ---------- авторизация и доступ ----------
test('без токена и с чужим/выдуманным токеном — 401', async () => {
  assert.equal((await call(h, 'GET', '/v1/me')).status, 401);
  assert.equal((await call(h, 'GET', '/v1/me', 'x'.repeat(43))).status, 401);
});

test('знание device_id не даёт координат: нет эндпоинта по device_id, чужая пара → 404', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000 })]);
  const stranger = await register(h, 'Чужой');
  // чужой знает pairId и deviceId — всё равно 404
  assert.equal((await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, stranger.token)).status, 404);
  assert.equal((await call(h, 'GET', `/v1/devices/${a.id}/location`, stranger.token)).status, 404);
  assert.equal((await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, stranger.token, { clientRequestId: 'x1' })).status, 404);
  // export чужого не содержит точек A
  const ex = await call(h, 'GET', '/v1/export?format=json', stranger.token);
  assert.equal(ex.status, 200);
  assert.equal(ex.body.fixes.length, 0);
  // а B (участник пары) видит
  const ok = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.access, 'ok');
});

test('по умолчанию обмен выключен: после связи координаты не видны', async () => {
  const { a, b, pairId } = await pairedDevices(h, { enableSharing: false });
  await call(h, 'PUT', '/v1/me/mode', a.token, { mode: 'ECO' });
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000 })]);
  const r = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.access, 'peer_sharing_off');
  assert.equal(r.body.fix, null);
  assert.equal(r.body.peerStatus, null);
});

test('в режиме OFF сервер не принимает точки', async () => {
  const a = await register(h, 'A');
  const r = await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000 })]);
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].status, 'rejected');
  assert.equal(r.body.results[0].reason, 'sharing_off');
});

test('точки, измеренные до включения обмена, не раскрываются', async () => {
  const { a, b, pairId } = await pairedDevices(h, { enableSharing: false });
  await call(h, 'PUT', '/v1/me/mode', a.token, { mode: 'ECO' });
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 10 * 60_000 })]);
  h.clock.now += 10_000;
  await call(h, 'PUT', `/v1/pairs/${pairId}/sharing`, a.token, { enabled: true });
  const r = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(r.body.access, 'no_fix_since_enabled');
  assert.equal(r.body.fix, null);
});

test('отзыв (разрыв связи) сразу блокирует чтение, запросы обновления и выдачу', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000 })]);
  assert.equal((await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token)).status, 200);
  assert.equal((await call(h, 'DELETE', `/v1/pairs/${pairId}`, a.token)).status, 200);
  const r1 = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(r1.status, 403);
  assert.equal(r1.body.error, 'pair_revoked');
  const r2 = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'after-revoke' });
  assert.equal(r2.status, 403);
  const r3 = await call(h, 'PUT', `/v1/pairs/${pairId}/sharing`, a.token, { enabled: true });
  assert.equal(r3.status, 403);
});

test('выключение обмена владельцем скрывает точку и закрывает открытые запросы', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000 })]);
  const req = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'r-off' });
  assert.equal(req.body.state, 'push_not_configured');
  await call(h, 'PUT', `/v1/pairs/${pairId}/sharing`, a.token, { enabled: false });
  const loc = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(loc.body.access, 'peer_sharing_off');
  assert.equal(loc.body.fix, null);
  const st = await call(h, 'GET', `/v1/refresh-requests/${req.body.id}`, b.token);
  assert.equal(st.body.request.state, 'access_denied');
});

test('срок связи истёк → 403 pair_expired', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000 })]);
  h.clock.now += 15 * 86400_000;
  const r = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'pair_expired');
});

// ---------- приглашения ----------
test('приглашение: истёкший код, повторное использование, свой код, подтверждение обязательно', async () => {
  const a = await register(h, 'A');
  const b = await register(h, 'B');
  const c = await register(h, 'C');
  const inv = await call(h, 'POST', '/v1/invites', a.token);
  assert.equal(inv.status, 201);
  assert.match(inv.body.code, /^[2-9A-HJKMNP-Z]{8}$/);
  assert.equal((await call(h, 'POST', '/v1/invites/accept', a.token, { code: inv.body.code, confirm: true })).body.error, 'own_invite');
  assert.equal((await call(h, 'POST', '/v1/invites/accept', b.token, { code: inv.body.code })).body.error, 'confirmation_required');
  const pv = await call(h, 'POST', '/v1/invites/preview', b.token, { code: inv.body.codePretty.toLowerCase() });
  assert.equal(pv.status, 200);
  assert.equal(pv.body.inviterName, 'A');
  assert.equal((await call(h, 'POST', '/v1/invites/accept', b.token, { code: inv.body.code, confirm: true })).status, 201);
  const reuse = await call(h, 'POST', '/v1/invites/accept', c.token, { code: inv.body.code, confirm: true });
  assert.equal(reuse.status, 410);
  assert.equal(reuse.body.error, 'invite_used');
  // истёкший
  const inv2 = await call(h, 'POST', '/v1/invites', a.token);
  h.clock.now += 10 * 60_000 + 1;
  const exp = await call(h, 'POST', '/v1/invites/accept', c.token, { code: inv2.body.code, confirm: true });
  assert.equal(exp.status, 410);
  assert.equal(exp.body.error, 'invite_expired');
});

test('подбор кода ограничен по числу попыток', async () => {
  const b = await register(h, 'B');
  let last = 0;
  for (let i = 0; i < 10; i++) {
    last = (await call(h, 'POST', '/v1/invites/preview', b.token, { code: 'ZZZZZZZZ' })).status;
  }
  assert.equal(last, 429);
});

test('новое приглашение отменяет старое', async () => {
  const a = await register(h, 'A');
  const b = await register(h, 'B');
  const i1 = await call(h, 'POST', '/v1/invites', a.token);
  await call(h, 'POST', '/v1/invites', a.token);
  assert.equal((await call(h, 'POST', '/v1/invites/preview', b.token, { code: i1.body.code })).status, 404);
});

// ---------- приём точек ----------
test('валидация: lat/lon/accuracy/null island/будущее/слишком старое', async () => {
  const { a } = await pairedDevices(h);
  const now = h.clock.now;
  const r = await postFixes(h, a.token, [
    fix({ lat: 91 }),
    fix({ lon: -181 }),
    fix({ lat: 0, lon: 0 }),
    fix({ accuracyM: 0 }),
    fix({ accuracyM: -5 }),
    fix({ accuracyM: 1e9 }),
    fix({ accuracyM: 'abc' }),
    fix({ measuredAt: now + 10 * 60_000 }), // часы устройства «в будущем»
    fix({ measuredAt: now - 25 * 3600_000 }), // старше TTL
    fix({ clientFixId: 'not-a-uuid' }),
    fix({ measuredAt: now - 1000, accuracyM: 2500 }), // низкое качество
    fix({ measuredAt: now - 2000 }),
  ]);
  assert.equal(r.status, 200);
  const reasons = r.body.results.map((x: any) => x.reason ?? x.status);
  assert.deepEqual(reasons, [
    'invalid_lat',
    'invalid_lon',
    'null_island',
    'invalid_accuracy',
    'invalid_accuracy',
    'invalid_accuracy',
    'invalid_accuracy',
    'future_timestamp',
    'expired',
    'invalid_payload',
    'low_quality',
    'accepted',
  ]);
});

test('небольшое расхождение часов (<2 мин вперёд) принимается, skew записывается', async () => {
  const { a } = await pairedDevices(h);
  const r = await postFixes(h, a.token, [fix({ measuredAt: h.clock.now + 60_000 })], h.clock.now + 61_000);
  assert.equal(r.body.results[0].status, 'accepted');
  assert.equal(r.body.clockSkewMs, -61_000);
  const [row] = await h.sql`SELECT clock_skew_ms FROM location_fixes`;
  assert.equal(row.clock_skew_ms, -61_000);
});

test('повторная доставка того же clientFixId — duplicate, без второй записи', async () => {
  const { a } = await pairedDevices(h);
  const f = fix({ measuredAt: h.clock.now - 1000 });
  const r1 = await postFixes(h, a.token, [f]);
  const r2 = await postFixes(h, a.token, [f, f]);
  assert.equal(r1.body.results[0].status, 'accepted');
  assert.deepEqual(r2.body.results.map((x: any) => x.status), ['duplicate', 'duplicate']);
  const [{ n }] = await h.sql`SELECT count(*)::int AS n FROM location_fixes`;
  assert.equal(n, 1);
});

test('запоздавшая старая точка не заменяет более свежую (сортировка по measured_at)', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  const now = h.clock.now;
  const fresh = fix({ measuredAt: now - 1000, lat: 45.04, lon: 38.98 });
  await postFixes(h, a.token, [fresh]);
  // офлайн-очередь доставила старую точку позже
  const old = fix({ measuredAt: now - 600_000, lat: 45.03, lon: 38.97, enqueuedAt: now - 600_000, attempt: 3 });
  h.clock.now += 5000;
  const r = await postFixes(h, a.token, [old]);
  assert.equal(r.body.results[0].status, 'accepted');
  assert.equal(r.body.results[0].late, true);
  const loc = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(loc.body.fix.measuredAt, now - 1000);
  assert.equal(loc.body.fix.lat, 45.04);
  // исходная временная метка сохранена
  const [row] = await h.sql`SELECT measured_at, received_at FROM location_fixes WHERE client_fix_id = ${old.clientFixId}`;
  assert.equal(row.measured_at.getTime(), now - 600_000);
  assert.equal(row.received_at.getTime(), now + 5000);
});

test('пакет в неправильном порядке обрабатывается по measured_at', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  const now = h.clock.now;
  const r = await postFixes(h, a.token, [
    fix({ measuredAt: now - 1000, lat: 45.0403 }),
    fix({ measuredAt: now - 3000, lat: 45.0401 }),
    fix({ measuredAt: now - 2000, lat: 45.0402 }),
  ]);
  // внутри пакета точки обрабатываются по возрастанию measured_at, поэтому ни одна не «поздняя»
  assert.deepEqual(r.body.results.map((x: any) => x.late), [false, false, false]);
  const loc = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(loc.body.fix.lat, 45.0403);
});

test('физически невозможный скачок помечается suspect и не показывается как подтверждённый', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  const now = h.clock.now;
  await postFixes(h, a.token, [fix({ measuredAt: now - 10_000, lat: 45.035, lon: 38.975 })]);
  // через 5 секунд — в Москве
  const r = await postFixes(h, a.token, [fix({ measuredAt: now - 5_000, lat: 55.75, lon: 37.61 })]);
  assert.equal(r.body.results[0].status, 'suspect');
  const loc = await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token);
  assert.equal(loc.body.fix.lat, 45.035);
  assert.equal(loc.body.suspectFixesSinceLast, 1);
});

test('перелёт после долгого отсутствия сети не отбрасывается', async () => {
  const { a } = await pairedDevices(h);
  const now = h.clock.now;
  await postFixes(h, a.token, [fix({ measuredAt: now - 3 * 3600_000, lat: 45.035, lon: 38.975 })]);
  const r = await postFixes(h, a.token, [fix({ measuredAt: now - 1000, lat: 55.75, lon: 37.61 })]);
  assert.equal(r.body.results[0].status, 'accepted');
});

test('TTL: точки старше 24 ч удаляются и больше не выдаются', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000 })]);
  h.clock.now += 23 * 3600_000;
  assert.equal((await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token)).body.access, 'ok');
  h.clock.now += 2 * 3600_000;
  // даже до очистки чтение ограничено TTL
  assert.equal((await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token)).body.fix, null);
  const s = await h.app.sweep(h.clock.now);
  assert.equal(s.fixesPurged, 1);
  const [{ n }] = await h.sql`SELECT count(*)::int AS n FROM location_fixes`;
  assert.equal(n, 0);
});

// ---------- запрос обновления ----------
test('запрос обновления: полный цикл при открытых приложениях (poll)', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  const req = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'r1' });
  assert.equal(req.status, 201);
  assert.equal(req.body.state, 'push_not_configured');
  assert.deepEqual(req.body.events.map((e: any) => e.state), ['created', 'server_accepted', 'push_not_configured']);
  // идемпотентность
  const again = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'r1' });
  assert.equal(again.body.id, req.body.id);
  // второй одновременный — 409
  assert.equal((await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'r2' })).status, 409);
  // A видит входящий
  const inc = await call(h, 'GET', '/v1/refresh-requests/incoming', a.token);
  assert.equal(inc.body.requests.length, 1);
  h.clock.now += 2000;
  assert.equal((await call(h, 'POST', `/v1/refresh-requests/${req.body.id}/progress`, a.token, { stage: 'device_received', channel: 'poll' })).body.state, 'device_received');
  h.clock.now += 3000;
  await call(h, 'POST', `/v1/refresh-requests/${req.body.id}/progress`, a.token, { stage: 'fix_measured', channel: 'poll', accuracyM: 8 });
  const f = fix({ measuredAt: h.clock.now - 200, source: 'refresh', refreshRequestId: req.body.id });
  h.clock.now += 500;
  await postFixes(h, a.token, [f]);
  const st = await call(h, 'GET', `/v1/refresh-requests/${req.body.id}`, b.token);
  assert.equal(st.body.request.state, 'delivered');
  assert.equal(st.body.request.measuredBeforeRequest, false);
  assert.deepEqual(
    st.body.request.events.map((e: any) => e.state),
    ['created', 'server_accepted', 'push_not_configured', 'device_received', 'fix_measured', 'delivered'],
  );
  // B не может отвечать за A
  assert.equal((await call(h, 'POST', `/v1/refresh-requests/${req.body.id}/progress`, b.token, { stage: 'device_received' })).status, 404);
});

test('запрос обновления: таймаут без ответа, поздняя точка не превращает его в успех', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  const req = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'r-to' });
  h.clock.now += 91_000;
  const st = await call(h, 'GET', `/v1/refresh-requests/${req.body.id}`, b.token);
  assert.equal(st.body.request.state, 'timeout');
  const late = await call(h, 'POST', `/v1/refresh-requests/${req.body.id}/progress`, a.token, { stage: 'device_received' });
  assert.equal(late.status, 409);
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 100, source: 'refresh', refreshRequestId: req.body.id })]);
  const st2 = await call(h, 'GET', `/v1/refresh-requests/${req.body.id}`, b.token);
  assert.equal(st2.body.request.state, 'timeout');
  assert.ok(st2.body.request.events.some((e: any) => e.state === 'late_fix_after_terminal'));
});

test('запрос обновления: если собеседник не делится — access_denied, без «успеха»', async () => {
  const { b, pairId } = await pairedDevices(h, { enableSharing: false });
  const req = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'r-den' });
  assert.equal(req.body.state, 'access_denied');
});

test('запрос обновления: отказ устройства с причиной', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  const req = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'r-f' });
  await call(h, 'POST', `/v1/refresh-requests/${req.body.id}/progress`, a.token, { stage: 'failed', reason: 'permission_denied' });
  const st = await call(h, 'GET', `/v1/refresh-requests/${req.body.id}`, b.token);
  assert.equal(st.body.request.state, 'failed');
  assert.equal(st.body.request.failureReason, 'permission_denied');
});

test('push принят провайдером ≠ телефон получил', async () => {
  await h.close();
  const sent: string[] = [];
  const fake: PushSender = {
    configured: true,
    async sendRefresh(token) {
      sent.push(token);
      return { ok: true, ticket: 'ticket-1' };
    },
  };
  h = await startHarness({ push: fake });
  const { a, b, pairId } = await pairedDevices(h);
  await call(h, 'PUT', '/v1/me/push-token', a.token, { token: 'ExponentPushToken[abc]', kind: 'expo' });
  const req = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'p1' });
  assert.equal(req.body.state, 'push_sent');
  assert.deepEqual(sent, ['ExponentPushToken[abc]']);
  h.clock.now += 91_000;
  const st = await call(h, 'GET', `/v1/refresh-requests/${req.body.id}`, b.token);
  assert.equal(st.body.request.state, 'timeout'); // телефон так и не подтвердил
});

test('ответ на POST /fixes содержит ожидающие запросы (канал fix_response для фона)', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  const req = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: 'fr' });
  const r = await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 100, source: 'bg_task' })]);
  assert.equal(r.body.pendingRefreshRequests.length, 1);
  assert.equal(r.body.pendingRefreshRequests[0].id, req.body.id);
});

test('лимит запросов обновления в час', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  let status = 0;
  for (let i = 0; i < 31; i++) {
    const r = await call(h, 'POST', `/v1/pairs/${pairId}/refresh-requests`, b.token, { clientRequestId: `lim-${i}` });
    status = r.status;
    if (r.status === 201) await call(h, 'POST', `/v1/refresh-requests/${r.body.id}/progress`, a.token, { stage: 'failed', reason: 'unknown' });
  }
  assert.equal(status, 429);
});

// ---------- диагностика, экспорт, удаление ----------
test('диагностика: координаты вырезаются, повтор — duplicate', async () => {
  const a = await register(h, 'A');
  const ev = { clientEventId: randomUUID(), occurredAt: h.clock.now, type: 'fg_location', data: { accuracyM: 5, lat: 45, nested: { longitude: 38, ok: 1 } } };
  const r = await call(h, 'POST', '/v1/diagnostics', a.token, { events: [ev, ev] });
  assert.deepEqual(r.body, { accepted: 1, duplicates: 1, rejected: 0 });
  const g = await call(h, 'GET', '/v1/diagnostics', a.token);
  assert.deepEqual(g.body.events[0].data, { accuracyM: 5, nested: { ok: 1 } });
});

test('экспорт CSV своих данных и админ-экспорт только с токеном', async () => {
  const { a } = await pairedDevices(h);
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000, scenario: '1. оба открыты' })]);
  const csv = await call(h, 'GET', '/v1/export?format=csv&kind=fixes', a.token);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /measured_at/);
  assert.match(csv.text, /1\. оба открыты/);
  assert.equal((await call(h, 'GET', '/v1/admin/export')).status, 404);
  assert.equal((await call(h, 'GET', '/v1/admin/export', null, undefined, { 'x-admin-token': 'wrong-token-wrong-token-xx' })).status, 404);
  const adm = await call(h, 'GET', '/v1/admin/export?format=json', null, undefined, { 'x-admin-token': 'test-admin-token-0123456789abcdef' });
  assert.equal(adm.status, 200);
  assert.equal(adm.body.devices.length, 2);
  assert.equal(adm.body.fixes.length, 1);
});

test('удаление данных и устройства: токен аннулируется, связь разорвана', async () => {
  const { a, b, pairId } = await pairedDevices(h);
  await postFixes(h, a.token, [fix({ measuredAt: h.clock.now - 1000 })]);
  const d = await call(h, 'DELETE', '/v1/me', a.token);
  assert.equal(d.body.fixesDeleted, 1);
  assert.equal((await call(h, 'GET', '/v1/me', a.token)).status, 401);
  assert.equal((await call(h, 'GET', `/v1/pairs/${pairId}/peer-location`, b.token)).status, 403);
});

test('ACTIVE_TRIP ограничен по времени', async () => {
  const a = await register(h, 'A');
  assert.equal((await call(h, 'PUT', '/v1/me/mode', a.token, { mode: 'ACTIVE_TRIP', activeTripMinutes: 10_000 })).status, 400);
  const r = await call(h, 'PUT', '/v1/me/mode', a.token, { mode: 'ACTIVE_TRIP', activeTripMinutes: 30 });
  assert.equal(r.body.activeTripUntil, h.clock.now + 30 * 60_000);
});

test('health', async () => {
  const r = await call(h, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});
