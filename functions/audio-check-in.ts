import { createClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';

const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);
    const auth = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { data: authData } = await auth.auth.getCurrentUser();
    if (!authData?.user) return json({ error: 'جلسة الدخول غير صالحة' }, 401);
    const { session_id, sessionId, detected_frequency, detectedFrequency } = await req.json();
    const actualSessionId = session_id ?? sessionId;
    const frequency = Number(detected_frequency ?? detectedFrequency);
    if (!actualSessionId || !Number.isFinite(frequency) || frequency < 14500 || frequency > 18500) return json({ error: 'بيانات الإشارة الصوتية غير صالحة' }, 400);
    const db = createClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { error } = await db.database.rpc('record_audio_attendance', { p_session_id: actualSessionId, p_detected_frequency: frequency });
    if (error) return json({ error: error.message }, error.message.includes('بالفعل') ? 409 : 403);
    return json({ message: 'تم تسجيل حضورك بالإشارة الصوتية بنجاح' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر تسجيل الحضور بالإشارة الصوتية' }, 500);
  }
}
