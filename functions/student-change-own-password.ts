import { createAdminClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';

const headers = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;

/**
 * تغيير الطالب كلمة مروره بنفسه بعد الدخول.
 * يشترط كلمة المرور الحالية (حماية من سرقة الجلسة) ويستخدم دالة خدمة للتحقق
 * من الـ bcrypt hash الموجود في auth.users — لا تُقرأ الهاشات من المتصفح أبدًا.
 */
export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);

    const userClient = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { data: authData } = await userClient.auth.getCurrentUser();
    if (!authData?.user) return json({ error: 'جلسة الدخول غير صالحة' }, 401);

    let body: { currentPassword?: unknown; newPassword?: unknown } = {};
    try { body = await req.json(); } catch { body = {}; }

    const currentPassword = String(body.currentPassword ?? '');
    const newPassword = String(body.newPassword ?? '');

    if (!currentPassword) return json({ error: 'أدخل كلمة المرور الحالية.' }, 400);
    if (newPassword.length < 8) return json({ error: 'كلمة المرور الجديدة يجب أن تكون ٨ أحرف على الأقل.' }, 400);
    if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/\d/.test(newPassword) || !/[^A-Za-z\d]/.test(newPassword)) {
      return json({ error: 'كلمة المرور الجديدة يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا.' }, 400);
    }
    if (currentPassword === newPassword) return json({ error: 'كلمة المرور الجديدة مطابقة للحالية.' }, 400);

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    if (!apiKey) return json({ error: 'Server API key is not configured' }, 500);
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });

    // حد الـ 3 مرات في الترم: حارس العدّاد على مستوى قاعدة البيانات (يزيد العدّاد عند نجاح التغيير فقط).
    const { data: allowed, error: allowanceError } = await db.database.rpc('student_can_direct_change_password', {
      p_student_id: authData.user.id,
    });
    if (allowanceError) return json({ error: 'تعذر التحقق من رصيد تغيير كلمة المرور.' }, 500);
    if (allowed !== true) return json({ error: 'استنفدت مرات تغيير كلمة المرور المباشرة (3 مرات في الترم الواحد). راجع إدارة القسم أو أرسل طلب إعادة تعيين.' }, 403);

    const { data: verified, error: verifyError } = await db.database.rpc('verify_user_password', {
      p_user_id: authData.user.id,
      p_password: currentPassword,
    });
    if (verifyError) return json({ error: 'تعذر التحقق من كلمة المرور الحالية.' }, 500);
    if (verified !== true) return json({ error: 'كلمة المرور الحالية غير صحيحة.' }, 400);

    const { error: updateError } = await db.database.rpc('admin_set_user_password', {
      p_user_id: authData.user.id,
      p_new_password: newPassword,
    });
    if (updateError) return json({ error: 'تعذر تحديث كلمة المرور.' }, 500);

    // زيادة العدّاد بعد نجاح التغيير فقط (الميزة: تغيير مباشر = 3 مرات لكل ترم).
    await db.database.rpc('student_consume_direct_change', { p_student_id: authData.user.id });

    return json({ success: true, message: 'تم تغيير كلمة المرور بنجاح.' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'حدث خطأ غير متوقع.' }, 500);
  }
}
