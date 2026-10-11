import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Platform, ScrollView, Switch, Text, TextInput, View, StyleSheet } from 'react-native';
import { ACTIVE_TRIP_DEFAULT_MINUTES, type SharingMode } from '@blizkie/shared';
import * as api from '../api';
import { logEvent } from '../diag';
import {
  applyMode,
  permissionSnapshot,
  reportStatus,
  requestPermissions,
  sendNow,
  startTestGeofence,
  stopTestGeofence,
  type PermissionSnapshot,
} from '../location';
import { flush, queueHealth, queueSize, readSentLog, type SentRecord } from '../queue';
import { getSettings, onSettingsChanged, setToken, updateSettings, type Settings } from '../storage';
import { Btn, Card, Note, Row, colors, fmtAge, fmtDateTime, fmtMeters, fmtTime, yesNo } from '../ui';

const MODE_RU: Record<SharingMode, string> = { OFF: 'Выключен', ECO: 'Эконом (ECO)', ACTIVE_TRIP: 'Активная поездка' };

export default function MyDeviceScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [perm, setPerm] = useState<PermissionSnapshot | null>(null);
  const [me, setMe] = useState<api.MeResponse | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [lastLocal, setLastLocal] = useState<SentRecord | null>(null);
  const [qSize, setQSize] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [regKey, setRegKey] = useState('');
  const [scenarioDraft, setScenarioDraft] = useState('');
  const [tick, setTick] = useState(0);

  const reload = useCallback(async () => {
    const s = await getSettings();
    setSettings(s);
    setPerm(await permissionSnapshot().catch(() => null));
    setQSize(await queueSize());
    const log = await readSentLog();
    setLastLocal(log.length ? log[log.length - 1] : null);
    if (s.deviceId) {
      try {
        setMe(await api.getMe());
        setMeError(null);
      } catch (e) {
        setMeError((e as Error).message);
      }
    }
  }, []);

  useEffect(() => {
    void getSettings().then((s) => {
      setUrlDraft(s.apiUrl);
      setNameDraft(s.displayName || (Platform.OS === 'ios' ? 'iPhone' : 'Android'));
      setScenarioDraft(s.scenario);
    });
    void reload();
    const off = onSettingsChanged(() => void reload());
    const t = setInterval(() => {
      setTick((x) => x + 1);
      void reload();
    }, 5000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [reload]);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
      void logEvent('error', { where: name, message: (e as Error).message });
    } finally {
      setBusy(null);
      void reload();
    }
  }

  if (!settings) return null;
  const registered = Boolean(settings.deviceId);

  // ----- Настройка сервера и регистрация -----
  if (!registered) {
    return (
      <ScrollView contentContainerStyle={st.pad}>
        <Card title="Первый запуск">
          <Note>
            Это тестовое приложение P0. Оно показывает вашу точку только человеку, с которым вы явно связались, и только когда вы сами включили
            обмен. Обновление может задерживаться — телефон решает сам, когда присылать координаты. Приложение не заменяет экстренные службы.
          </Note>
          <Text style={st.label}>Адрес сервера (https://…)</Text>
          <TextInput style={st.input} value={urlDraft} onChangeText={setUrlDraft} autoCapitalize="none" autoCorrect={false} placeholder="https://blizkie-api.onrender.com" />
          <Text style={st.label}>Имя этого телефона (видит второй участник)</Text>
          <TextInput style={st.input} value={nameDraft} onChangeText={setNameDraft} maxLength={40} />
          <Text style={st.label}>Тестовый ключ регистрации (если задан на сервере)</Text>
          <TextInput style={st.input} value={regKey} onChangeText={setRegKey} autoCapitalize="none" autoCorrect={false} />
          <Btn
            title="Проверить сервер и зарегистрировать телефон"
            busy={busy === 'register'}
            onPress={() =>
              run('register', async () => {
                const url = urlDraft.trim();
                if (!/^https:\/\//.test(url)) throw new Error('Нужен адрес, начинающийся с https://');
                await updateSettings({ apiUrl: url });
                const h = await api.health();
                await api.registerDevice(nameDraft.trim() || 'Телефон', regKey.trim());
                void logEvent('app_launch', { registered: true, serverPostgis: h.postgis, serverPush: h.push });
                Alert.alert('Готово', 'Телефон зарегистрирован. Теперь разрешите геолокацию и свяжитесь со вторым телефоном.');
              })
            }
          />
        </Card>
      </ScrollView>
    );
  }

  const tripLeft = settings.mode === 'ACTIVE_TRIP' && settings.activeTripUntil ? settings.activeTripUntil - Date.now() : null;
  const health = queueHealth();
  const lastFix = me?.lastFix ?? null;
  void tick;

  return (
    <ScrollView contentContainerStyle={st.pad}>
      <Card title="Режим обмена">
        <Row
          label="Сейчас"
          value={MODE_RU[settings.mode] + (tripLeft !== null ? ` · ещё ${Math.max(0, Math.round(tripLeft / 60000))} мин` : '')}
          color={settings.mode === 'OFF' ? colors.muted : settings.mode === 'ACTIVE_TRIP' ? colors.warn : colors.ok}
        />
        {settings.mode !== 'OFF' ? (
          <Note color={colors.warn}>Передача включена. Остановить можно в любой момент кнопкой ниже.</Note>
        ) : null}
        <View style={st.row3}>
          <View style={st.flex}>
            <Btn title="OFF" kind={settings.mode === 'OFF' ? 'danger' : 'plain'} busy={busy === 'OFF'} onPress={() => run('OFF', async () => void (await applyMode('OFF')))} />
          </View>
          <View style={st.flex}>
            <Btn
              title="ECO"
              kind={settings.mode === 'ECO' ? 'primary' : 'plain'}
              busy={busy === 'ECO'}
              onPress={() =>
                run('ECO', async () => {
                  const r = await applyMode('ECO');
                  if (!r.ok) throw new Error(r.reason);
                })
              }
            />
          </View>
          <View style={st.flex}>
            <Btn
              title={`Поездка ${ACTIVE_TRIP_DEFAULT_MINUTES} мин`}
              kind={settings.mode === 'ACTIVE_TRIP' ? 'primary' : 'plain'}
              busy={busy === 'TRIP'}
              onPress={() =>
                run('TRIP', async () => {
                  const r = await applyMode('ACTIVE_TRIP', { activeTripMinutes: ACTIVE_TRIP_DEFAULT_MINUTES });
                  if (!r.ok) throw new Error(r.reason);
                })
              }
            />
          </View>
        </View>
        {Platform.OS === 'android' ? (
          <View style={st.switchRow}>
            <Text style={st.switchText}>Android: ECO без постоянного уведомления (фон будет редким — для сравнения)</Text>
            <Switch
              value={settings.androidEcoWithoutService}
              onValueChange={(v) =>
                run('ecoSwitch', async () => {
                  await updateSettings({ androidEcoWithoutService: v });
                  if (settings.mode === 'ECO') await applyMode('ECO', { syncServer: false });
                })
              }
            />
          </View>
        ) : null}
      </Card>

      <Card title="Разрешения и датчики">
        <Row label="Геолокация (при использовании)" value={perm?.foreground ?? '…'} color={perm?.foreground === 'granted' ? colors.ok : colors.danger} />
        <Row label="Геолокация в фоне («Всегда»)" value={perm?.background ?? '…'} color={perm?.background === 'granted' ? colors.ok : colors.warn} />
        <Row
          label="Точность"
          value={
            perm?.accuracy === 'full' || perm?.accuracy === 'fine'
              ? 'точная'
              : perm?.accuracy === 'reduced' || perm?.accuracy === 'coarse'
                ? 'ПРИБЛИЗИТЕЛЬНАЯ'
                : (perm?.accuracy ?? '…')
          }
          color={perm?.accuracy === 'reduced' || perm?.accuracy === 'coarse' ? colors.warn : undefined}
        />
        <Row label="Службы геолокации включены" value={yesNo(perm?.servicesEnabled)} />
        <Row label="GPS-провайдер (сообщает только Android)" value={yesNo(perm?.gpsAvailable, 'ОС не сообщает')} />
        <Row label="Сетевой провайдер (только Android)" value={yesNo(perm?.networkProviderAvailable, 'ОС не сообщает')} />
        <Row label="Фоновые обновления запущены" value={yesNo(perm?.backgroundTaskRunning)} />
        <Row label="Энергосбережение" value={yesNo(perm?.lowPowerMode)} />
        {Platform.OS === 'android' ? <Row label="Оптимизация батареи для приложения" value={yesNo(perm?.batteryOptimization)} /> : null}
        <Row label="Заряд" value={perm?.batteryLevel !== null && perm?.batteryLevel !== undefined ? `${Math.round(perm.batteryLevel * 100)}%` : 'нет данных'} />
        <Btn
          title="Разрешить геолокацию (сначала «при использовании», затем «всегда»)"
          busy={busy === 'perm'}
          onPress={() =>
            run('perm', async () => {
              const p = await requestPermissions(true);
              setPerm(p);
              await reportStatus(true);
              if (p.background !== 'granted') {
                Alert.alert(
                  'Фон не разрешён',
                  Platform.OS === 'ios'
                    ? 'Для работы при заблокированном экране выберите в Настройках → Близкие P0 → Геолокация → «Всегда» и включите «Точная геопозиция».'
                    : 'Для работы в фоне откройте Настройки → Приложения → Близкие P0 → Разрешения → Местоположение → «Разрешить в любом режиме» и «Точное местоположение».',
                  [{ text: 'Открыть настройки', onPress: () => void Linking.openSettings() }, { text: 'Позже' }],
                );
              }
            })
          }
        />
        <Btn title="Открыть настройки приложения" kind="plain" onPress={() => Linking.openSettings()} />
      </Card>

      <Card title="Мои последние координаты (видите только вы)">
        <Row label="Измерено (часы телефона)" value={fmtDateTime(lastFix?.measuredAt)} />
        <Row label="Принято сервером" value={fmtDateTime(lastFix?.receivedAt)} />
        <Row label="Задержка измерение → сервер" value={lastFix ? `${((lastFix.receivedAt - lastFix.measuredAt) / 1000).toFixed(1)} с` : '—'} />
        <Row label="Возраст" value={lastFix ? fmtAge(api.serverNow() - lastFix.measuredAt) : '—'} />
        <Row label="Погрешность" value={fmtMeters(lastFix?.accuracyM)} />
        <Row label="Источник / качество" value={lastFix ? `${lastFix.source} / ${lastFix.quality}` : '—'} />
        <Row label="Координаты" value={lastFix ? `${lastFix.lat.toFixed(5)}, ${lastFix.lon.toFixed(5)}` : '—'} />
        <Row label="Последняя отправка (локально)" value={lastLocal ? `${fmtTime(lastLocal.sentAt)} · ${lastLocal.status}${lastLocal.reason ? ' · ' + lastLocal.reason : ''}` : '—'} />
        <Row label="В очереди (нет сети)" value={String(qSize)} color={qSize > 0 ? colors.warn : undefined} />
        {health.lastFlushError ? <Row label="Последняя ошибка отправки" value={health.lastFlushError} color={colors.danger} /> : null}
        {health.backoffUntil > Date.now() ? <Row label="Следующая попытка" value={fmtTime(health.backoffUntil)} /> : null}
        {meError ? <Note color={colors.danger}>Сервер: {meError}</Note> : null}
        <Btn
          title="Измерить и отправить точку сейчас"
          disabled={settings.mode === 'OFF'}
          busy={busy === 'send'}
          onPress={() =>
            run('send', async () => {
              const f = await sendNow('manual');
              Alert.alert('Измерено', `Погрешность ${fmtMeters(f.accuracyM)}, возраст ${fmtAge(Date.now() - f.measuredAt)}`);
            })
          }
        />
        <Btn title="Отправить очередь сейчас" kind="plain" busy={busy === 'flush'} onPress={() => run('flush', async () => void (await flush(true)))} />
        {settings.mode === 'OFF' ? <Note>В режиме OFF точки не измеряются и не отправляются.</Note> : null}
      </Card>

      <Card title="Испытания">
        <Text style={st.label}>Метка текущего сценария (попадёт в каждую точку и в журнал)</Text>
        <TextInput style={st.input} value={scenarioDraft} onChangeText={setScenarioDraft} placeholder="например: 2. экран заблокирован" maxLength={80} />
        <Btn
          title="Сохранить метку сценария"
          kind="plain"
          onPress={() =>
            run('scenario', async () => {
              await updateSettings({ scenario: scenarioDraft.trim() });
              void logEvent('scenario', { label: scenarioDraft.trim() });
            })
          }
        />
        <Text style={[st.label, { marginTop: 8 }]}>Тестовая геозона (эксперимент, нужен доступ «Всегда»)</Text>
        {settings.geofence ? (
          <>
            <Row label="Радиус" value={`${settings.geofence.radius} м`} />
            <Row label="Поставлена" value={fmtDateTime(settings.geofence.since)} />
            <Btn title="Убрать геозону" kind="plain" busy={busy === 'gfOff'} onPress={() => run('gfOff', () => stopTestGeofence())} />
          </>
        ) : (
          <Btn
            title="Поставить геозону 150 м вокруг текущей точки"
            kind="plain"
            busy={busy === 'gf'}
            onPress={() =>
              run('gf', async () => {
                const r = await startTestGeofence(150);
                if (!r.ok) throw new Error(r.reason);
              })
            }
          />
        )}
        <Note>События входа/выхода пишутся в «Журнал». Это системное событие ОС, а не подтверждённый факт входа.</Note>
      </Card>

      <Card title="Устройство и сервер">
        <Row label="Имя" value={settings.displayName} />
        <Row label="ID устройства" value={settings.deviceId ?? '—'} />
        <Row label="Сервер" value={settings.apiUrl} />
        <Row label="Часы сервера − часы телефона" value={`${Math.round(api.getServerOffsetMs() / 1000)} с`} />
        <Row label="Версия сборки" value={api.appVersion()} />
        <Btn
          title="Удалить мои данные на сервере"
          kind="danger"
          busy={busy === 'del'}
          onPress={() =>
            Alert.alert('Удалить данные?', 'Будут удалены все ваши точки и журнал на сервере, связи разорваны, обмен выключен.', [
              { text: 'Отмена' },
              {
                text: 'Удалить',
                style: 'destructive',
                onPress: () =>
                  void run('del', async () => {
                    await applyMode('OFF', { syncServer: false });
                    const r = await api.deleteMyData();
                    Alert.alert('Удалено', `Точек: ${r.fixesDeleted}, событий: ${r.diagnosticsDeleted}, связей разорвано: ${r.pairsRevoked}`);
                  }),
              },
            ])
          }
        />
        <Btn
          title="Сбросить регистрацию на этом телефоне"
          kind="plain"
          onPress={() =>
            Alert.alert('Сбросить?', 'Телефон забудет токен. Понадобится заново зарегистрироваться и связаться.', [
              { text: 'Отмена' },
              {
                text: 'Сбросить',
                style: 'destructive',
                onPress: () =>
                  void run('reset', async () => {
                    await applyMode('OFF', { syncServer: false });
                    await setToken(null);
                    await updateSettings({ deviceId: null, activePairId: null });
                  }),
              },
            ])
          }
        />
      </Card>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  pad: { padding: 12, paddingBottom: 40 },
  label: { color: colors.muted, fontSize: 13, marginTop: 6, marginBottom: 2 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, backgroundColor: '#fff', color: colors.text },
  row3: { flexDirection: 'row', gap: 6 },
  flex: { flex: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  switchText: { flex: 1, color: colors.muted, fontSize: 13 },
});
