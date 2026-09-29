import { createAdminClient } from 'npm:@insforge/sdk';

const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const dbFor = (req: Request) => createAdminClient({ baseUrl: Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin, apiKey: Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY')! });

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const { national_id } = await req.json();
    if (!/^(\d{6,9}|\d{14})$/.test(String(national_id ?? ''))) return json({ is_available: false, reason: 'invalid' }, 400);
    const db = dbFor(req);
    const { data, error } = await db.database.rpc('validate_national_id', { p_national_id: national_id });
    if (error) return json({ error: error.message }, 500);
    return json(Array.isArray(data) ? data[0] : data);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر التحقق من الرقم القومي' }, 500);
  }
}
