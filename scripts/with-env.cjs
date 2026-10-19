// غلاف بيئة: يحمّل .env.local + مفتاح المشروع ثم يشغّل السكربت المطلوب مع بيئة كاملة.
const fs = require('fs');
const { pathToFileURL } = require('url');
const path = require('path');
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const proj = JSON.parse(fs.readFileSync('.insforge/project.json', 'utf8'));
process.env.INSFORGE_URL = process.env.INSFORGE_URL || process.env.VITE_INSFORGE_URL;
process.env.INSFORGE_API_KEY = process.env.INSFORGE_API_KEY || proj.api_key;
const target = process.argv[2];
if (!target) { console.error('usage: node scripts/with-env.cjs <script>'); process.exit(1); }
import(pathToFileURL(path.resolve(target)).href).catch((error) => { console.error(error); process.exit(1); });
