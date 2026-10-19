import { createAdminClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';

const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'غير مصرح' }, 401);
    const userClient = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { data: authData } = await userClient.auth.getCurrentUser();
    if (!authData?.user) return json({ error: 'جلسة غير صالحة' }, 401);
    
    const { session_id } = await req.json();
    if (!session_id) return json({ error: 'معرف الجلسة مطلوب' }, 400);

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    
    // Check admin
    const { data: isAdmin } = await db.database.rpc('is_super_admin', { p_user_id: authData.user.id });
    if (!isAdmin) return json({ error: 'غير مصرح — حذف الجلسات نهائيًا للمشرف العام فقط' }, 403);
    
    // Delete session
    const { error } = await db.database.from('lecture_sessions').delete().eq('id', session_id);
    if (error) return json({ error: error.message }, 500);

    return json({ success: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'خطأ داخلي' }, 500);
  }
}
