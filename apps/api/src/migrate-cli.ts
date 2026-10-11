import { createDb, migrate } from './db.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const sql = createDb(url);
const done = await migrate(sql);
console.log(done.length ? `Применено: ${done.join(', ')}` : 'Новых миграций нет');
await sql.end();
