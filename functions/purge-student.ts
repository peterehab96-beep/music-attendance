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
    const { student_id } = bodyData;
    if (!student_id) return json({ error: 'معرف الطالب مطلوب' }, 400);

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });

    // Is the caller an admin? (the RPC re-checks this, this is an early guard)
    const { data: isAdmin } = await db.database.rpc('is_admin', { p_user_id: authData.user.id });
    if (!isAdmin) return json({ error: 'غير مصرح' }, 403);

    // The RPC verifies admin status again, frees the national id, clears the
    // audit rows and deletes the auth user (cascading to all student data).
    const { data, error } = await db.database.rpc('admin_purge_student', {
      p_student_id: student_id,
      p_admin_id: authData.user.id,
    });
    if (error) return json({ error: error.message }, error.message.includes('مصرح') ? 403 : 500);

    return json({ success: true, freed_national_id: data ?? null, message: 'تم حذف الطالب نهائيًا من النظام بالكامل' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر حذف الطالب' }, 500);
  }
}
