import { createServerClient } from 'npm:@insforge/sdk/ssr';

const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);
    const db = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    
    const { data: authData } = await db.auth.getCurrentUser();
    if (!authData?.user) return json({ error: 'جلسة الدخول غير صالحة' }, 401);
    
    const student_id = authData.user.id;
    
    // Check pending or unused approved requests
    const { data: pending } = await db.database
      .from('password_reset_requests')
      .select('id')
      .eq('student_id', student_id)
      .in('status', ['pending', 'approved'])
      .eq('new_password_set', false);
      
    if (pending && pending.length > 0) return json({ error: 'يوجد طلب حالي قيد الانتظار أو متاح للاستخدام.' }, 400);

    // Create request
    const { error } = await db.database.from('password_reset_requests').insert([{ student_id, status: 'pending', new_password_set: false }]);
    if (error) return json({ error: error.message }, 500);

    return json({ success: true, message: 'تم إرسال الطلب بنجاح' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'حدث خطأ' }, 500);
  }
}
