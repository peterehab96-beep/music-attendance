import { verifyAuthenticationResponse } from 'npm:@simplewebauthn/server';
import { createClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';
const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
const userClient = (req: Request, token: string) => createClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
const currentUser = async (req: Request) => { const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''); if (!token) return null; const client = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token }); const { data } = await client.auth.getCurrentUser(); return data?.user ?? null; };
const appOrigin = (req: Request) => Deno.env.get('APP_ORIGIN') ?? req.headers.get('origin') ?? new URL(req.url).origin;
const hexToBytes = (value: string) => { const clean = value.replace(/^\\x/, ''); const bytes = new Uint8Array(clean.length / 2); for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16); return bytes; };

const EARTH_RADIUS = 6371000;
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const user = await currentUser(req);
    if (!user) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);
    const { session_id, sessionId, latitude, longitude, webauthn_assertion, webauthnAssertion } = await req.json();
    const actualSessionId = session_id ?? sessionId;
    const assertion = webauthn_assertion ?? webauthnAssertion;
    if (!actualSessionId || typeof latitude !== 'number' || typeof longitude !== 'number' || !assertion) return json({ error: 'بيانات تسجيل الحضور غير مكتملة' }, 400);
    const db = userClient(req, token!);
    const { data: student } = await db.database.from('students').select('id,status').eq('id', user.id).single();
    if (!student || student.status !== 'approved') return json({ error: 'لا يمكن تسجيل الحضور قبل اعتماد الحساب' }, 403);
    const { data: session } = await db.database.from('lecture_sessions').select('id,subject_id,is_active').eq('id', actualSessionId).eq('is_active', true).maybeSingle();
    if (!session) return json({ error: 'لا توجد محاضرة نشطة لهذه المادة' }, 403);
    const { data: enrollment } = await db.database.from('student_subjects').select('student_id').eq('student_id', user.id).eq('subject_id', session.subject_id).in('status', ['active', 'parallel']).maybeSingle();
    if (!enrollment) return json({ error: 'هذه المادة ليست ضمن موادك المسجلة' }, 403);
    const { data: geo } = await db.database.rpc('get_active_geofence');
    if (!geo) return json({ error: 'لم يتم إعداد نطاق الكلية بعد' }, 503);
    const activeGeo = Array.isArray(geo) ? geo[0] : geo;
    const distance = haversineDistance(latitude, longitude, activeGeo.latitude, activeGeo.longitude);
    if (distance > activeGeo.radius_meters) return json({ error: 'يجب أن تكون داخل نطاق مبنى الكلية لتسجيل الحضور' }, 403);
    const { data: stored } = await db.database.from('webauthn_credentials').select('*').eq('student_id', user.id).eq('credential_id', assertion.id).maybeSingle();
    if (!stored) return json({ error: 'مفتاح الجهاز غير مرتبط بهذا الحساب' }, 401);
    const { data: challenge } = await db.database.from('webauthn_challenges').select('*').eq('user_id', user.id).eq('flow', 'authentication').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!challenge) return json({ error: 'انتهت جلسة التحقق، أعد المحاولة' }, 400);
    const verification = await verifyAuthenticationResponse({ response: assertion, expectedChallenge: challenge.challenge, expectedOrigin: appOrigin(req), expectedRPID: new URL(appOrigin(req)).hostname, credential: { id: stored.credential_id, publicKey: hexToBytes(stored.public_key), counter: Number(stored.sign_count) } });
    if (!verification.verified) return json({ error: 'فشل التحقق من بصمة الجهاز' }, 401);
    const { error } = await db.database.rpc('record_attendance', { p_session_id: actualSessionId, p_student_id: user.id, p_latitude: latitude, p_longitude: longitude, p_distance_meters: distance, p_webauthn_credential_id: stored.credential_id });
    if (error?.message?.includes('بالفعل')) return json({ error: 'تم تسجيل حضورك بالفعل لهذه المحاضرة' }, 409);
    if (error) return json({ error: error.message }, 500);
    await db.database.from('webauthn_credentials').update({ sign_count: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }).eq('id', stored.id);
    await db.database.from('webauthn_challenges').delete().eq('id', challenge.id);
    return json({ message: 'تم تسجيل حضورك بنجاح' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر تسجيل الحضور' }, 500);
  }
}
