import { generateRegistrationOptions } from 'npm:@simplewebauthn/server';
import { createClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';
const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
const userClient = (req: Request, token: string) => createClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
const currentUser = async (req: Request) => { const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''); if (!token) return null; const client = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token }); const { data } = await client.auth.getCurrentUser(); return data?.user ?? null; };
const appOrigin = (req: Request) => Deno.env.get('APP_ORIGIN') ?? req.headers.get('origin') ?? new URL(req.url).origin;

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const user = await currentUser(req);
    if (!user) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);
    const db = userClient(req, token!);
    const { data: student } = await db.database.from('students').select('id,email,full_name_ar').eq('id', user.id).single();
    if (!student) return json({ error: 'لم يتم العثور على ملف الطالب' }, 404);
    const rpID = new URL(appOrigin(req)).hostname;
    const registrationOptions = await generateRegistrationOptions({
      rpName: 'حضور — التربية الموسيقية',
      rpID,
      userID: new TextEncoder().encode(student.id),
      userName: student.email,
      userDisplayName: student.full_name_ar,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await db.database.from('webauthn_challenges').insert({ user_id: student.id, challenge: registrationOptions.challenge, flow: 'registration' });
    return json(registrationOptions);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر بدء تسجيل مفتاح الجهاز' }, 500);
  }
}
