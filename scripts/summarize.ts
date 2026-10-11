// Выгрузка результатов испытаний и краткая сводка.
// Использование:
//   API_URL=https://сервер ADMIN_TOKEN=... node scripts/summarize.ts           — скачать с сервера
//   node scripts/summarize.ts путь/к/server_all.json                           — из файла (экспорт из приложения или админ-экспорт)
// Результат: папка results/<дата>/ с CSV и summary.md
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { percentile } from '../packages/shared/src/index.ts';

type Row = Record<string, any>;
interface Export {
  devices: Row[];
  fixes: Row[];
  diagnostics: Row[];
  refresh: Row[];
}

async function load(): Promise<Export> {
  const file = process.argv[2];
  if (file) return JSON.parse(await readFile(file, 'utf8')) as Export;
  const url = process.env.API_URL;
  const token = process.env.ADMIN_TOKEN;
  if (!url || !token) throw new Error('Нужен файл экспорта или переменные API_URL и ADMIN_TOKEN');
  const r = await fetch(url.replace(/\/$/, '') + '/v1/admin/export?format=json', { headers: { 'x-admin-token': token } });
  if (!r.ok) throw new Error(`Сервер ответил ${r.status}`);
  return (await r.json()) as Export;
}

function csv(rows: Row[]): string {
  if (!rows.length) return '﻿';
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

const t = (v: unknown) => (v ? new Date(v as string).getTime() : null);
const fmtS = (ms: number | null) => (ms === null ? '—' : (ms / 1000).toFixed(1));

const data = await load();
const outDir = join('results', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
await mkdir(outDir, { recursive: true });
for (const k of ['devices', 'fixes', 'diagnostics', 'refresh'] as const) await writeFile(join(outDir, `${k}.csv`), csv(data[k] ?? []));
await writeFile(join(outDir, 'raw.json'), JSON.stringify(data));

const devName = new Map<string, string>(data.devices.map((d) => [d.id, `${d.display_name} (${d.platform}, ${d.model ?? '?'} ${d.os_version ?? ''})`]));
const lines: string[] = [];
lines.push(`# Сводка испытаний P0 — ${new Date().toLocaleString('ru-RU')}`, '');
lines.push('> Автоматическая сводка по сырым данным. При малой выборке (n < 20) выводы ПРЕДВАРИТЕЛЬНЫЕ.', '> Задержка = время приёма сервером − время измерения на телефоне (включает время в очереди и расхождение часов).', '');

// --- точки по устройству и сценарию
lines.push('## Точки по устройствам и сценариям', '', '| Устройство | Сценарий | n | принято/низк./подозр. | задержка p50, с | p90, с | макс. разрыв между измерениями, мин | точность p50, м | поздние | батарея, %/ч |', '|---|---|---|---|---|---|---|---|---|---|');
const groups = new Map<string, Row[]>();
for (const f of data.fixes) {
  const k = `${f.device_id}|${f.scenario ?? '—'}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(f);
}
for (const [k, rows] of groups) {
  const [dev, scen] = k.split('|');
  rows.sort((a, b) => t(a.measured_at)! - t(b.measured_at)!);
  const delays = rows.map((r) => t(r.received_at)! - t(r.measured_at)!);
  let maxGap = 0;
  for (let i = 1; i < rows.length; i++) maxGap = Math.max(maxGap, t(rows[i].measured_at)! - t(rows[i - 1].measured_at)!);
  const acc = rows.map((r) => Number(r.accuracy_m));
  const q = (name: string) => rows.filter((r) => r.quality === name).length;
  const bat = rows.filter((r) => r.battery_level !== null && r.battery_level !== undefined);
  let batRate = '—';
  if (bat.length >= 2) {
    const h = (t(bat[bat.length - 1].measured_at)! - t(bat[0].measured_at)!) / 3600_000;
    if (h >= 0.25) batRate = (((Number(bat[0].battery_level) - Number(bat[bat.length - 1].battery_level)) * 100) / h).toFixed(1);
  }
  lines.push(
    `| ${devName.get(dev) ?? dev} | ${scen}${rows.length < 20 ? ' *(предв.)*' : ''} | ${rows.length} | ${q('accepted')}/${q('low_quality')}/${q('suspect')} | ${fmtS(percentile(delays, 50))} | ${fmtS(percentile(delays, 90))} | ${(maxGap / 60000).toFixed(1)} | ${Math.round(percentile(acc, 50) ?? 0)} | ${rows.filter((r) => r.late === true).length} | ${batRate} |`,
  );
}

// --- запросы обновления
lines.push('', '## Запросы обновления', '', '| Кто запрашивал → у кого | n | доставлено | таймаут | отказ | нет доступа | время до точки p50, с | p90, с | доля успеха |', '|---|---|---|---|---|---|---|---|---|');
const rg = new Map<string, Row[]>();
for (const r of data.refresh) {
  const k = `${r.requester_device_id}|${r.target_device_id}`;
  if (!rg.has(k)) rg.set(k, []);
  rg.get(k)!.push(r);
}
for (const [k, rows] of rg) {
  const [a, b] = k.split('|');
  const ok = rows.filter((r) => r.state === 'delivered');
  const total = ok.map((r) => t(r.fix_received_at)! - t(r.created_at)!);
  lines.push(
    `| ${devName.get(a) ?? a} → ${devName.get(b) ?? b} | ${rows.length}${rows.length < 20 ? ' *(предв.)*' : ''} | ${ok.length} | ${rows.filter((r) => r.state === 'timeout').length} | ${rows.filter((r) => r.state === 'failed').length} | ${rows.filter((r) => r.state.startsWith('access')).length} | ${fmtS(percentile(total, 50))} | ${fmtS(percentile(total, 90))} | ${rows.length ? Math.round((ok.length / rows.length) * 100) : 0}% |`,
  );
}
// канал доставки запроса на телефон
const channels = new Map<string, number>();
for (const r of data.refresh) for (const e of r.events ?? []) if (e.state === 'device_received') channels.set(e.detail?.channel ?? '?', (channels.get(e.detail?.channel ?? '?') ?? 0) + 1);
lines.push('', `Каналы, через которые телефон узнал о запросе: ${[...channels].map(([c, n]) => `${c}: ${n}`).join(', ') || 'нет данных'}`);

// --- диагностика
lines.push('', '## События журнала (кол-во по типам)', '', '| Устройство | Событие | n |', '|---|---|---|');
const dg = new Map<string, number>();
for (const e of data.diagnostics) {
  const k = `${e.device_id}|${e.type}`;
  dg.set(k, (dg.get(k) ?? 0) + 1);
}
for (const [k, n] of [...dg].sort()) {
  const [d, type] = k.split('|');
  lines.push(`| ${devName.get(d) ?? d} | ${type} | ${n} |`);
}
await writeFile(join(outDir, 'summary.md'), lines.join('\n') + '\n');
console.log(`Готово: ${outDir}/summary.md, CSV рядом`);
