import { createAdminClient } from 'npm:@insforge/sdk';

const headers = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

function normalizeDigits(value: unknown) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/\D/g, '');
}

// الرسالة العامة واحدة دائمًا حتى لا تعرف أي جهة إن كان الرقم/البريد مسجّلًا فعلًا
// (منع تعداد الحسابات — account enumeration).
const GENERIC_MESSAGE = 'لو البيانات مطابقة لحساب مسجّل، وصل طلبك لإدارة القسم وستستلم كلمة مرور جديدة منهم.';

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    let body: { nationalId?: unknown; email?: unknown } = {};
    try { body = await req.json(); } catch { body = {}; }

    const nationalId = normalizeDigits(body.nationalId);
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!nationalId || !email) return json({ error: 'أدخل الرقم القومي والبريد الإلكتروني.' }, 400);

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    if (!apiKey) return json({ error: 'Server API key is not configured' }, 500);
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });

    const { data: studentRows, error: studentError } = await db.database
      .from('students')
      .select('id, email, status, password_reset_requests_used')
      .eq('national_id', nationalId)
      .limit(1);
    if (studentError) return json({ error: 'تعذر تنفيذ الطلب حاليًا.' }, 500);

    const student = (studentRows ?? [])[0] as
      | { id: string; email: string; status: string; password_reset_requests_used: number }
      | undefined;

    // لا نكشف أي شيء: نجاح عام في كل الحالات، إلا لو الطالب نفسه طلب فوق الحد.
    if (!student || String(student.email ?? '').trim().toLowerCase() !== email) {
      return json({ success: true, message: GENERIC_MESSAGE });
    }

    const used = Number(student.password_reset_requests_used ?? 0);
    if (used >= 3) {
      return json({ success: true, limited: true, message: 'استوفيت الحد الأقصى للطلبات (٣). راجع إدارة القسم مباشرة.' });
    }

    // دفاع عمق: حد يومي (٣ طلبات/٢٤ ساعة) على مستوى قاعدة البيانات —
    // يمنع مضاربة الطلبات السريعة حتى لو كانت العدّاد الترمي لا يزال تحت الحد.
    const { data: dayAllowed } = await db.database.rpc('guard_password_reset_rate', { p_student_id: student.id });
    if (dayAllowed === false) {
      return json({ success: true, limited: true, message: 'استوفيت الحد الأقصى للطلبات (٣). راجع إدارة القسم مباشرة.' });
    }

    // طلب قائم بالفعل؟ لا نكرر — يكفي وجوده في قائمة الإدمن.
    const { data: existing } = await db.database
      .from('password_reset_requests')
      .select('id, status, new_password_set')
      .eq('student_id', student.id)
      .in('status', ['pending', 'approved'])
      .order('requested_at', { ascending: false })
      .limit(1);

    const activeRequest = (existing ?? [])[0] as { id: string; new_password_set: boolean } | undefined;
    if (activeRequest && !activeRequest.new_password_set) {
      return json({ success: true, message: GENERIC_MESSAGE });
    }

    const { error: insertError } = await db.database
      .from('password_reset_requests')
      .insert([{ student_id: student.id, status: 'pending', new_password_set: false }]);
    if (insertError) return json({ error: 'تعذر تسجيل الطلب حاليًا.' }, 500);

    await db.database
      .from('students')
      .update({ password_reset_requests_used: Math.min(used + 1, 3) })
      .eq('id', student.id);

    return json({ success: true, message: GENERIC_MESSAGE });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'حدث خطأ غير متوقع.' }, 500);
  }
}
