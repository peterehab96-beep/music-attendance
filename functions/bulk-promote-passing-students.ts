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
    const { student_ids, from_term, academic_year, notes } = bodyData;

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    const { data: isAdmin } = await db.database.rpc('is_super_admin', { p_user_id: authData.user.id });
    if (!isAdmin) return json({ error: 'غير مصرح' }, 403);

    if (!Array.isArray(student_ids) || student_ids.length === 0) return json({ error: 'يجب تحديد طلاب للترقية' }, 400);

    const adminId = authData.user.id;
    let promoted = 0;
    const failed: Array<Record<string, unknown>> = [];

    for (const studentId of student_ids) {
      const { data: student } = await db.database.from('students').select('level, term').eq('id', studentId).maybeSingle();
      if (!student) { failed.push({ student_id: studentId, reason: 'طالب غير موجود' }); continue; }

      let newLevel = student.level;
      let newTerm: string;
      if (from_term === 'term1') newTerm = 'term2';
      else if (from_term === 'term2') { newTerm = 'term1'; newLevel = Math.min(4, student.level + 1); }
      else { newTerm = 'term1'; newLevel = Math.min(4, student.level + 1); }

      // 1) أغلق كل المواد النشطة الحالية (active → passed) كتاريخ أكاديمي
      await db.database.from('student_subjects').update({ status: 'passed' }).eq('student_id', studentId).in('status', ['active', 'parallel']);

      // 2) حدّث الفرقة والترم
      await db.database.from('students').update({ level: newLevel, term: newTerm }).eq('id', studentId);

      // 3) سجّل الطالب أوتوماتيك في مواد الترم/المستوى الجديد
      const { data: newSubjects, error: subjErr } = await db.database.from('subjects').select('id').eq('level', newLevel).eq('term', newTerm);
      if (subjErr) { failed.push({ student_id: studentId, reason: subjErr.message.slice(0, 100) }); continue; }
      if (newSubjects && newSubjects.length) {
        const rows = newSubjects.map((s: { id: string }) => ({ student_id: studentId, subject_id: s.id, status: 'active', academic_year }));
        await db.database.from('student_subjects').insert(rows);
      }

      // 4) سجل العملية
      await db.database.from('academic_progression_log').insert({
        student_id: studentId,
        academic_year,
        from_term,
        to_term: newTerm,
        action: 'promoted',
        performed_by: adminId,
        notes: notes ?? null,
      });
      promoted += 1;
    }

    return json({ message: `تم ترقية ${promoted} طالب بنجاح`, promoted_count: promoted, failed_count: failed.length, failed });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر تنفيذ الترقية' }, 500);
  }
}
