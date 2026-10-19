import { createAdminClient } from 'npm:@insforge/sdk';

const headers = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/**
 * الفحص التلقائي المجدول للمادة ٣٥ (cron).
 * ينفّذ المستحق فقط: إنذار أول، ثم إنذار ثانٍ بعد انتهاء المهلة، ثم الحرمان.
 * لا يخصم درجات تلقائيًا — الخصم قرار يدوي للإدمن من تبويب «قانون الحضور ٣٥».
 * التنفيذ idempotent: القيد الفريد على (طالب، مادة، رقم الإجراء) وعلى
 * (طالب، مادة، نوع الإشعار) يمنع أي تكرار.
 */
export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const expectedSecret = Deno.env.get('GOOGLE_SHEETS_SYNC_SECRET');
    if (!expectedSecret) return json({ error: 'Scan secret is not configured' }, 500);
    const providedSecret = req.headers.get('x-sync-secret') ?? new URL(req.url).searchParams.get('secret') ?? '';
    if (!timingSafeEqual(providedSecret, expectedSecret)) return json({ error: 'Invalid scan secret' }, 401);

    let body: { cooldown_days?: unknown; auto_ban?: unknown; dry_run?: unknown } = {};
    try { body = await req.json(); } catch { body = {}; }

    const cooldownDays = Number.isFinite(Number(body.cooldown_days)) ? Math.min(Math.max(Number(body.cooldown_days), 0), 90) : 7;
    const autoBan = body.auto_ban === undefined ? true : Boolean(body.auto_ban);
    const dryRun = Boolean(body.dry_run);
    const minSessions = Number.isFinite(Number(body.min_sessions)) ? Math.min(Math.max(Number(body.min_sessions), 0), 60) : 4;

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    if (!apiKey) return json({ error: 'Server API key is not configured' }, 500);
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });

    const { data, error } = await db.database.rpc('law35_apply_plan', {
      p_cooldown_days: cooldownDays,
      p_auto_ban: autoBan,
      p_dry_run: dryRun,
      p_min_sessions: minSessions,
    });
    if (error) return json({ error: error.message }, 500);

    const rows = (data ?? []) as Array<{ action_type: string; reason: string; applied: boolean }>;
    const warnings = rows.filter((row) => row.action_type === 'warning');
    const deprivations = rows.filter((row) => row.action_type === 'deprivation');

    return json({
      success: true,
      dry_run: dryRun,
      cooldown_days: cooldownDays,
      auto_ban: autoBan,
      min_sessions: minSessions,
      warnings_issued: warnings.length,
      deprivations_issued: deprivations.length,
      affected_students: rows.length,
      actions: rows.map((row) => ({ action_type: row.action_type, reason: row.reason })),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Scan failed' }, 500);
  }
}
