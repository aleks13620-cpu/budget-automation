/**
 * Domain-specific lexical aliases for the matcher.
 *
 * Strategy: APPEND canonical tokens to the normalized text instead of replacing
 * synonyms. This way the original Dice-coefficient name similarity still works
 * for invoice items that already match by surface form, but invoice/spec pairs
 * that use different vocabulary for the same concept (e.g. "Воздуховод из
 * тонколистовой оцинкованной стали" on the invoice vs. "ПУ оц." on the spec)
 * now share at least one extra token ("пуоц") that nudges the similarity above
 * the threshold without polluting unrelated rows.
 *
 * Optional gates:
 *   - requiresSection: only enforced when caller passes a section (spec-side).
 *     For invoice-side and rule-side calls (where section is `null`), the gate
 *     is bypassed — invoice items have no section metadata, but if the synonym
 *     surface form is present in the text, the canonical alias still needs to
 *     fire so that BOTH spec and invoice converge on the same canonical token.
 *     Without this, append-not-replace can never raise similarity (one side
 *     gets the canonical token, the other does not — no shared signal).
 *   - requiresCooccur: at least one of these tokens must already appear in the
 *     text. Prevents false-positive aliasing on unrelated lines that happen to
 *     contain a fragment of the synonym.
 */

export interface AliasGroup {
  canonical: string;         // single token, lowercase, no spaces
  synonyms: string[];        // case-insensitive; multi-word allowed
  requiresSection?: string;  // optional: only apply if spec.section starts with this (case-insensitive prefix match)
  requiresCooccur?: string[]; // at least one of these tokens must also be present in text
}

export const DOMAIN_ALIASES: AliasGroup[] = [
  {
    canonical: 'пуоц',
    synonyms: [
      'воздуховод из тонколистовой оцинкованной стали',
      'воздуховод прямоугольный',
      'воздуховод оцинкованный',
      'пу оц',
      'пу оц.',
    ],
    requiresSection: 'Вентиляция',
    requiresCooccur: ['x', 'b=', 'т/м', 'мм'],
  },
  {
    canonical: 'отводоц',
    synonyms: [
      'отвод прямоугольного воздуховода',
      'отвод оц',
      'отвод оц.',
    ],
    requiresSection: 'Вентиляция',
  },
  {
    canonical: 'переходоц',
    synonyms: [
      'переход прямоугольного сечения',
      'переход оц',
      'переход оц.',
    ],
    requiresSection: 'Вентиляция',
  },
  {
    canonical: 'врезкаоц',
    synonyms: [
      'врезка прямоугольная',
      'врезка оц',
      'врезка оц.',
    ],
  },
  {
    canonical: 'клапанппк',
    synonyms: [
      'клапан противопожарный',
      'противопожарный клапан',
      'ppk',
      'ппк',
    ],
  },
  {
    canonical: 'отводкр',
    synonyms: [
      'отвод круглого воздуховода',
    ],
    requiresSection: 'Вентиляция',
    requiresCooccur: ['dn', '°', 'гр'],
  },
  {
    canonical: 'решеткавент',
    synonyms: [
      'решетка вентиляционная алюминиевая',
      'решетка вентиляционная',
      'решетка 1va',
      '1va',
    ],
  },
];

/**
 * Append canonical alias tokens to the text if any of the group's synonyms
 * are found. Append-not-replace: original text is preserved.
 *
 * @param text     normalized text (already lowercased / cleaned)
 * @param section  spec section name, or `null` for invoice-side calls
 */
export function applyDomainAliases(text: string, section?: string | null): string {
  if (!text) return text;
  const lower = text.toLowerCase();
  const tokensToAppend: string[] = [];

  for (const group of DOMAIN_ALIASES) {
    // Section gate: only enforced when caller supplies a section (spec-side).
    // For null/undefined (invoice and rule sides) the gate is bypassed so both
    // sides can converge on the same canonical token via synonym presence alone.
    if (group.requiresSection && section) {
      if (!section.toLowerCase().startsWith(group.requiresSection.toLowerCase())) continue;
    }

    // Co-occurrence gate: at least one signal token must already be present.
    if (group.requiresCooccur && group.requiresCooccur.length > 0) {
      const hasCo = group.requiresCooccur.some(t => lower.includes(t.toLowerCase()));
      if (!hasCo) continue;
    }

    for (const syn of group.synonyms) {
      if (lower.includes(syn.toLowerCase())) {
        if (!tokensToAppend.includes(group.canonical)) {
          tokensToAppend.push(group.canonical);
        }
        break;
      }
    }
  }

  return tokensToAppend.length ? `${text} ${tokensToAppend.join(' ')}` : text;
}
