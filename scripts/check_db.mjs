import fs from 'node:fs';
import pg from 'pg';
const env = Object.fromEntries(fs.readFileSync('.env.local','utf8').split('\n').filter(l=>l && !l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i), l.slice(i+1).replace(/^['"]|['"]$/g,'')];}));
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();
for (const t of ['Order','LineItem','ScheduleDraft','ScheduleAssignment']) {
  const r = await c.query(`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t]);
  console.log(`${t}:`);
  for (const row of r.rows) console.log(`  ${row.column_name}${row.is_nullable==='NO'?' NOT NULL':''}${row.column_default?` default=${row.column_default}`:''}`);
}
await c.end();
