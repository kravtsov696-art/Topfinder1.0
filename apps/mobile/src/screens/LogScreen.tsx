import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import * as Device from 'expo-device';
import { DIAG_TYPE_RU } from '@blizkie/shared';
import * as api from '../api';
import { onDiag, readDiag, uploadDiag, type DiagEntry } from '../diag';
import { readSentLog, type SentRecord } from '../queue';
import { getSettings } from '../storage';
import { Btn, Card, Note, colors, fmtDateTime } from '../ui';

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '﻿';
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

async function shareText(name: string, text: string, mime: string) {
  const f = new File(Paths.cache, name);
  if (f.exists) f.delete();
  f.create();
  f.write(text);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Отправка файлов недоступна на этом устройстве');
  await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: name });
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function describe(e: DiagEntry): string {
  const d = { ...(e.data ?? {}) } as Record<string, unknown>;
  delete d.scenario;
  delete d.mode;
  const parts = Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return parts.join(' · ');
}

export default function LogScreen() {
  const [items, setItems] = useState<DiagEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const all = await readDiag();
    setItems(all.slice(-300).reverse());
  }, []);

  useEffect(() => {
    void reload();
    const off = onDiag(() => void reload());
    return off;
  }, [reload]);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      Alert.alert('Ошибка', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function localExport(format: 'json' | 'csv') {
    const s = await getSettings();
    const diag = await readDiag();
    const sent: SentRecord[] = await readSentLog();
    const meta = { deviceId: s.deviceId, name: s.displayName, model: Device.modelName, os: `${Device.osName} ${Device.osVersion}`, app: api.appVersion(), exportedAt: Date.now(), serverOffsetMs: api.getServerOffsetMs() };
    const base = `blizkie_${(s.displayName || 'phone').replace(/[^\wа-яА-Я-]/g, '_')}_${stamp()}`;
    if (format === 'json') {
      await shareText(`${base}.json`, JSON.stringify({ meta, diagnostics: diag, sentLog: sent }, null, 1), 'application/json');
    } else {
      await shareText(`${base}_sent.csv`, csv(sent.map((r) => ({ ...r, delayMs: r.receivedAt ? r.receivedAt - r.measuredAt : null, measuredAtIso: new Date(r.measuredAt).toISOString() }))), 'text/csv');
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={st.top}>
        <Card title="Экспорт результатов">
          <Note>Локальный журнал телефона (включая точки, не дошедшие до сервера) и серверная выгрузка ваших данных.</Note>
          <View style={st.row}>
            <View style={st.flex}>
              <Btn title="Журнал JSON" kind="plain" busy={busy === 'lj'} onPress={() => run('lj', () => localExport('json'))} />
            </View>
            <View style={st.flex}>
              <Btn title="Отправки CSV" kind="plain" busy={busy === 'lc'} onPress={() => run('lc', () => localExport('csv'))} />
            </View>
          </View>
          <View style={st.row}>
            <View style={st.flex}>
              <Btn title="Сервер: точки CSV" kind="plain" busy={busy === 'sf'} onPress={() => run('sf', async () => shareText(`server_fixes_${stamp()}.csv`, await api.requestText('/v1/export?format=csv&kind=fixes'), 'text/csv'))} />
            </View>
            <View style={st.flex}>
              <Btn title="Сервер: запросы CSV" kind="plain" busy={busy === 'sr'} onPress={() => run('sr', async () => shareText(`server_refresh_${stamp()}.csv`, await api.requestText('/v1/export?format=csv&kind=refresh'), 'text/csv'))} />
            </View>
          </View>
          <Btn title="Сервер: всё в JSON" kind="plain" busy={busy === 'sj'} onPress={() => run('sj', async () => shareText(`server_all_${stamp()}.json`, await api.requestText('/v1/export?format=json'), 'application/json'))} />
          <Btn
            title="Отправить журнал на сервер сейчас"
            kind="plain"
            busy={busy === 'up'}
            onPress={() =>
              run('up', async () => {
                let total = 0;
                for (let i = 0; i < 10; i++) {
                  const n = await uploadDiag(api.postDiagnostics);
                  total += n;
                  if (n === 0) break;
                }
                Alert.alert('Готово', `Отправлено событий: ${total}`);
                void reload();
              })
            }
          />
        </Card>
        <Text style={st.h}>Журнал событий (новые сверху, {items.length})</Text>
      </View>
      <FlatList
        data={items}
        keyExtractor={(e) => e.clientEventId}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 40 }}
        renderItem={({ item }) => (
          <View style={st.item}>
            <Text style={st.itemHead}>
              {fmtDateTime(item.occurredAt)} · {DIAG_TYPE_RU[item.type] ?? item.type}
              {item.uploaded ? '' : ' · ⏳'}
            </Text>
            <Text style={st.itemBody} selectable>
              {describe(item)}
            </Text>
          </View>
        )}
      />
    </View>
  );
}

const st = StyleSheet.create({
  top: { padding: 12, paddingBottom: 0 },
  row: { flexDirection: 'row', gap: 6 },
  flex: { flex: 1 },
  h: { fontWeight: '700', color: colors.text, marginBottom: 6 },
  item: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 6 },
  itemHead: { fontWeight: '600', color: colors.text, fontSize: 13 },
  itemBody: { color: colors.muted, fontSize: 12 },
});
