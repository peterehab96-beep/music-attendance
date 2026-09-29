import { createClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';

const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
const getToken = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const sign = async (value: string, secret: string) => { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))); };

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const token = getToken(req);
    if (!token) return json({ error: 'يجب تسجيل الدخول أولًا' }, 401);
    const client = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { data: auth } = await client.auth.getCurrentUser();
    if (!auth?.user) return json({ error: 'جلسة الدخول غير صالحة' }, 401);
    const userClient = createClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
    const { data: admin } = await userClient.database.from('admins').select('id').eq('id', auth.user.id).maybeSingle();
    if (!admin) return json({ error: 'غير مصرح' }, 403);
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI') ?? 'https://xjh5wnbh.function2.insforge.app/google-auth-callback';
    const secret = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    if (!clientId || !secret) return json({ error: 'لم يتم إعداد Google OAuth بعد' }, 503);
    const payload = `${auth.user.id}.${Date.now()}`;
    const state = `${payload}.${await sign(payload, secret)}`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return json({ url: url.toString() });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'تعذر بدء ربط Google' }, 500); }
}
