/* eslint-disable @typescript-eslint/no-explicit-any */
// Telegram helpers: initData signature validation (Web Crypto, edge safe) and
// live channel-membership checks used by the join gate.
import { getConfig } from './config';

export type TgUser = { id: number | string; first_name?: string; username?: string };

export async function tgCall(method: string, payload: any = {}) {
  const { botToken } = getConfig();
  if (!botToken) return { ok: false, description: 'BOT_TOKEN missing' } as any;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) console.error(`[tg] ${method} failed:`, json.description || json);
    return json;
  } catch (err: any) {
    console.error(`[tg] ${method} error:`, err?.message);
    return { ok: false } as any;
  }
}

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as any,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Validate Telegram Web App initData. Returns the parsed user, or null. */
export async function validateInitData(initData = ''): Promise<TgUser | null> {
  if (!initData) return null;
  const { botToken } = getConfig();
  if (!botToken) return null;

  const pairs = new URLSearchParams(initData);
  const receivedHash = pairs.get('hash');
  if (!receivedHash) return null;

  const dataCheckString = [...pairs.entries()]
    .filter(([k]) => k !== 'hash')
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const computed = toHex(await hmac(secret, dataCheckString));
  if (computed !== receivedHash) return null;

  try {
    return JSON.parse(pairs.get('user') || 'null');
  } catch {
    return null;
  }
}

/** Live membership check for one channel. */
export async function isChannelMember(tgId: string | number, channel: string) {
  const p: any = await tgCall('getChatMember', { chat_id: channel, user_id: tgId });
  return !!(p.ok && ['member', 'administrator', 'creator'].includes(p.result?.status));
}

/**
 * Check every channel in PARALLEL with a hard timeout, so verification always
 * completes in ~1s instead of N sequential Telegram round-trips.
 * Returns the list of channels the user has NOT joined (or has left).
 */
export async function missingChannelsFor(
  tgId: string | number,
  channels: string[],
  timeoutMs = 1500,
): Promise<string[]> {
  const results = await Promise.all(
    channels.map(async (ch) => {
      try {
        const ok = await Promise.race([
          isChannelMember(tgId, ch),
          new Promise<boolean>((res) => setTimeout(() => res(true), timeoutMs)),
        ]);
        return ok ? null : ch;
      } catch {
        return null;
      }
    }),
  );
  return results.filter(Boolean) as string[];
}

export async function sendMessage(chatId: string | number, text: string, extra: any = {}) {
  return tgCall('sendMessage', {
    chat_id: String(chatId),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function answerCallback(id: string, text = '', alert = false) {
  return tgCall('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert });
}
