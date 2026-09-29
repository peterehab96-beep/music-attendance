import { verifyRegistrationResponse } from 'npm:@simplewebauthn/server';
import { createClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';
const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
const userClient = (req: Request, token: string) => createClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
const currentUser = async (req: Request) => { const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''); if (!token) return null; const client = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token }); const { data } = await client.auth.getCurrentUser(); return data?.user ?? null; };
const appOrigin = (req: Request) => Deno.env.get('APP_ORIGIN') ?? req.headers.get('origin') ?? new URL(req.url).origin;
const bytesToHex = (bytes: Uint8Array) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const user = await currentUser(req);
    if (!user) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);
    const { credential } = await req.json();
    const db = userClient(req, token!);
    const { data: challenge } = await db.database.from('webauthn_challenges').select('*').eq('user_id', user.id).eq('flow', 'registration').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!challenge) return json({ error: 'انتهت جلسة تسجيل الجهاز، ابدأ المحاولة مرة أخرى' }, 400);
    const verification = await verifyRegistrationResponse({ response: credential, expectedChallenge: challenge.challenge, expectedOrigin: appOrigin(req), expectedRPID: new URL(appOrigin(req)).hostname });
    if (!verification.verified || !verification.registrationInfo) return json({ error: 'فشل التحقق من Passkey' }, 401);
    const info = verification.registrationInfo;
    const credentialId = typeof info.credential.id === 'string' ? info.credential.id : credential.id;
    await db.database.from('webauthn_credentials').upsert({ student_id: user.id, credential_id: credentialId, public_key: `\\x${bytesToHex(info.credential.publicKey)}`, sign_count: info.credential.counter, device_label: req.headers.get('user-agent')?.slice(0, 100) ?? null });
    await db.database.from('webauthn_challenges').delete().eq('id', challenge.id);
    return json({ verified: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر حفظ مفتاح الجهاز' }, 500);
  }
}
