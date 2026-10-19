import { createAdminClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';

const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);
    const userClient = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { data: authData } = await userClient.auth.getCurrentUser();
    if (!authData?.user) return json({ error: 'جلسة الدخول غير صالحة' }, 401);
    const { rows } = await req.json();
    if (!Array.isArray(rows) || rows.length > 5000) return json({ error: 'الملف يجب أن يحتوي على 1 إلى 5000 سجل' }, 400);
    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    if (!apiKey) return json({ error: 'مفتاح الخادم غير مهيأ' }, 500);
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    const { data: isAdmin } = await db.database.rpc('is_super_admin', { p_user_id: authData.user.id });
    if (!isAdmin) return json({ error: 'غير مصرح' }, 403);
    const cleanRows = rows.map((row: { national_id?: unknown; full_name_reference?: unknown; level?: unknown }) => {
      const level = row.level === null || row.level === undefined || row.level === '' ? null : Number(row.level);
      return { national_id: String(row.national_id ?? '').replace(/\D/g, ''), full_name_reference: String(row.full_name_reference ?? '').trim(), level };
    }).filter((row: { national_id: string; level: number | null }) => /^(\d{6,9}|\d{14})$/.test(row.national_id) && (row.level === null || Number.isInteger(row.level) && row.level >= 1 && row.level <= 4));
    if (!cleanRows.length) return json({ error: 'لا توجد صفوف صالحة للاستيراد' }, 400);
    const { data: imported, error } = await db.database.rpc('import_national_ids', { p_admin_id: authData.user.id, p_rows: cleanRows });
    if (error) return json({ error: error.message }, 500);
    const report = Array.isArray(imported) ? imported[0] : imported;
    return json({
      inserted_count: Number((report as { inserted_count?: unknown } | null)?.inserted_count ?? 0),
      updated_count: Number((report as { updated_count?: unknown } | null)?.updated_count ?? 0),
      skipped_claimed_count: Number((report as { skipped_claimed_count?: unknown } | null)?.skipped_claimed_count ?? 0),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر استيراد القائمة' }, 500);
  }
}
