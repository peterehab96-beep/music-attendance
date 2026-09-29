import { createClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';

const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
const hexToBytes = (value: string) => { const bytes = new Uint8Array(value.length / 2); for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16); return bytes; };

async function decrypt(value: string, secret: string) {
  const raw = hexToBytes(value.replace(/^\\x/, ''));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return new TextDecoder().decode(plain);
}

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }) });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error('تعذر تحديث جلسة Google');
  return body as { access_token: string; expires_in?: number };
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);
    const serverClient = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { data: auth } = await serverClient.auth.getCurrentUser();
    if (!auth?.user) return json({ error: 'جلسة الدخول غير صالحة' }, 401);
    const client = createClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { data: admin } = await client.database.from('admins').select('id').eq('id', auth.user.id).maybeSingle();
    if (!admin) return json({ error: 'غير مصرح' }, 403);
    const { data: stored, error: tokenError } = await client.database.rpc('get_google_tokens', { p_admin_id: auth.user.id });
    const tokenRow = Array.isArray(stored) ? stored[0] : stored;
    if (tokenError || !tokenRow) return json({ error: 'GOOGLE_OAUTH_REQUIRED', message: 'لم يتم ربط حساب Google بعد. سيتم تحويلك لربط الحساب.' }, 400);
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
    const encryptionKey = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY') ?? Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    if (!clientId || !clientSecret || !encryptionKey) return json({ error: 'لم يتم إعداد Google OAuth بعد' }, 503);
    let accessToken = await decrypt(tokenRow.access_token_hex, encryptionKey);
    const refreshToken = await decrypt(tokenRow.refresh_token_hex, encryptionKey);
    if (new Date(tokenRow.expires_at).getTime() < Date.now() + 60_000) {
      try {
        const refreshed = await refreshAccessToken(refreshToken, clientId, clientSecret);
        accessToken = refreshed.access_token;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encryptionKey));
        const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
        const encrypt = async (value: string) => { const iv = crypto.getRandomValues(new Uint8Array(12)); const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value))); const all = new Uint8Array(iv.length + cipher.length); all.set(iv); all.set(cipher, iv.length); return `\\x${Array.from(all).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`; };
        await client.database.rpc('store_google_tokens', { p_admin_id: auth.user.id, p_access_token_hex: await encrypt(accessToken), p_refresh_token_hex: tokenRow.refresh_token_hex.startsWith('\\x') ? tokenRow.refresh_token_hex : `\\x${tokenRow.refresh_token_hex}`, p_expires_at: new Date(Date.now() + Number(refreshed.expires_in ?? 3600) * 1000).toISOString() });
      } catch {
        // Refresh token expired or revoked by Google (e.g. 7-day test mode expiration)
        await client.database.from('admin_google_tokens').delete().eq('admin_id', auth.user.id);
        return json({ error: 'GOOGLE_OAUTH_REQUIRED', message: 'انتهت صلاحية جلسة Google. جاري تحويلك لإعادة الربط...' }, 400);
      }
    }
    const reqBody = await req.clone().json().catch(() => ({}));
    let grades = reqBody.grades;
    if (!grades || !Array.isArray(grades) || grades.length === 0) {
      const { data: dbGrades, error: gradesError } = await client.database.rpc('get_secret_grades', {});
      if (gradesError) return json({ error: gradesError.message }, 500);
      grades = dbGrades ?? [];
      if (reqBody.subject_id) {
        grades = grades.filter((g: any) => g.subject_id === reqBody.subject_id);
      }
    }

    grades.sort((a: any, b: any) => (a.student_name || '').localeCompare(b.student_name || '', 'ar'));

    const subjectName = reqBody.subject_name || grades[0]?.subject_name || 'سجل الدرجات';
    const values = [
      ['م', 'اسم الطالب', 'الرقم القومي', 'المادة', 'المحاضرات الحاضرة', 'إجمالي المحاضرات', 'الدرجة القصوى', 'أعمال السنة'],
      ...grades.map((grade: any, idx: number) => [
        idx + 1,
        grade.student_name,
        grade.national_id,
        grade.subject_name || subjectName,
        grade.attended_sessions,
        grade.total_sessions,
        grade.max_grade,
        grade.grade ?? ''
      ])
    ];

    const createSheet = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          title: `سجل درجات — ${subjectName} — ${new Date().toLocaleDateString('ar-EG')}`
        },
        sheets: [
          {
            properties: {
              title: 'الدرجات',
              rightToLeft: true
            }
          }
        ]
      })
    });

    if (createSheet.status === 401) {
      await client.database.from('admin_google_tokens').delete().eq('admin_id', auth.user.id);
      return json({ error: 'GOOGLE_OAUTH_REQUIRED', message: 'انتهت صلاحية جلسة Google. جاري تحويلك لإعادة الربط...' }, 400);
    }
    const sheet = await createSheet.json();
    if (!createSheet.ok || !sheet.spreadsheetId) return json({ error: 'تعذر إنشاء Google Sheet' }, 502);

    const update = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values })
    });
    if (!update.ok) return json({ error: 'تعذر كتابة البيانات في Google Sheet' }, 502);

    return json({ success: true, url: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit` });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'تعذر التصدير' }, 500); }
}
