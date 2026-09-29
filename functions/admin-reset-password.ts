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
    
    // We should parse the body gracefully
    let bodyData;
    try {
      bodyData = await req.json();
    } catch {
      bodyData = {};
    }
    
    const { request_id, approve } = bodyData;
    if (!request_id) return json({ error: 'معرف الطلب مطلوب' }, 400);

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    
    const { data: isAdmin } = await db.database.rpc('is_admin', { p_user_id: authData.user.id });
    if (!isAdmin) return json({ error: 'غير مصرح' }, 403);
    
    if (!approve) {
      await db.database.from('password_reset_requests').update({ status: 'rejected', handled_by: authData.user.id, handled_at: new Date().toISOString() }).eq('id', request_id);
      return json({ success: true, message: 'تم رفض الطلب' });
    }

    const { data: requestData, error: reqErr } = await db.database.from('password_reset_requests').select('student_id').eq('id', request_id).single();
    if (reqErr || !requestData) return json({ error: 'الطلب غير موجود' }, 404);

    await db.database.from('password_reset_requests').update({ status: 'approved', handled_by: authData.user.id, handled_at: new Date().toISOString() }).eq('id', request_id);
    
    // Increment the counter safely or leave it to be handled differently. Let's just approve it.
    
    return json({ success: true, message: 'تمت الموافقة، يمكن للطالب تعيين كلمة مرور جديدة من حسابه' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'حدث خطأ' }, 500);
  }
}
