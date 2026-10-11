import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import NetInfo from '@react-native-community/netinfo';
import { postDiagnostics } from './src/api';
import { logEvent, uploadDiag } from './src/diag';
import { applyMode, reportStatus, restoreOnLaunch } from './src/location';
import { flush, resetBackoff } from './src/queue';
import { pollIncoming } from './src/refresh';
import { getSettings, onSettingsChanged, type Settings } from './src/storage';
import { colors } from './src/ui';
import MyDeviceScreen from './src/screens/MyDeviceScreen';
import PairScreen from './src/screens/PairScreen';
import MapScreen from './src/screens/MapScreen';
import LogScreen from './src/screens/LogScreen';

type Tab = 'me' | 'pair' | 'map' | 'log';
const TABS: { id: Tab; title: string }[] = [
  { id: 'me', title: 'Моё' },
  { id: 'pair', title: 'Связь' },
  { id: 'map', title: 'Карта' },
  { id: 'log', title: 'Журнал' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('me');
  const [settings, setSettings] = useState<Settings | null>(null);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    void getSettings().then(setSettings);
    const offSettings = onSettingsChanged(() => void getSettings().then((s) => setSettings({ ...s })));

    void (async () => {
      const s = await getSettings();
      if (s.deviceId) {
        await restoreOnLaunch().catch((e) => logEvent('error', { where: 'restoreOnLaunch', message: (e as Error).message }));
        void reportStatus(true);
        void flush(true);
      }
    })();

    const subApp = AppState.addEventListener('change', (next) => {
      const prev = appState.current;
      appState.current = next;
      void logEvent('app_state', { from: prev, to: next });
      if (next === 'active') {
        void getSettings().then((s) => {
          if (!s.deviceId) return;
          void reportStatus(false);
          void flush(true);
        });
      }
    });

    let lastConnected: boolean | null = null;
    const offNet = NetInfo.addEventListener((st) => {
      const connected = st.isConnected !== false && st.isInternetReachable !== false;
      if (connected !== lastConnected) {
        void logEvent('network', { type: st.type, connected, internetReachable: st.isInternetReachable });
        if (connected && lastConnected === false) {
          resetBackoff();
          void flush(true);
        }
        lastConnected = connected;
      }
    });

    // Пока приложение открыто: опрос входящих запросов (~4 с) и периодическая отправка
    let n = 0;
    const timer = setInterval(() => {
      if (appState.current !== 'active') return;
      n++;
      void getSettings().then((s) => {
        if (!s.deviceId) return;
        if (s.mode !== 'OFF') pollIncoming().catch(() => undefined);
        if (s.mode === 'ACTIVE_TRIP' && s.activeTripUntil && s.activeTripUntil < Date.now()) void applyMode('ECO');
        if (n % 8 === 0) {
          void flush(false);
          uploadDiag(postDiagnostics).catch(() => undefined);
        }
      });
    }, 4000);

    return () => {
      offSettings();
      subApp.remove();
      offNet();
      clearInterval(timer);
    };
  }, []);

  const mode = settings?.mode ?? 'OFF';
  return (
    <SafeAreaProvider>
      <SafeAreaView style={st.root} edges={['top', 'left', 'right']}>
        <StatusBar style="dark" />
        <View style={[st.banner, { backgroundColor: mode === 'OFF' ? '#868E96' : mode === 'ACTIVE_TRIP' ? colors.warn : colors.ok }]}>
          <Text style={st.bannerText}>
            {mode === 'OFF' ? 'Обмен выключен' : mode === 'ACTIVE_TRIP' ? 'АКТИВНАЯ ПОЕЗДКА — точка передаётся часто' : 'Обмен включён (эконом)'}
            {settings?.scenario ? `  ·  ${settings.scenario}` : ''}
          </Text>
        </View>
        <View style={st.body}>
          {tab === 'me' ? <MyDeviceScreen /> : null}
          {tab === 'pair' ? <PairScreen /> : null}
          {tab === 'map' ? <MapScreen /> : null}
          {tab === 'log' ? <LogScreen /> : null}
        </View>
        <SafeAreaView edges={['bottom']} style={st.tabs}>
          {TABS.map((t) => (
            <Pressable key={t.id} style={[st.tab, tab === t.id && st.tabActive]} onPress={() => setTab(t.id)} disabled={!settings?.deviceId && t.id !== 'me'}>
              <Text style={[st.tabText, tab === t.id && st.tabTextActive, !settings?.deviceId && t.id !== 'me' ? { opacity: 0.4 } : null]}>{t.title}</Text>
            </Pressable>
          ))}
        </SafeAreaView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  banner: { paddingVertical: 6, paddingHorizontal: 12 },
  bannerText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  body: { flex: 1 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: '#fff' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderTopWidth: 3, borderTopColor: colors.primary, paddingTop: 9 },
  tabText: { color: colors.muted, fontWeight: '600' },
  tabTextActive: { color: colors.primary },
});
