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

// رموز الأخطاء القادمة من دوال RPC → حالة HTTP مطابقة للسلوك السابق.
const STATUS_BY_CODE: Record<string, number> = {
  unauthenticated: 401,
  no_student: 403,
  not_approved: 403,
  no_session: 403,
  not_enrolled: 403,
  no_geofence: 503,
  no_credential: 401,
  no_challenge: 400,
  already_recorded: 409,
};

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

    // (1) استدعاء واحد يجمع: حالة الطالب + المحاضرة + التسجيل + النطاق + مفتاح الجهاز + التحدي.
    const { data: prepared, error: prepareError } = await db.database.rpc('check_in_prepare', {
      p_session_id: actualSessionId,
      p_credential_id: assertion.id,
    });
    if (prepareError) return json({ error: prepareError.message }, 500);
    const prep = prepared as Record<string, any> | null;
    if (!prep?.ok) {
      const code = String(prep?.code ?? 'unknown');
      return json({ error: prep?.error ?? 'تعذر تسجيل الحضور' }, STATUS_BY_CODE[code] ?? 500);
    }

    const geo = prep.geofence as { latitude: number; longitude: number; radius_meters: number };
    const distance = haversineDistance(latitude, longitude, geo.latitude, geo.longitude);
    if (distance > geo.radius_meters) return json({ error: 'يجب أن تكون داخل نطاق مبنى الكلية لتسجيل الحضور' }, 403);

    const cred = prep.credential as { id: string; credential_id: string; public_key_hex: string; sign_count: number };
    const challenge = prep.challenge as { id: string; value: string };

    // (2) التحقق التشفيري من بصمة الجهاز (يبقى في الذاكرة، لا يمس قاعدة البيانات).
    const verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challenge.value,
      expectedOrigin: appOrigin(req),
      expectedRPID: new URL(appOrigin(req)).hostname,
      credential: { id: cred.credential_id, publicKey: hexToBytes(cred.public_key_hex), counter: Number(cred.sign_count) },
    });
    if (!verification.verified) return json({ error: 'فشل التحقق من بصمة الجهاز' }, 401);

    // (3) استدعاء واحد يكتب الحضور + يحدّث العدّاد + يحذف التحدي ذرّيًا.
    const { data: committed, error: commitError } = await db.database.rpc('check_in_commit', {
      p_session_id: actualSessionId,
      p_latitude: latitude,
      p_longitude: longitude,
      p_distance_meters: distance,
      p_credential_id: cred.credential_id,
      p_credential_row_id: cred.id,
      p_new_sign_count: verification.authenticationInfo.newCounter,
      p_challenge_row_id: challenge.id,
    });
    if (commitError) return json({ error: commitError.message }, 500);
    const done = committed as Record<string, any> | null;
    if (!done?.ok) {
      const code = String(done?.code ?? 'unknown');
      return json({ error: done?.error ?? 'تعذر تسجيل الحضور' }, STATUS_BY_CODE[code] ?? 500);
    }
    return json({ message: done.message ?? 'تم تسجيل حضورك بنجاح' });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر تسجيل الحضور' }, 500);
  }
}
