import { loadConfig } from './config.ts';
import { createDb, hasPostgis, migrate } from './db.ts';
import { buildApp } from './app.ts';
import { ExpoPush, NoPush } from './push.ts';

const config = loadConfig();
const sql = createDb(config.databaseUrl);
const applied = await migrate(sql);
if (applied.length) console.log(`Миграции применены: ${applied.join(', ')}`);
const postgis = await hasPostgis(sql);
console.log(`PostGIS: ${postgis ? 'да' : 'нет (колонка geog не используется)'}; push: ${config.pushProvider}; TTL точек: ${config.locationTtlHours} ч`);

const app = buildApp({
  sql,
  config,
  postgis,
  push: config.pushProvider === 'expo' ? new ExpoPush(config.expoAccessToken) : new NoPush(),
});
const server = await app.listen();
console.log(`API слушает ${config.host}:${config.port}`);

const timer = setInterval(() => {
  app.sweep().catch((e) => console.error('[sweep]', (e as Error).message));
}, config.sweepIntervalMs);

async function shutdown() {
  clearInterval(timer);
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
