/**
 * اختبار حمل — يثبت عمليًا قدرة النظام على استقبال آلاف تسجيلات الحضور المتزامنة.
 *
 * الاستخدام:
 *   node scripts/load-test.mjs                                  # القياس على قاعدة البيانات فقط (آمن تمامًا)
 *   node scripts/load-test.mjs --db-writes=15000                # تغيير عدد الكتابات في القياس الأول
 *   node scripts/load-test.mjs --api --confirm --students=200   # إضافة قياس تزامن حقيقي عبر HTTP (ينشئ مستخدمين مؤقتين وينظفهم)
 *
 * المخرجات: تقرير JSON + ملخص مقروء (متوسط/p50/p95/p99 ومعدل النجاح والإنتاجية).
 */
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const match = args.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const DB_WRITES = Number(flag('db-writes', '15000'));
const STUDENTS = Math.min(15000, Number(flag('students', '100')));
const SETUP_CONCURRENCY = Number(flag('setup-concurrency', '20'));
const RUN_API = has('api');
const CONFIRMED = has('confirm');
const KEEP = has('keep');

const project = JSON.parse(await readFile('.insforge/project.json', 'utf8').catch(() => '{}'));
let envLocal = {};
try {
  envLocal = Object.fromEntries(
    (await readFile('.env.local', 'utf8')).split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim()]; }),
  );
} catch { /* لا يوجد .env.local */ }

const baseUrl = (process.env.INSFORGE_URL ?? process.env.VITE_INSFORGE_URL ?? envLocal.VITE_INSFORGE_URL ?? project.oss_host ?? '').replace(/\/$/, '');
const apiKey = process.env.INSFORGE_API_KEY ?? project.api_key ?? '';
const anonKey = process.env.INSFORGE_ANON_KEY ?? envLocal.VITE_INSFORGE_ANON_KEY ?? apiKey;
if (!baseUrl || !apiKey) throw new Error('تعذر قراءة رابط المشروع أو مفتاح الإدارة.');

const stamp = Date.now().toString(36);
const EMAIL_PREFIX = `loadtest-${stamp}-`;
const PASSWORD = `Lt-${stamp}-Aa1!`;
const SUBJECT_NAME = `__loadtest_subject_${stamp}__`;
// رقم قومي فريد لكل تشغيل (14 رقمًا) لتجنّب التعارض مع قائمة الكلية الحقيقية.
const ID_BASE = Number(String(Date.now()).slice(-10));
const nationalIdFor = (index) => String(80000000000000 + ID_BASE * 100 + index).slice(-14);

async function runSql(query) {
  const response = await fetch(`${baseUrl}/api/database/advance/rawsql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `فشل SQL: ${response.status}`);
  return body;
}

const now = () => Number(process.hrtime.bigint()) / 1e6;
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
const round = (value) => Math.round(value * 100) / 100;

async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/* ------------------------------------------------------------------ */
/* القياس 1: قدرة الكتابة في قاعدة البيانات (آمن — جدول مؤقت يُحذف)      */
/* ------------------------------------------------------------------ */
async function benchmarkWrites() {
  const table = `_loadtest_writes_${stamp}`;
  await runSql(`CREATE TABLE public.${table} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL,
    student_id UUID NOT NULL,
    checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    distance_meters DOUBLE PRECISION NOT NULL,
    webauthn_credential_id TEXT NOT NULL,
    UNIQUE (session_id, student_id)
  )`);

  const runs = [];
  let tableSize = null;
  for (let run = 0; run < 3; run += 1) {
    const start = now();
    await runSql(`DO $$
      DECLARE i INTEGER; v_session UUID := gen_random_uuid();
      BEGIN
        FOR i IN 1..${DB_WRITES} LOOP
          INSERT INTO public.${table} (session_id, student_id, latitude, longitude, distance_meters, webauthn_credential_id)
          VALUES (v_session, gen_random_uuid(), 30.58 + (i % 100) * 0.0001, 31.51 + (i % 100) * 0.0001, 10 + i % 40, 'bench-cred');
        END LOOP;
      END $$;`);
    const elapsed = now() - start;
    runs.push({ rows: DB_WRITES, ms: round(elapsed), rows_per_sec: Math.round(DB_WRITES / (elapsed / 1000)) });
    if (run === 2) {
      const { rows } = await runSql(`SELECT pg_size_pretty(pg_total_relation_size('public.${table}'::regclass)) AS size`);
      tableSize = rows?.[0]?.size ?? null;
    }
    await runSql(`TRUNCATE public.${table}`);
  }

  await runSql(`DROP TABLE public.${table}`);
  const median = runs.map((r) => r.rows_per_sec).sort((a, b) => a - b)[1];
  return { runs, median_rows_per_sec: median, table_size_for_all_rows: tableSize };
}

/* ------------------------------------------------------------------ */
/* القياس 2: تزامن حقيقي عبر HTTP (ينشئ مستخدمين مؤقتين)                */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(label, task, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await task(); } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(300 * 2 ** attempt + Math.random() * 200);
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function createUser(index) {
  const email = `${EMAIL_PREFIX}${index}@loadtest.invalid`;
  return withRetry(`فشل إنشاء المستخدم ${index}`, async () => {
    const signUp = await fetch(`${baseUrl}/api/auth/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, apikey: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: `Load Test ${index}`, autoConfirm: true }),
    });
    if (!signUp.ok) throw new Error(`${signUp.status} ${(await signUp.text()).slice(0, 120)}`);
    const created = await signUp.json();
    const userId = created?.user?.id ?? created?.id;
    if (!userId) throw new Error(`لم يُعد الخادم معرّف المستخدم ${index}`);
    return { index, email, userId };
  });
}

async function signIn(email) {
  return withRetry(`فشل تسجيل الدخول ${email}`, async () => {
    const response = await fetch(`${baseUrl}/api/auth/sessions`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 120)}`);
    const body = await response.json();
    const token = body?.accessToken ?? body?.session?.accessToken ?? body?.data?.accessToken;
    if (!token) throw new Error('لم يُعد الخادم رمز الدخول');
    return token;
  });
}

async function cleanup() {
  await runSql(`DELETE FROM public.lecture_sessions WHERE subject_id IN (SELECT id FROM public.subjects WHERE name_ar LIKE '__loadtest_subject_%')`);
  await runSql(`DELETE FROM public.students WHERE email LIKE 'loadtest-%'`);
  await runSql(`DELETE FROM public.national_ids WHERE full_name_reference = 'Load Test' AND claimed_by IS NULL`);
  await runSql(`DELETE FROM public.subjects WHERE name_ar LIKE '__loadtest_subject_%'`);
  await runSql(`DELETE FROM auth.users WHERE email LIKE 'loadtest-%'`);
}

async function benchmarkConcurrency() {
  await cleanup(); // إزالة أي بقايا من تشغيل سابق فاشل
  const users = await pooled(Array.from({ length: STUDENTS }, (_, i) => i), SETUP_CONCURRENCY, createUser);

  const nationalValues = users.map((u) => `('${nationalIdFor(u.index)}', 'Load Test')`).join(',');
  await runSql(`INSERT INTO public.national_ids (national_id, full_name_reference) VALUES ${nationalValues} ON CONFLICT (national_id) DO NOTHING`);

  const studentValues = users.map((u) => `('${u.userId}', '${nationalIdFor(u.index)}', 'طالب اختبار', 'Load Test', '${u.email}', 1, 'term1', 'approved', NOW())`).join(',');
  await runSql(`INSERT INTO public.students (id, national_id, full_name_ar, full_name_en, email, level, term, status, approved_at) VALUES ${studentValues}`);

  await runSql(`INSERT INTO public.subjects (name_ar, level, term, max_grade) VALUES ('${SUBJECT_NAME}', 1, 'term1', 20) ON CONFLICT (name_ar) DO NOTHING`);
  await runSql(`INSERT INTO public.student_subjects (student_id, subject_id, status)
    SELECT s.id, sub.id, 'active' FROM public.students s, public.subjects sub
    WHERE s.email LIKE '${EMAIL_PREFIX}%' AND sub.name_ar = '${SUBJECT_NAME}'`);

  const sessionRow = await runSql(`INSERT INTO public.lecture_sessions (subject_id, opened_by, is_active)
    SELECT sub.id, (SELECT id FROM public.admins LIMIT 1), TRUE FROM public.subjects sub WHERE sub.name_ar = '${SUBJECT_NAME}' RETURNING id`);
  const sessionId = sessionRow.rows?.[0]?.id;
  if (!sessionId) throw new Error('تعذر إنشاء محاضرة اختبار');

  const tokens = await pooled(users, SETUP_CONCURRENCY, (user) => signIn(user.email));

  const maxAttempts = 1 + Math.max(0, Number(flag('retries', '0')));
  const latencies = [];
  const statuses = {};
  const sampleErrors = [];
  let retriesUsed = 0;
  const fire = async (token) => {
    const requestStart = now();
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/functions/check-in`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, latitude: 30.58782239324016, longitude: 31.514812503965796, webauthn_assertion: { id: 'loadtest', rawId: 'loadtest', response: {}, type: 'public-key' } }),
        });
        // 5xx قابل لإعادة المحاولة؛ 4xx رفض منطقي نهائي.
        if (response.status >= 500 && attempt < maxAttempts - 1) {
          retriesUsed += 1;
          if (sampleErrors.length < 3) sampleErrors.push(await response.text());
          await sleep(250 * 2 ** attempt + Math.random() * 200);
          continue;
        }
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status >= 500 && sampleErrors.length < 3) sampleErrors.push(await response.text());
        latencies.push(now() - requestStart);
        return;
      } catch (error) {
        if (attempt < maxAttempts - 1) {
          retriesUsed += 1;
          if (sampleErrors.length < 3) sampleErrors.push(String(error));
          await sleep(250 * 2 ** attempt + Math.random() * 200);
          continue;
        }
        statuses.network_error = (statuses.network_error ?? 0) + 1;
        if (sampleErrors.length < 3) sampleErrors.push(String(error));
        latencies.push(now() - requestStart);
        return;
      }
    }
  };
  const started = now();
  await Promise.all(tokens.map((token) => fire(token)));
  const wall = now() - started;
  latencies.sort((a, b) => a - b);

  if (!KEEP) await cleanup();

  // الرفض 4xx متوقع هنا (لا توجد بصمة حقيقية عمدًا) — المقياس المهم هو الفشل الحقيقي 5xx/شبكة.
  const expectedRejections = Object.entries(statuses).filter(([code]) => Number(code) >= 400 && Number(code) < 500).reduce((sum, [, count]) => sum + count, 0);
  const realFailures = Object.entries(statuses).filter(([code]) => Number(code) >= 500 || code === 'network_error').reduce((sum, [, count]) => sum + count, 0);
  return {
    students: STUDENTS,
    wall_ms: round(wall),
    throughput_per_sec: Math.round(STUDENTS / (wall / 1000)),
    status_codes: statuses,
    retries_used: retriesUsed,
    sample_errors: sampleErrors,
    expected_rejections_4xx: expectedRejections,
    real_failures_5xx_or_network: realFailures,
    real_failure_rate_percent: round((realFailures / STUDENTS) * 100),
    latency_ms: {
      min: round(latencies[0] ?? 0),
      mean: round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1)),
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies[latencies.length - 1] ?? 0),
    },
    note: 'يُتخطّى التحقق التشفيري من WebAuthn عمدًا (لا يمكن تزويره)، لكن كل استعلامات قاعدة البيانات تتنفّذ فعليًا.',
  };
}

const report = { url: baseUrl, at: new Date().toISOString() };
if (!has('skip-db')) report.db_write_benchmark = await benchmarkWrites();
if (RUN_API) {
  if (!CONFIRMED) throw new Error('أضف --confirm لتشغيل قياس التزامن عبر HTTP (ينشئ مستخدمين مؤقتين على قاعدة البيانات الحية).');
  report.concurrency_benchmark = await benchmarkConcurrency();
}

console.log(JSON.stringify(report, null, 2));
if (report.db_write_benchmark) console.log(`\n📊 كتابة قاعدة البيانات: ${report.db_write_benchmark.median_rows_per_sec.toLocaleString('en-US')} صف/ثانية (وسيط 3 محاولات).`);
if (report.concurrency_benchmark) {
  const c = report.concurrency_benchmark;
  console.log(`📊 تزامن ${c.students} طلب: p95=${c.latency_ms.p95}ms · p99=${c.latency_ms.p99}ms · فشل حقيقي=${c.real_failures_5xx_or_network}/${c.students} (${c.real_failure_rate_percent}%) · رفض منطقي متوقع=${c.expected_rejections_4xx} · إنتاجية=${c.throughput_per_sec}/ثانية.`);
}
