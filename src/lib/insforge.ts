import { createClient } from '@insforge/sdk';

const baseUrl = import.meta.env.VITE_INSFORGE_URL as string | undefined;
const anonKey = import.meta.env.VITE_INSFORGE_ANON_KEY as string | undefined;

export const insforge = createClient({
  baseUrl: baseUrl || 'http://localhost:7130',
  anonKey,
  timeout: 20000,
  retryCount: 1,
});

export const database = insforge.database;

export function readableError(error: unknown, fallback = 'حدث خطأ غير متوقع. حاول مرة أخرى.') {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message);
    if (message) return message;
  }
  return fallback;
}
