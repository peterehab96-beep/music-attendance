import { createAdminClient } from '@insforge/sdk';
import { spawnSync } from 'node:child_process';

const baseUrl = process.env.INSFORGE_URL ?? process.env.VITE_INSFORGE_URL;
const apiKey = process.env.INSFORGE_API_KEY;
const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
const fullName = process.env.SEED_ADMIN_NAME ?? 'مدير النظام';

if (!baseUrl || !apiKey || !email || !password) {
  throw new Error('يجب ضبط INSFORGE_URL وINSFORGE_API_KEY وSEED_ADMIN_EMAIL وSEED_ADMIN_PASSWORD قبل الزرع.');
}

const client = createAdminClient({ baseUrl, apiKey });
let { data, error } = await client.auth.signUp({ email, password, name: fullName, autoConfirm: true });
if (error || !data?.user) {
  const signedIn = await client.auth.signInWithPassword({ email, password });
  data = signedIn.data;
  error = signedIn.error;
}
if (error || !data?.user) throw new Error(error?.message ?? 'تعذر إنشاء أو تسجيل دخول حساب الإدمن.');

const { error: adminError } = await client.database.from('admins').upsert({ id: data.user.id, full_name: fullName, email: email.toLowerCase() });
if (adminError) {
  const quote = (value) => String(value).replaceAll("'", "''");
  const sql = `INSERT INTO public.admins (id, full_name, email) VALUES ('${quote(data.user.id)}', '${quote(fullName)}', '${quote(email.toLowerCase())}') ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, email = EXCLUDED.email`;
  const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(cli, ['@insforge/cli@latest', '--json', 'db', 'query', sql], { stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(adminError.message);
}
console.log(JSON.stringify({ success: true, adminId: data.user.id, email: email.toLowerCase() }));
