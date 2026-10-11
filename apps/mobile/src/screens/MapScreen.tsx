import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import {
  FRESHNESS_LABEL_RU,
  FRESHNESS_THRESHOLDS,
  REFRESH_STATE_RU,
  REFRESH_TERMINAL,
  classifyFreshness,
  type FreshnessStatus,
  type PeerLocationResponse,
  type RefreshRequestView,
} from '@blizkie/shared';
import * as api from '../api';
import { logEvent } from '../diag';
import MapView, { type MapPoint } from '../components/MapView';
import { getSettings, onSettingsChanged, updateSettings } from '../storage';
import { Btn, Card, Note, Row, colors, fmtAge, fmtDateTime, fmtMeters, fmtTime, freshnessColor, yesNo } from '../ui';

const ACCESS_RU: Record<PeerLocationResponse['access'], string> = {
  ok: 'доступ есть',
  peer_sharing_off: 'собеседник не включил обмен (или выключил)',
  no_fix_since_enabled: 'обмен включён, но точек после включения ещё не было',
};

function extraStateLabel(s: string): string {
  if (s === 'late_fix_after_terminal') return 'Точка пришла уже после закрытия запроса';
  if (s.startsWith('late_')) return `Телефон ответил после закрытия запроса (${s.slice(5)})`;
  return (REFRESH_STATE_RU as Record<string, string>)[s] ?? s;
}

export default function MapScreen() {
  const [pairs, setPairs] = useState<api.PairView[]>([]);
  const [pairId, setPairId] = useState<string | null>(null);
  const [peer, setPeer] = useState<PeerLocationResponse | null>(null);
  const [peerErr, setPeerErr] = useState<string | null>(null);
  const [me, setMe] = useState<api.MeResponse | null>(null);
  const [req, setReq] = useState<RefreshRequestView | null>(null);
  const [reqErr, setReqErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [, setTick] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const s = await getSettings();
    try {
      const pr = await api.listPairs();
      const active = pr.pairs.filter((p) => p.active);
      setPairs(active);
      const id = active.find((p) => p.pairId === s.activePairId)?.pairId ?? active[0]?.pairId ?? null;
      setPairId(id);
      if (id) {
        setPeer(await api.peerLocation(id));
        setPeerErr(null);
      } else setPeer(null);
    } catch (e) {
      setPeerErr((e as Error).message);
    }
    try {
      setMe(await api.getMe());
    } catch {
      /* показываем, что есть */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      setTick((x) => x + 1);
      void load();
    }, 5000);
    const off = onSettingsChanged(() => void load());
    return () => {
      clearInterval(t);
      off();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const now = api.serverNow();
  const peerFix = peer?.fix ?? null;
  const peerAge = peerFix ? now - peerFix.measuredAt : null;
  const peerStatus: FreshnessStatus = peer?.access === 'ok' && peerFix
    ? classifyFreshness({ ageMs: peerAge, accuracyM: peerFix.accuracyM, reducedAccuracy: peerFix.reducedAccuracy === true })
    : 'unavailable';
  const myFix = me?.lastFix ?? null;
  const myAge = myFix ? now - myFix.measuredAt : null;
  const myStatus: FreshnessStatus = myFix ? classifyFreshness({ ageMs: myAge, accuracyM: myFix.accuracyM }) : 'unavailable';

  const points = useMemo<MapPoint[]>(() => {
    const out: MapPoint[] = [];
    const dashed = (s: FreshnessStatus) => s === 'stale' || s === 'historical' || s === 'approximate';
    if (myFix) {
      out.push({ id: 'me', lat: myFix.lat, lon: myFix.lon, accuracyM: myFix.accuracyM, color: myStatus === 'fresh' ? '#1C64F2' : '#868E96', dashed: dashed(myStatus), label: `Я · ${fmtAge(myAge)}` });
    }
    if (peerFix && peerStatus !== 'unavailable') {
      out.push({
        id: 'peer',
        lat: peerFix.lat,
        lon: peerFix.lon,
        accuracyM: peerFix.accuracyM,
        color: freshnessColor[peerStatus],
        dashed: dashed(peerStatus),
        label: `${peer?.peer.name ?? 'Собеседник'} · ${FRESHNESS_LABEL_RU[peerStatus]} · ${fmtAge(peerAge)}`,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myFix?.measuredAt, peerFix?.measuredAt, peerStatus, myStatus, Math.floor(now / 10_000)]);

  function startPolling(id: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.getRefresh(id);
        setReq(r.request);
        setReqErr(null);
        if ((REFRESH_TERMINAL as readonly string[]).includes(r.request.state)) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          void logEvent('refresh_seen', { role: 'requester', requestId: id, finalState: r.request.state, totalMs: r.request.fixReceivedAt ? r.request.fixReceivedAt - r.request.createdAt : null });
          void load();
        }
      } catch (e) {
        setReqErr((e as Error).message); // не прекращаем опрос: сеть могла пропасть ненадолго
      }
    }, 1500);
  }

  async function requestRefresh() {
    if (!pairId) return;
    setBusy(true);
    setReqErr(null);
    try {
      const r = await api.createRefresh(pairId, Crypto.randomUUID());
      setReq(r);
      void logEvent('refresh_seen', { role: 'requester', requestId: r.id, state: r.state });
      if (!(REFRESH_TERMINAL as readonly string[]).includes(r.state)) startPolling(r.id);
    } catch (e) {
      if (e instanceof api.ApiError && e.code === 'refresh_in_progress' && e.body?.requestId) {
        startPolling(e.body.requestId);
      } else {
        setReqErr((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const reqOpen = req && !(REFRESH_TERMINAL as readonly string[]).includes(req.state);
  const skewWarn = peerFix && peerFix.clockSkewMs !== null && Math.abs(peerFix.clockSkewMs) > 60_000;
  const peerSt = peer?.peerStatus ?? null;

  return (
    <ScrollView contentContainerStyle={st.pad}>
      {pairs.length > 1 ? (
        <Card title="Связь">
          {pairs.map((p) => (
            <Btn key={p.pairId} title={p.peerName} kind={p.pairId === pairId ? 'primary' : 'plain'} onPress={() => void updateSettings({ activePairId: p.pairId })} />
          ))}
        </Card>
      ) : null}
      {!pairId ? (
        <Card title="Нет активной связи">
          <Note>Свяжитесь со вторым телефоном на вкладке «Связь».</Note>
        </Card>
      ) : null}

      <MapView points={points} fitKey={fitKey} />
      <Btn title="Показать обе точки" kind="plain" onPress={() => setFitKey((k) => k + 1)} />

      {pairId ? (
        <Card title={peer ? `«${peer.peer.name}»` : 'Собеседник'}>
          <View style={[st.badge, { backgroundColor: freshnessColor[peerStatus] }]}>
            <Text style={st.badgeText}>{FRESHNESS_LABEL_RU[peerStatus]}</Text>
          </View>
          {peer && peer.access !== 'ok' ? <Note color={colors.danger}>Нет позиции: {ACCESS_RU[peer.access]}.</Note> : null}
          {peerErr ? <Note color={colors.danger}>Ошибка: {peerErr}</Note> : null}
          <Row label="Измерено (часы его телефона)" value={fmtDateTime(peerFix?.measuredAt)} />
          <Row label="Возраст точки" value={fmtAge(peerAge)} color={freshnessColor[peerStatus]} />
          <Row label="Принято сервером" value={fmtDateTime(peerFix?.receivedAt)} />
          <Row label="Погрешность" value={fmtMeters(peerFix?.accuracyM)} />
          <Row label="Источник" value={peerFix ? `${peerFix.source}${peerFix.quality === 'low_quality' ? ' (низкое качество)' : ''}` : '—'} />
          <Row label="Состояние приложения при измерении" value={peerFix?.appState ?? '—'} />
          <Row label="Сеть при отправке" value={peerFix?.networkType ?? '—'} />
          <Row label="Телефон выходил на связь" value={peer?.peer.lastSeenAt ? fmtAge(now - peer.peer.lastSeenAt) : '—'} />
          <Row label="Его режим" value={peer ? `${peer.peerMode}${peer.activeTripUntil ? ' до ' + fmtTime(peer.activeTripUntil) : ''}` : '—'} />
          {peerFix ? <Row label="Координаты" value={`${peerFix.lat.toFixed(5)}, ${peerFix.lon.toFixed(5)}`} /> : null}
          {peer && peer.suspectFixesSinceLast > 0 ? <Note color={colors.warn}>После этой точки пришло {peer.suspectFixesSinceLast} подозрительных (физически невозможных) — не показываются.</Note> : null}
          {skewWarn ? <Note color={colors.warn}>Часы его телефона расходятся с сервером на {Math.round((peerFix!.clockSkewMs ?? 0) / 1000)} с — время измерения может быть неточным.</Note> : null}
          {peerStatus === 'stale' || peerStatus === 'historical' ? (
            <Note color={colors.warn}>Это последнее известное место, а не текущее. Новых координат телефон не присылал {fmtAge(peerAge)}.</Note>
          ) : null}
          {peerSt ? (
            <>
              <Text style={st.sub}>Сообщённое его телефоном состояние ({fmtAge(now - peerSt.reportedAt)}):</Text>
              <Row label="Разрешение / фон" value={`${peerSt.foregroundPermission} / ${peerSt.backgroundPermission}`} />
              <Row label="Точность разрешена" value={peerSt.accuracyPermission} />
              <Row label="Службы геолокации" value={yesNo(peerSt.servicesEnabled)} />
              <Row label="Фоновые обновления" value={yesNo(peerSt.backgroundTaskRunning)} />
              <Row label="Энергосбережение" value={yesNo(peerSt.lowPowerMode)} />
              <Row label="Заряд" value={peerSt.batteryLevel !== null ? `${Math.round(peerSt.batteryLevel * 100)}%` : '—'} />
            </>
          ) : null}
          {peerFix ? (
            <Btn
              title="Открыть точку в картах"
              kind="plain"
              onPress={() => {
                const url = Platform.OS === 'ios' ? `http://maps.apple.com/?ll=${peerFix.lat},${peerFix.lon}` : `geo:${peerFix.lat},${peerFix.lon}?q=${peerFix.lat},${peerFix.lon}`;
                Linking.openURL(url).catch(() => Alert.alert('Не открылось'));
              }}
            />
          ) : null}
        </Card>
      ) : null}

      {pairId ? (
        <Card title="Запросить обновление">
          <Btn title={reqOpen ? 'Запрос выполняется…' : 'Запросить обновление'} onPress={requestRefresh} busy={busy} disabled={Boolean(reqOpen)} />
          {reqErr ? <Note color={colors.danger}>{reqErr}</Note> : null}
          {req ? (
            <>
              <Row label="Итог" value={extraStateLabel(req.state)} color={req.state === 'delivered' ? colors.ok : reqOpen ? colors.warn : colors.danger} />
              {req.events.map((e, i) => (
                <Text key={i} style={st.ev}>
                  +{((e.at - req.createdAt) / 1000).toFixed(1)} с — {extraStateLabel(e.state)}
                  {e.detail && (e.detail as any).channel ? ` [канал: ${(e.detail as any).channel}]` : ''}
                  {e.detail && (e.detail as any).reason ? ` [${(e.detail as any).reason}]` : ''}
                </Text>
              ))}
              {reqOpen ? <Note>Таймаут в {fmtTime(req.deadlineAt)}. Если ответа нет — это штатный исход, а не ошибка приложения.</Note> : null}
              {req.state === 'delivered' && req.measuredBeforeRequest ? <Note color={colors.warn}>Точка измерена до запроса (телефон использовал недавнее измерение).</Note> : null}
              {req.state === 'delivered' && req.fixMeasuredAt ? <Note>Точка измерена в {fmtTime(req.fixMeasuredAt)}, дошла через {(((req.fixReceivedAt ?? 0) - req.createdAt) / 1000).toFixed(1)} с после запроса.</Note> : null}
            </>
          ) : (
            <Note>
              Сейчас запрос доходит, только когда приложение второго телефона открыто (опрос сервера каждые ~4 с) или когда ОС сама прислала ему новую точку в
              фоне. Push-доставка — этап D.
            </Note>
          )}
        </Card>
      ) : null}

      <Card title="Я">
        <Row label="Статус моей последней точки" value={FRESHNESS_LABEL_RU[myStatus]} color={freshnessColor[myStatus]} />
        <Row label="Возраст" value={fmtAge(myAge)} />
        <Row label="Погрешность" value={fmtMeters(myFix?.accuracyM)} />
        <Note>
          Пороги статусов экспериментальные: свежая ≤{FRESHNESS_THRESHOLDS.freshMaxAgeMs / 60000} мин и ≤{FRESHNESS_THRESHOLDS.goodAccuracyM} м; недавняя ≤
          {FRESHNESS_THRESHOLDS.recentMaxAgeMs / 60000} мин; устаревшая ≤{FRESHNESS_THRESHOLDS.staleMaxAgeMs / 60000} мин; дальше — историческая. Это не гарантия ОС.
        </Note>
      </Card>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  pad: { padding: 12, paddingBottom: 40 },
  badge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 6 },
  badgeText: { color: '#fff', fontWeight: '800' },
  ev: { fontSize: 13, color: colors.text, marginVertical: 1, fontVariant: ['tabular-nums'] },
  sub: { marginTop: 8, color: colors.muted, fontSize: 13, fontWeight: '600' },
});
