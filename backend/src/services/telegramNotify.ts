import { getDatabase } from '../database';

/**
 * Outbound Telegram notifications for operator feedback (замечания) — design doc F3.
 *
 * CONTRACT:
 * - FIRE-AND-FORGET + FAILS SOFT: never throws, never blocks/breaks the user action
 *   (mirrors recordMetricSnapshot). The HTTP call is not awaited by the caller.
 * - NO-OP unless BOTH TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set — so deploying
 *   this changes nothing and sends nothing until the owner configures the bot.
 * - RESIDENCY (critical, press-release rule "данные на РФ-серверах"): only NON-sensitive
 *   identifiers leave the server — project name, position number, tag/label, optional app
 *   link. NEVER material names, supplier names, prices, or free-text comments — those stay
 *   in the system, reachable via the link.
 * - The bot token is never logged.
 *
 * Env is read at CALL TIME (not module-init): imports run before dotenv.config() in
 * index.ts, so reading process.env at module top would always be empty.
 */

type DB = ReturnType<typeof getDatabase>;
const TIMEOUT_MS = 5000;

function cfg() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chat: process.env.TELEGRAM_CHAT_ID || '',
    appBase: process.env.APP_BASE_URL || '',
  };
}

export function isTelegramConfigured(): boolean {
  const { token, chat } = cfg();
  return Boolean(token && chat);
}

function send(text: string): void {
  const { token, chat } = cfg();
  if (!token || !chat) return; // no-op until configured
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // fire-and-forget; handlers attached so there is never an unhandled rejection
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: ctrl.signal,
  })
    .then(res => { if (!res.ok) console.error(`[telegram] sendMessage HTTP ${res.status}`); })
    .catch(err => console.error('[telegram] send failed:', err instanceof Error ? err.message : 'unknown'))
    .finally(() => clearTimeout(timer));
}

/** Residency-SAFE context for a feedback row: project NAME + position NUMBER only. */
function safeContext(db: DB, projectId: number | null, specItemId: number | null): { project: string; pos: string } {
  let project = projectId != null ? `#${projectId}` : '—';
  let pos = '';
  try {
    if (projectId != null) {
      const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name?: string } | undefined;
      if (p?.name) project = p.name;
    }
    if (specItemId != null) {
      const s = db.prepare('SELECT position_number FROM specification_items WHERE id = ?').get(specItemId) as { position_number?: string } | undefined;
      if (s?.position_number) pos = String(s.position_number).trim();
    }
  } catch { /* context lookup must never break notify */ }
  return { project, pos };
}

function compose(kind: 'new' | 'resolved', project: string, pos: string, label: string): string {
  const { appBase } = cfg();
  const head = kind === 'new' ? '🆕 Замечание' : '✓ Отработано';
  const posPart = pos ? ` · поз. №${pos}` : '';
  const linkPart = kind === 'new' && appBase ? ` · ${appBase.replace(/\/$/, '')}` : '';
  return `${head} · Проект «${project}»${posPart} · «${label}»${linkPart}`;
}

/**
 * Notify on a feedback event. `label` is the residency-safe RU label (tag label or a
 * generic note label like «Замечание (текст)») — the CALLER computes it from the single
 * TAG_LABELS source so this module needs no copy of that map.
 */
export function notifyFeedback(
  db: DB,
  kind: 'new' | 'resolved',
  opts: { projectId: number | null; specItemId: number | null; label: string },
): void {
  try {
    if (!isTelegramConfigured()) return;
    const { project, pos } = safeContext(db, opts.projectId, opts.specItemId);
    send(compose(kind, project, pos, opts.label));
  } catch (err) {
    console.error('[telegram] notifyFeedback failed:', err instanceof Error ? err.message : 'unknown');
  }
}
