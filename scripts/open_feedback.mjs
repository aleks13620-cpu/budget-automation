// Dev helper for the "Арта видит неразобранные замечания при заходе" hook (design doc F2).
// Fetches the OPEN operator-feedback queue from prod and prints a compact RU summary.
// Read-only. FAILS SOFT (always exits 0, never throws) so a SessionStart hook can't break a session.
//
// Used by the SessionStart hook in .claude/settings.local.json:  node scripts/open_feedback.mjs
// After SEC-1 (auth token on prod /api) this must send the token — see PROD_TOKEN below.

const BASE = process.env.PROD_API || 'http://5.42.103.63:3001';
const TOKEN = process.env.PROD_TOKEN || ''; // set once SEC-1 lands; sent as Bearer if present
const TIMEOUT_MS = 6000;

async function main() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
    const res = await fetch(`${BASE}/api/feedback/all?status=new`, { signal: ctrl.signal, headers });
    if (!res.ok) { console.log(`[Замечания] очередь недоступна (HTTP ${res.status}).`); return; }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) { console.log('[Замечания оператора] Неразобранных нет. ✅'); return; }

    const byProject = {};
    for (const it of items) {
      const key = it.project_name || `проект ${it.project_id}`;
      (byProject[key] ||= []).push(it);
    }
    const lines = [
      `[Замечания оператора] НЕРАЗОБРАННЫХ: ${items.length}. Разобрать: классифицировать → починить/эскалировать → отметить разобранным.`,
    ];
    for (const [proj, list] of Object.entries(byProject)) {
      lines.push(`• ${proj} (${list.length}):`);
      for (const it of list) {
        const label = it.label || it.comment || it.type;
        const where = it.spec_name ? ` — поз. «${it.spec_name}»` : '';
        const when = String(it.created_at || '').slice(0, 16);
        lines.push(`    - #${it.id} [${it.type}] ${label}${where} (${when})`);
      }
    }
    console.log(lines.join('\n'));
  } catch (e) {
    const why = e && e.name === 'AbortError' ? 'таймаут' : 'сеть/недоступно';
    console.log(`[Замечания] очередь не загружена (${why}).`);
  } finally {
    clearTimeout(timer);
  }
}

main();
