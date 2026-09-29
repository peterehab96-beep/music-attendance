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
    const { password, request_id } = bodyData;
    if (!password || !request_id) return json({ error: 'كلمة المرور ومعرف الطلب مطلوبان' }, 400);

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    
    // Verify request belongs to this user and is approved
    const { data: requestData } = await db.database
      .from('password_reset_requests')
      .select('id, student_id, status, new_password_set')
      .eq('id', request_id)
      .single();
      
    if (!requestData || requestData.student_id !== authData.user.id) return json({ error: 'طلب غير صالح' }, 403);
    if (requestData.status !== 'approved' || requestData.new_password_set) return json({ error: 'الطلب غير متاح للاستخدام' }, 400);

    // Update the user's password. The InsForge SDK has no admin password API
    // (auth.admin.updateUserById does not exist in 1.5.x), so we delegate to a
    // SECURITY DEFINER RPC that bcrypt-hashes the new password into auth.users.
    const { error: authErr } = await db.database.rpc('admin_set_user_password', {
      p_user_id: authData.user.id,
      p_new_password: password,
    });
    if (authErr) return json({ error: 'تعذر تحديث كلمة المرور' }, 500);

    // Mark as used
    await db.database.from('password_reset_requests').update({ new_password_set: true }).eq('id', request_id);

    return json({ success: true, message: 'تم تحديث كلمة المرور بنجاح' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'حدث خطأ' }, 500);
  }
}
