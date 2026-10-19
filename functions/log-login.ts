import { createAdminClient } from 'npm:@insforge/sdk';
import { createServerClient } from 'npm:@insforge/sdk/ssr';

// ══════════════════════════════════════════════════════════════════════
// log-login — يسجّل كل محاولة دخول في public.login_events
//   • الوقت الدقيق (created_at) + IP + كل ترويسات الشبكة المتاحة
//   • الجهاز: User-Agent، النظام، اللغة، المنطقة الزمنية، الشاشة
//   • الموقع: إحداثيات GPS إن سمح المتصفح، وإلا تقدير من عنوان الـ IP
//   • لا تُخزَّن كلمات المرور ولا رموز الجلسات — أبدًا.
// ══════════════════════════════════════════════════════════════════════

const headers = { 'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;

function clip(value: unknown, max = 400): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const direct = req.headers.get('x-real-ip') ?? req.headers.get('cf-connecting-ip') ?? '';
  const first = forwarded.split(',').map((part) => part.trim()).find(Boolean) ?? '';
  const ip = (direct || first).trim().replace(/^::ffff:/, '');
  return ip || null;
}

function isPrivateIp(ip: string | null) {
  if (!ip) return true;
  return /^(10\.|127\.|0\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80)/i.test(ip);
}

type GeoLookup = { city: string | null; region: string | null; country: string | null; country_code: string | null; org: string | null };

async function lookupIp(ip: string | null): Promise<GeoLookup | null> {
  if (isPrivateIp(ip)) return null;
  try {
    const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip!)}/json/`, {
      signal: AbortSignal.timeout(2500),
      headers: { Accept: 'application/json', 'User-Agent': 'attendance-audit/1.0' },
    });
    if (!response.ok) return null;
    const data = await response.json() as Record<string, unknown>;
    if (data.error) return null;
    return {
      city: clip(data.city, 120),
      region: clip(data.region, 120),
      country: clip(data.country_name, 120),
      country_code: clip(data.country_code, 8),
      org: clip(data.org ?? data.org_name ?? data.asn, 160),
    };
  } catch {
    return null;
  }
}

function validCoordinate(value: unknown, min: number, max: number): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return Number(number.toFixed(6));
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return json({ error: 'الطريقة غير مسموحة' }, 405);

  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json() as Record<string, unknown>; } catch { body = {}; }

    const status = body.status === 'failed' ? 'failed' : 'success';
    const method = clip(body.method, 24) ?? 'password';
    const identity = clip(body.identity, 160);
    const failureReason = status === 'failed' ? clip(body.failure_reason, 300) : null;
    const device = (body.device ?? {}) as Record<string, unknown>;
    const geo = (body.geo ?? {}) as Record<string, unknown>;

    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });

    // هوية صاحب المحاولة تُستخرج من رمز الجلسة فقط — لا نثق بأي user_id من المتصفح.
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    let userId: string | null = null;
    let accountEmail: string | null = null;
    if (token) {
      try {
        const userClient = createServerClient({ baseUrl: baseUrl(req), anonKey: Deno.env.get('ANON_KEY'), accessToken: token });
        const { data } = await userClient.auth.getCurrentUser();
        userId = data?.user?.id ?? null;
        accountEmail = (data?.user?.email as string | undefined) ?? null;
      } catch { userId = null; }
    }

    const ip = clientIp(req);
    const forwardedFor = clip(req.headers.get('x-forwarded-for'), 300);

    // حماية بسيطة من إغراق السجل: لا أكثر من ٢٠ محاولة فاشلة من نفس الـ IP كل ٥ دقائق.
    if (status === 'failed') {
      const { data: recent } = await db.database
        .from('login_events')
        .select('id')
        .eq('status', 'failed')
        .eq('ip', ip ?? '')
        .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
        .limit(21);
      if (Array.isArray(recent) && recent.length > 20) return json({ ok: true, throttled: true });
    }

    // الدور الحقيقي من الجداول، لا من إدخال المتصفح.
    let role = 'unknown';
    if (userId) {
      const [{ data: adminRow }, { data: studentRow }] = await Promise.all([
        db.database.from('admins').select('id').eq('id', userId).maybeSingle(),
        db.database.from('students').select('id').eq('id', userId).maybeSingle(),
      ]);
      if (adminRow) role = 'admin';
      else if (studentRow) role = 'student';
    }

    const latitude = validCoordinate(geo.latitude, -90, 90);
    const longitude = validCoordinate(geo.longitude, -180, 180);
    const accuracy = validCoordinate(geo.accuracy, 0, 100000);
    const hasGps = latitude !== null && longitude !== null;

    const geoInfo = hasGps ? null : await lookupIp(ip);

    const { error } = await db.database.from('login_events').insert([{
      user_id: userId,
      identity: identity ?? accountEmail,
      role,
      status,
      method,
      failure_reason: failureReason,
      ip,
      forwarded_for: forwardedFor && forwardedFor !== ip ? forwardedFor : null,
      user_agent: clip(req.headers.get('user-agent'), 500),
      platform: clip(device.platform, 120),
      language: clip(device.language, 40),
      timezone: clip(device.timezone, 80),
      screen: clip(device.screen, 40),
      latitude: hasGps ? latitude : null,
      longitude: hasGps ? longitude : null,
      accuracy_m: hasGps ? accuracy : null,
      geo_source: hasGps ? 'gps' : geoInfo ? 'ip' : null,
      city: geoInfo?.city ?? null,
      region: geoInfo?.region ?? null,
      country: geoInfo?.country ?? null,
      country_code: geoInfo?.country_code ?? null,
      org: geoInfo?.org ?? null,
    }]);

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, gps: hasGps, ip_geo: Boolean(geoInfo) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'تعذر تسجيل حدث الدخول' }, 500);
  }
}
