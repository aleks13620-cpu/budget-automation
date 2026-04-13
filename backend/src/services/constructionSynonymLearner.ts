import type { Database } from 'better-sqlite3';
import { invalidateMatcherSynonymCaches } from './matcher';

function tokenizeNormalized(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Эвристика: короткий токен (аббревиатура) ↔ длинное слово-расшифровка. */
function abbrevMatchesExpansion(abbr: string, expansion: string): boolean {
  const a = abbr.toLowerCase();
  const e = expansion.toLowerCase();
  if (a.length < 2 || a.length > 4) return false;
  if (!/^[\p{L}\d]+$/u.test(a)) return false;
  if (e.length < a.length + 3) return false;
  if (e[0] !== a[0]) return false;
  for (let i = 1; i < a.length; i++) {
    if (!e.includes(a[i]!)) return false;
  }
  return true;
}

/**
 * После подтверждения матча — добавить пары аббревиатура ↔ полная форма в construction_synonyms.
 */
export function learnConstructionSynonymsFromConfirmedMatch(
  db: Database,
  specNormalized: string,
  invoiceNormalized: string,
  confidence: number,
): void {
  if (confidence < 0.85) return;

  const specTok = tokenizeNormalized(specNormalized);
  const invTok = tokenizeNormalized(invoiceNormalized);
  const invSet = new Set(invTok);
  const specSet = new Set(specTok);

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO construction_synonyms (abbreviation, full_form, category, source, times_used)
     VALUES (?, ?, 'общее', 'learned', 1)`
  );

  let added = false;

  for (const st of specTok) {
    if (st.length < 2 || invSet.has(st)) continue;
    for (const it of invTok) {
      if (abbrevMatchesExpansion(st, it)) {
        stmt.run(st, it);
        added = true;
        break;
      }
    }
  }

  for (const it of invTok) {
    if (it.length < 2 || specSet.has(it)) continue;
    for (const st of specTok) {
      if (abbrevMatchesExpansion(it, st)) {
        stmt.run(it, st);
        added = true;
        break;
      }
    }
  }

  if (added) invalidateMatcherSynonymCaches();
}
