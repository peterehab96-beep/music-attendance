import { createAdminClient } from 'npm:@insforge/sdk';

const headers = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-google-sync-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

function normalizeDigits(value: unknown) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/\D/g, '');
}

function toHex(bytes: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const syncSecret = Deno.env.get('GOOGLE_SHEETS_SYNC_SECRET');
    if (!syncSecret) return json({ error: 'Google Sheets sync secret is not configured' }, 500);

    const bodyText = await req.text();
    const providedSignature = req.headers.get('x-google-sync-signature')?.trim().toLowerCase() ?? '';
    const expectedSignature = await hmacHex(syncSecret, bodyText);
    if (!providedSignature || !timingSafeEqual(providedSignature, expectedSignature)) return json({ error: 'Invalid sync signature' }, 401);

    const { rows } = JSON.parse(bodyText) as { rows?: Array<{ national_id?: unknown; full_name_reference?: unknown; level?: unknown }> };
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000) return json({ error: 'Sheet must contain 1 to 5000 rows' }, 400);

    const cleanRows = rows.map((row) => {
      const levelText = normalizeDigits(row.level);
      return {
        national_id: normalizeDigits(row.national_id),
        full_name_reference: String(row.full_name_reference ?? '').trim(),
        level: levelText ? Number(levelText) : null,
      };
    }).filter((row) => /^(\d{6,9}|\d{14})$/.test(row.national_id) && row.full_name_reference && [1, 2, 3, 4].includes(Number(row.level)));

    if (!cleanRows.length) return json({ error: 'No valid whitelist rows were found' }, 400);

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    if (!apiKey) return json({ error: 'Server API key is not configured' }, 500);
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    const uniqueRows = [...new Map(cleanRows.map((row) => [row.national_id, row])).values()];
    const ids = uniqueRows.map((row) => row.national_id);
    const { data: existingRows, error: selectError } = await db.database
      .from('national_ids')
      .select('id,national_id,is_claimed')
      .in('national_id', ids);
    if (selectError) return json({ error: selectError.message }, 500);

    const existingById = new Map(((existingRows ?? []) as Array<{ id: string; national_id: string; is_claimed: boolean }>).map((row) => [row.national_id, row]));
    const insertRows = uniqueRows.filter((row) => !existingById.has(row.national_id)).map((row) => ({
      national_id: row.national_id,
      full_name_reference: row.full_name_reference,
      level: row.level,
      uploaded_by: null,
    }));
    const updateRows = uniqueRows.filter((row) => {
      const existing = existingById.get(row.national_id);
      return existing && !existing.is_claimed;
    });
    const skippedClaimed = uniqueRows.filter((row) => existingById.get(row.national_id)?.is_claimed).length;

    if (insertRows.length) {
      const { error } = await db.database.from('national_ids').insert(insertRows);
      if (error) return json({ error: error.message }, 500);
    }
    for (const row of updateRows) {
      const existing = existingById.get(row.national_id);
      if (!existing) continue;
      const { error } = await db.database.from('national_ids').update({
        full_name_reference: row.full_name_reference,
        level: row.level,
        uploaded_by: null,
      }).eq('id', existing.id);
      if (error) return json({ error: error.message }, 500);
    }

    return json({
      inserted_count: insertRows.length,
      updated_count: updateRows.length,
      skipped_claimed_count: skippedClaimed,
      valid_row_count: uniqueRows.length,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Google Sheets sync failed' }, 500);
  }
}
