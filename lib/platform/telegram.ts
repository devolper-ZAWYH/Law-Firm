import 'server-only';
import { getSupabaseAdmin } from '../supabase';

/**
 * Telegram push (Phase 7) — FULLY OPTIONAL, per company.
 *
 * sendTelegram(companyId, text) sends ONLY when the company has, all three:
 *   • telegram_enabled = true
 *   • a non-empty telegram_bot_token
 *   • a non-empty telegram_chat_id
 * Otherwise it is a silent no-op. Every failure (network, bad token, missing
 * migration) is swallowed — a failed Telegram send must NEVER break the caller
 * (alert evaluation) or the page. Runs on the node runtime (server fetch).
 */

interface TgSettingsRow {
  telegram_enabled: boolean | null;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
}

/**
 * @returns true if a message was actually dispatched to Telegram, false if the
 * company has Telegram disabled/unconfigured or the send failed. Never throws.
 */
export async function sendTelegram(
  companyId: string,
  text: string
): Promise<boolean> {
  if (!companyId || !text) return false;

  try {
    const supabase = getSupabaseAdmin();
    const res = await supabase
      .from('companies')
      .select('telegram_enabled, telegram_bot_token, telegram_chat_id')
      .eq('id', companyId)
      .maybeSingle();
    // If the toggle column isn't migrated yet, res.error is 42703 — treat as off.
    if (res.error) return false;
    const row = res.data as TgSettingsRow | null;
    if (!row) return false;

    const enabled = row.telegram_enabled === true;
    const token = (row.telegram_bot_token ?? '').trim();
    const chatId = (row.telegram_chat_id ?? '').trim();
    if (!enabled || !token || !chatId) return false;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      // Never let a slow Telegram API stall the request that triggered it.
      // `cache: 'no-store'` alone did NOT do that — it governs caching, not
      // duration, so this comment described an intent nothing implemented. The
      // signal is what actually holds the promise: a notification is a
      // side effect, and no side effect should be able to hang the action that
      // caused it.
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    return resp.ok;
  } catch (err) {
    console.error('sendTelegram failed:', err);
    return false;
  }
}
