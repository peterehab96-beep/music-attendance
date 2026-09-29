import { readFile, readdir } from 'node:fs/promises';

const baseUrl = process.env.INSFORGE_URL ?? process.env.VITE_INSFORGE_URL;
const apiKey = process.env.INSFORGE_API_KEY;
if (!baseUrl || !apiKey) throw new Error('يجب ضبط INSFORGE_URL وINSFORGE_API_KEY قبل نشر قاعدة البيانات.');

function splitSql(source) {
  const statements = [];
  let current = '';
  let quote = null;
  let dollarTag = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) { current += dollarTag; index += dollarTag.length - 1; dollarTag = null; } else current += character;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote && source[index + 1] === quote) { current += source[index + 1]; index += 1; }
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; current += character; continue; }
    if (character === '$') {
      const match = source.slice(index).match(/^\$[A-Za-z_0-9]*\$/);
      if (match) { dollarTag = match[0]; current += dollarTag; index += dollarTag.length - 1; continue; }
    }
    if (character === ';') { if (current.trim()) statements.push(current.trim()); current = ''; continue; }
    current += character;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

let applied = 0;
const migrationFiles = (await readdir('insforge/migrations')).filter((file) => file.endsWith('.sql')).sort();
async function runSql(query) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/database/advance/rawsql`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `فشل تنفيذ SQL: ${response.status}`);
  return body;
}

await runSql('CREATE TABLE IF NOT EXISTS public.schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
const appliedRows = await runSql('SELECT filename FROM public.schema_migrations');
const completed = new Set((appliedRows.rows ?? []).map((row) => row.filename));
for (const file of migrationFiles) {
  if (completed.has(file)) continue;
  const statements = splitSql(await readFile(`insforge/migrations/${file}`, 'utf8'));
  for (const statement of statements) {
    try { await runSql(statement); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : `فشل نشر ${file} عند العبارة ${applied + 1}`}\nSQL: ${statement.slice(0, 180)}`); }
    applied += 1;
  }
  await runSql(`INSERT INTO public.schema_migrations (filename) VALUES ('${file.replace(/'/g, "''")}') ON CONFLICT (filename) DO NOTHING`);
}
console.log(JSON.stringify({ success: true, message: 'SQL migration applied', statements: applied }));
