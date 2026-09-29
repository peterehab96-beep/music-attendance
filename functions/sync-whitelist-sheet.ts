import { createAdminClient } from 'npm:@insforge/sdk';

const SHEET_ID = '1vH1qNW_XwzMGU0gio9dbEBPzdLwYBAKi04wSytjhTwM';
const GID = '0';
const headers = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function normalizeHeader(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[\s_-]/g, '');
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && text[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = []; cell = '';
      continue;
    }
    cell += char;
  }
  if (cell || row.length) { row.push(cell); if (row.some((value) => value.trim())) rows.push(row); }
  return rows;
}

function rowsFromCsv(csv: string) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const idIndex = headers.findIndex((header) => header.includes('الرقمالقومي') || header.includes('nationalid'));
  const civilIdIndex = headers.findIndex((header) => header.includes('الرقمالمدني') || header.includes('civilid'));
  const nameIndex = headers.findIndex((header) => header.includes('الاسم') || header.includes('name'));
  const levelIndex = headers.findIndex((header) => header.includes('المستوي') || header.includes('level'));
  if ((idIndex < 0 && civilIdIndex < 0) || nameIndex < 0 || levelIndex < 0) throw new Error('Sheet must have national ID (Egyptian) or civil ID (Omani), name, and level columns');
  const seen = new Set<string>();
  return rows.slice(1).map((row) => {
    const national_id = (idIndex >= 0 ? normalizeDigits(row[idIndex]) : '') || (civilIdIndex >= 0 ? normalizeDigits(row[civilIdIndex]) : '');
    const levelText = normalizeDigits(row[levelIndex]);
    return { national_id, full_name_reference: String(row[nameIndex] ?? '').trim(), level: levelText ? Number(levelText) : null };
  }).filter((row) => {
    if (!/^(\d{6,9}|\d{14})$/.test(row.national_id) || !row.full_name_reference || ![1, 2, 3, 4].includes(Number(row.level)) || seen.has(row.national_id)) return false;
    seen.add(row.national_id);
    return true;
  });
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!['GET', 'POST'].includes(req.method)) return json({ error: 'Method not allowed' }, 405);

  try {
    const expectedSecret = Deno.env.get('GOOGLE_SHEETS_SYNC_SECRET');
    if (!expectedSecret) return json({ error: 'Sync secret is not configured' }, 500);
    const providedSecret = req.headers.get('x-sync-secret') ?? new URL(req.url).searchParams.get('secret');
    if (providedSecret !== expectedSecret) return json({ error: 'Invalid sync secret' }, 401);

    // نقطة gviz تُرجع CSV مباشرة حتى مع الشيتات غير العامة (نقطة export تعيد صفحة تسجيل دخول)
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`;
    const sheetResponse = await fetch(csvUrl);
    if (!sheetResponse.ok) return json({ error: `Could not read Google Sheet CSV: ${sheetResponse.status}` }, 502);
    const rows = rowsFromCsv(await sheetResponse.text());
    if (!rows.length) return json({ error: 'No valid rows found in Google Sheet' }, 400);

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    if (!apiKey) return json({ error: 'Server API key is not configured' }, 500);
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    const ids = rows.map((row) => row.national_id);
    const { data: existingRows, error: selectError } = await db.database.from('national_ids').select('id,national_id,is_claimed').in('national_id', ids);
    if (selectError) return json({ error: selectError.message }, 500);

    const existingById = new Map(((existingRows ?? []) as Array<{ id: string; national_id: string; is_claimed: boolean }>).map((row) => [row.national_id, row]));
    const insertRows = rows.filter((row) => !existingById.has(row.national_id)).map((row) => ({ ...row, uploaded_by: null }));
    const updateRows = rows.filter((row) => {
      const existing = existingById.get(row.national_id);
      return existing && !existing.is_claimed;
    });
    const skippedClaimed = rows.filter((row) => existingById.get(row.national_id)?.is_claimed).length;

    if (insertRows.length) {
      const { error } = await db.database.from('national_ids').insert(insertRows);
      if (error) return json({ error: error.message }, 500);
    }
    for (const row of updateRows) {
      const existing = existingById.get(row.national_id);
      if (!existing) continue;
      const { error } = await db.database.from('national_ids').update({ full_name_reference: row.full_name_reference, level: row.level, uploaded_by: null }).eq('id', existing.id);
      if (error) return json({ error: error.message }, 500);
    }

    return json({ inserted_count: insertRows.length, updated_count: updateRows.length, skipped_claimed_count: skippedClaimed, valid_row_count: rows.length });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Sheet sync failed' }, 500);
  }
}
