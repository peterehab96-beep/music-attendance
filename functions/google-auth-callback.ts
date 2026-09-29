import { createAdminClient } from 'npm:@insforge/sdk';

const baseUrl = (req: Request) => Deno.env.get('INSFORGE_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? new URL(req.url).origin;
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0));
const hex = (bytes: Uint8Array) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
const verifySignature = async (value: string, signature: string, secret: string) => { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']); return crypto.subtle.verify('HMAC', key, fromBase64Url(signature), new TextEncoder().encode(value)); };

async function encrypt(value: string, secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)));
  const combined = new Uint8Array(iv.length + cipher.length); combined.set(iv); combined.set(cipher, iv.length);
  return `\\x${hex(combined)}`;
}

export default async function handler(req: Request) {
  const params = new URL(req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state') ?? '';
  const redirect = Deno.env.get('APP_ORIGIN') ?? 'https://xjh5wnbh.insforge.site';
  try {
    const apiKey = Deno.env.get('INSFORGE_API_KEY') ?? Deno.env.get('API_KEY');
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
    const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI') ?? 'https://xjh5wnbh.function2.insforge.app/google-auth-callback';
    if (!code || !apiKey || !clientId || !clientSecret) return Response.redirect(`${redirect}?google=error`, 302);
    const parts = state.split('.');
    const userId = parts[0]; const timestamp = Number(parts[1]); const signature = parts.slice(2).join('.');
    const payload = `${userId}.${parts[1]}`;
    if (!userId || !timestamp || Date.now() - timestamp > 5 * 60 * 1000 || !signature || !(await verifySignature(payload, signature, apiKey))) return Response.redirect(`${redirect}?google=invalid_state`, 302);
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) return Response.redirect(`${redirect}?google=token_error`, 302);
    const encryptionKey = Deno.env.get('GOOGLE_TOKEN_ENCRYPTION_KEY') ?? apiKey;
    const accessToken = await encrypt(tokens.access_token, encryptionKey);
    const refreshToken = await encrypt(tokens.refresh_token ?? '', encryptionKey);
    const db = createAdminClient({ baseUrl: baseUrl(req), apiKey });
    const { error } = await db.database.rpc('store_google_tokens', { p_admin_id: userId, p_access_token_hex: accessToken, p_refresh_token_hex: refreshToken, p_expires_at: new Date(Date.now() + Number(tokens.expires_in ?? 3600) * 1000).toISOString() });
    if (error) return Response.redirect(`${redirect}/admin/grades?google=storage_error`, 302);
    return Response.redirect(`${redirect}/admin/grades?google=connected`, 302);
  } catch { return Response.redirect(`${redirect}/admin/grades?google=error`, 302); }
}
