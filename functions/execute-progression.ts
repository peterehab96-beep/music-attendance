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
    const { submission_id, final_decision, final_case, final_subject_ids, notes } = bodyData;

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    const { data: isAdmin } = await db.database.rpc('is_admin', { p_user_id: authData.user.id });
    if (!isAdmin) return json({ error: 'غير مصرح' }, 403);

    if (!submission_id) return json({ error: 'معرف الطلب مطلوب' }, 400);

    const { data: submission, error: subErr } = await db.database.from('repeater_form_submissions').select('*').eq('id', submission_id).maybeSingle();
    if (subErr || !submission) return json({ error: 'الطلب غير موجود' }, 404);
    if (submission.admin_decision !== null) return json({ error: 'تم التعامل مع هذا الطلب مسبقًا' }, 409);
    if (!submission.student_id) return json({ error: 'لم يتم ربط الطالب بقاعدة البيانات' }, 422);

    const adminId = authData.user.id;
    const now = new Date().toISOString();

    if (final_decision === 'rejected') {
      await db.database.from('repeater_form_submissions').update({ admin_decision: 'rejected', handled_by: adminId, handled_at: now }).eq('id', submission_id);
      return json({ message: 'تم رفض الطلب' });
    }

    const effectiveCase = final_decision === 'corrected' ? final_case : submission.self_reported_case;
    const effectiveSubjects: string[] = final_decision === 'corrected' ? (final_subject_ids ?? []) : (submission.failed_subject_ids ?? []);
    if (effectiveCase !== 'parallel' && effectiveCase !== 'deferred') return json({ error: 'الحالة النهائية غير صالحة' }, 400);
    if (!Array.isArray(effectiveSubjects) || effectiveSubjects.length === 0) return json({ error: 'لا توجد مواد للاعتماد' }, 400);

    // 1) أغلق التسجيلات النشطة الحالية لهذه المواد (active → failed)
    await db.database.from('student_subjects').update({ status: 'failed' }).eq('student_id', submission.student_id).in('subject_id', effectiveSubjects).in('status', ['active', 'parallel']);

    // 2) أنشئ تسجيلًا جديدًا بالحالة المعتمدة — دون حذف التاريخ القديم
    const newStatus = effectiveCase === 'parallel' ? 'parallel' : 'deferred';
    const enrollmentRows = effectiveSubjects.map((subId: string) => ({
      student_id: submission.student_id,
      subject_id: subId,
      status: newStatus,
      academic_year: submission.academic_year,
      notes: notes ?? null,
    }));
    const { error: enrollErr } = await db.database.from('student_subjects').insert(enrollmentRows);
    if (enrollErr) return json({ error: `تعذر تسجيل المواد: ${enrollErr.message}` }, 500);

    // 3) سجل العملية في الأرشيف الدائم
    await db.database.from('academic_progression_log').insert({
      student_id: submission.student_id,
      academic_year: submission.academic_year,
      from_term: submission.term_applying_for,
      to_term: submission.term_applying_for,
      action: final_decision === 'corrected' ? 'manual_override' : (newStatus === 'parallel' ? 'parallel_enrolled' : 'deferred'),
      affected_subject_ids: effectiveSubjects,
      performed_by: adminId,
      notes: notes ?? null,
    });

    // 4) حدّث حالة الطلب في منطقة العزل
    await db.database.from('repeater_form_submissions').update({
      admin_decision: final_decision,
      admin_corrected_case: final_decision === 'corrected' ? final_case : null,
      admin_corrected_subjects: final_decision === 'corrected' ? effectiveSubjects : null,
      handled_by: adminId,
      handled_at: now,
    }).eq('id', submission_id);

    return json({ message: `تم اعتماد وضع "${newStatus === 'parallel' ? 'الموازاة' : 'الترحيل'}" للطالب بنجاح`, effective_case: newStatus, subjects_enrolled: effectiveSubjects.length });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر تنفيذ القرار' }, 500);
  }
}
