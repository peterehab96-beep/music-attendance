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

    let bodyData;
    try { bodyData = await req.json(); } catch { bodyData = {}; }
    const { academic_year, term_applying_for, rows } = bodyData;

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    const { data: isAdmin } = await db.database.rpc('is_super_admin', { p_user_id: authData.user.id });
    if (!isAdmin) return json({ error: 'غير مصرح' }, 403);

    if (!Array.isArray(rows) || rows.length === 0) return json({ error: 'لا توجد بيانات للاستيراد' }, 400);

    const inserted: string[] = [];
    const errors: Array<Record<string, unknown>> = [];

    // قائمة المواد كلها مرة واحدة لمطابقة الأسماء
    const { data: allSubjects } = await db.database.from('subjects').select('id, name_ar');
    const nameToId = new Map((allSubjects ?? []).map((s: { id: string; name_ar: string }) => [s.name_ar.trim(), s.id]));

    for (const row of rows) {
      const nationalId = String(row.national_id ?? row['رقم الهوية'] ?? '').trim();
      if (!/^(\d{6,9}|\d{14})$/.test(nationalId)) { errors.push({ row: nationalId || '—', reason: 'رقم هوية غير صالح' }); continue; }

      const { data: student } = await db.database.from('students').select('id, full_name_ar').eq('national_id', nationalId).maybeSingle();

      const rawCase = String(row.self_reported_case ?? row['حالة الرسوب'] ?? '');
      const selfCase = rawCase.includes('مادة') ? 'parallel' : 'deferred';

      const rawSubjects = String(row.failed_subjects ?? row['المواد التي رسبت فيها'] ?? '');
      const subjectNames = rawSubjects.split(/[,،]/).map((s: string) => s.trim()).filter(Boolean);
      const subjectIds = subjectNames.map((n: string) => nameToId.get(n)).filter((id): id is string => Boolean(id));

      const { error } = await db.database.from('repeater_form_submissions').insert({
        national_id: nationalId,
        student_name_ar: row.student_name ?? row['الاسم الكامل'] ?? student?.full_name_ar ?? null,
        academic_year,
        term_applying_for,
        self_reported_case: selfCase,
        failed_subject_ids: subjectIds,
        student_id: student?.id ?? null,
      });
      if (error) { errors.push({ row: nationalId, reason: error.message.slice(0, 120) }); continue; }
      inserted.push(nationalId);
    }

    return json({ message: `تم استيراد ${inserted.length} طالب للمراجعة`, inserted_count: inserted.length, errors_count: errors.length, errors });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر الاستيراد' }, 500);
  }
}
