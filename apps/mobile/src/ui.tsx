import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { FreshnessStatus } from '@blizkie/shared';

export const colors = {
  bg: '#F4F5F7',
  card: '#FFFFFF',
  text: '#1B1F24',
  muted: '#5F6B7A',
  border: '#D8DDE3',
  primary: '#1C64F2',
  danger: '#C92A2A',
  ok: '#2B8A3E',
  warn: '#E67700',
  gray: '#868E96',
};

export const freshnessColor: Record<FreshnessStatus, string> = {
  fresh: '#2B8A3E',
  recent: '#5C940D',
  approximate: '#E67700',
  stale: '#868E96',
  historical: '#495057',
  unavailable: '#C92A2A',
};

export function Card({ title, children, style }: { title?: string; children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.card, style]}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Row({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, color ? { color } : null]} selectable>
        {value}
      </Text>
    </View>
  );
}

export function Btn({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
}: {
  title: string;
  onPress: () => void | Promise<void>;
  kind?: 'primary' | 'danger' | 'plain';
  disabled?: boolean;
  busy?: boolean;
}) {
  const bg = kind === 'primary' ? colors.primary : kind === 'danger' ? colors.danger : '#E9ECEF';
  const fg = kind === 'plain' ? colors.text : '#fff';
  return (
    <Pressable
      onPress={() => void onPress()}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Note({ children, color }: { children: React.ReactNode; color?: string }) {
  return <Text style={[s.note, color ? { color } : null]}>{children}</Text>;
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function fmtDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${fmtTime(ms)}`;
}
export function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 0) return 'из будущего (часы расходятся)';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} с назад`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин ${sec % 60} с назад`;
  const h = Math.floor(min / 60);
  return `${h} ч ${min % 60} мин назад`;
}
export function fmtMeters(m: number | null | undefined): string {
  if (m === null || m === undefined) return '—';
  return m >= 1000 ? `±${(m / 1000).toFixed(1)} км` : `±${Math.round(m)} м`;
}
export function yesNo(v: boolean | null | undefined, unknown = 'нет данных'): string {
  return v === null || v === undefined ? unknown : v ? 'да' : 'нет';
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.border },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, gap: 8 },
  rowLabel: { color: colors.muted, flexShrink: 1, fontSize: 14 },
  rowValue: { color: colors.text, fontWeight: '600', textAlign: 'right', flexShrink: 1, fontSize: 14 },
  btn: { borderRadius: 8, paddingVertical: 11, paddingHorizontal: 12, alignItems: 'center', marginVertical: 4 },
  btnText: { fontSize: 15, fontWeight: '700' },
  note: { color: colors.muted, fontSize: 13, marginVertical: 4 },
});
