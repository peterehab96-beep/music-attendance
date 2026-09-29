import { createAdminClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';

export const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

export function options(req: Request) {
  return req.method === 'OPTIONS' ? new Response(null, { status: 204, headers: corsHeaders }) : null;
}

export function baseUrl(req: Request) {
  return Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
}

export function adminClient(req: Request) {
  const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
  if (!apiKey) throw new Error('INSFORGE_API_KEY غير مهيأ في بيئة الوظيفة');
  return createAdminClient({ baseUrl: baseUrl(req), apiKey });
}

export async function currentUser(req: Request) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const client = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
  const { data } = await client.auth.getCurrentUser();
  return data?.user ?? null;
}

export function appOrigin(req: Request) {
  return Deno.env.get('APP_ORIGIN') ?? req.headers.get('origin') ?? new URL(req.url).origin;
}

export function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(value: string) {
  const clean = value.replace(/^\\x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
