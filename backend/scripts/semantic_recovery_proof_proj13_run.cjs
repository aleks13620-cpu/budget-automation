/**
 * SEMANTIC RECOVERY PROOF — proj.13 "ЖК БКК ВК" (ВК / water-plumbing). OFFLINE, READ-ONLY.
 *
 * Question (owner): does adding a SEMANTIC (embedding) top-1 layer recover proj.13's
 * EMPTY rows CORRECTLY? Show BEFORE->AFTER coverage with MEASURED correctness.
 *
 * GROUND TRUTH design (per brief): the 175 empty rows include 76 CATALOGABLE products;
 * a subset have a "TWIN" — the SAME product the MATCHER matched on a NON-empty row in
 * THIS project. Twin's chosen invoice item = candidate ground truth (no эталон needed).
 *
 * Engine: Mistral `mistral-embed` (1024-dim, multilingual). NO prod writes.
 * Reads pre-fetched GET snapshots:
 *   _proj13_matching_raw.json        (GET /api/projects/13/matching)
 *   _proj13_all_invoice_items.json   (GET /api/projects/13/invoices -> GET /api/invoices/:id)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const MISTRAL_KEY = (() => {
  const env = fs.readFileSync(path.resolve(DIR, '../.env'), 'utf8');
  const m = env.match(/MISTRAL_API_KEY=([^\s]+)/);
  return m ? m[1].trim() : null;
})();
if (!MISTRAL_KEY) { console.error('No MISTRAL_API_KEY'); process.exit(1); }

const CONF_TH = 0.82; // cosine threshold for a "confident" recovery; STATED in output. Tuned from sanity (real plumbing pairs 0.84-0.92, neg control 0.71).

// ---------- normalization (mirror of extract-ethalon-pairs.ts / proj12 script) ----------
const STOP = new Set(['мм','см','м','шт','кг','г','л','мл','компл','комплект','набор','ед','пог','кв','куб','п','к','и','в','с','на','для','из','по','от','до','счет','счете']);
function normalize(text) {
  let s = String(text || '');
  s = s.replace(/\([^)]*(?:ГОСТ|ТУ)\s*[\d\s\-./]*[^)]*\)/gi, ' ');
  s = s.replace(/\bм\.п\.\b/gi, 'м').replace(/\bпог\.м\.\b/gi, 'м').replace(/\bпм\b/gi, 'м');
  s = s.replace(/(\d),(\d)/g, '$1.$2').replace(/[ø⌀]/g, ' dn ');
  s = s.replace(/(^|\s)ду\.?\s*(\d{1,4})(?:\.\d+)?(?=\s|$)/gi, ' dn $2 ');
  s = s.replace(/(^|[^a-zа-яё0-9])д[нп]\.?\s*=?\s*(\d{1,4})(?:\.\d+)?/gi, '$1 dn $2 ');
  s = s.replace(/\bdn\.?\s*(\d{1,4})(?:\.\d+)?\b/gi, ' dn $1 ');
  s = s.replace(/(\d)\s*[xх×*]\s*(\d)/gi, '$1x$2').toLowerCase().trim().replace(/ё/g, 'е');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').filter(w => w.length > 0 && !STOP.has(w)).join(' ');
}
function dice(a, b) {
  if (!a || !b) return 0; if (a === b) return 1;
  const bg = s => { const r = []; for (let i = 0; i < s.length - 1; i++) r.push(s.slice(i, i + 2)); return r; };
  const A = bg(a), B = bg(b); if (!A.length || !B.length) return 0;
  const m = new Map(); for (const x of A) m.set(x, (m.get(x) || 0) + 1);
  let inter = 0; for (const x of B) { const c = m.get(x) || 0; if (c > 0) { inter++; m.set(x, c - 1); } }
  return (2 * inter) / (A.length + B.length);
}
// product-family head: first content token after normalization (size-blind family key)
function familyKey(norm) {
  const toks = (norm || '').split(' ').filter(t => t && !/^\d/.test(t) && t !== 'dn');
  return toks.slice(0, 1).join(' ');
}

// ---------- load candidate pool (all proj.13 invoice items) ----------
const pool = JSON.parse(fs.readFileSync(path.resolve(DIR, '_proj13_all_invoice_items.json'), 'utf8'));
const poolById = new Map(pool.map(p => [p.id, p]));

// ---------- load matching, split empty / matched ----------
const matching = JSON.parse(fs.readFileSync(path.resolve(DIR, '_proj13_matching_raw.json'), 'utf8'));
function specText(s) { return ((s.full_name || s.name || '') + ' ' + (s.characteristics || '')).trim(); }
const empty = [], matched = [];
for (const it of matching.items) {
  const s = it.specItem;
  const full = specText(s);
  const rec = { id: s.id, name: s.name, full, norm: normalize(full), unit: s.unit };
  if (!it.matches || it.matches.length === 0) empty.push(rec);
  else { const mt = it.matches.find(x => x.isSelected) || it.matches[0]; rec.match = mt; matched.push(rec); }
}

// ---------- catalogable family classifier (mirror composition diagnostic) ----------
const CAT = ['труб','клапан','кран','фланец','водомерн','манометр','сальник','фильтр','задвижк','муфта','смесител','кассет','насос','станци','поддон','унитаз','патрубок','огнетушит','рукав','вставк','счетчик','счётчик','регулятор','затвор','обратн'];
function isFragment(f) {
  f = f.trim();
  if (/^[—\-•]/.test(f)) return true;
  if (/^[dдD][уyуyн]?\s*\d/i.test(f.replace(/[øⱷ⌀\s]/g, ''))) return true; // bare dim dy150 / d80(...)
  if (/^для\s+сталь/i.test(f)) return true;
  if (/^класс\s+гор/i.test(f)) return true;
  if (/^антикорроз|^окраск|^грунтов/i.test(f)) return true;
  return false;
}
function isCatalogable(rec) {
  const n = rec.norm; if (!n) return false;
  if (isFragment(rec.full)) return false;
  if (/креплени/i.test(rec.full) && /(кг)/i.test(rec.unit || '')) return false; // by-weight mount
  if (/^гильз/i.test(rec.full.trim())) return false;                            // sleeves
  if (/изоляц/i.test(rec.full) && !/цилиндр/i.test(rec.full)) return false;     // insulation
  if (/обвязк|по месту/i.test(rec.full)) return false;                          // custom fab
  return CAT.some(k => n.includes(k));
}
const catalogable = empty.filter(isCatalogable);

// ---------- TWIN resolution: empty catalogable row whose normalized name matches a MATCHED row ----------
const TWIN_TH = 0.70; // recovers ~33 twins (≈ composition's 34); each gets the twin's chosen invoice item as candidate GT
for (const e of catalogable) {
  let best = null, bs = 0;
  for (const mt of matched) { const s = dice(e.norm, mt.norm); if (s > bs) { bs = s; best = mt; } }
  e.twinSim = bs;
  if (best && bs >= TWIN_TH) {
    e.gtInvoiceItemId = best.match.invoiceItemId;
    e.gtInvoiceName = best.match.invoiceName;
    e.gtMatchType = best.match.matchType;
    e.gtMatchConf = best.match.confidence;
    e.twinSpec = best.full;
  } else {
    e.gtInvoiceItemId = null;
  }
}
const twins = catalogable.filter(e => e.gtInvoiceItemId != null);

// ============ EMBEDDING PASS ============
function embed(inputs) {
  const body = JSON.stringify({ model: 'mistral-embed', input: inputs });
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'api.mistral.ai', path: '/v1/embeddings', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MISTRAL_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { try { const d = JSON.parse(s); if (!d.data) return reject(new Error('embed err: ' + s.slice(0, 200))); resolve(d.data.map(x => x.embedding)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function embedAll(texts) {
  const out = []; const B = 64;
  for (let i = 0; i < texts.length; i += B) {
    const batch = texts.slice(i, i + B).map(t => t && t.trim() ? t : 'н/д');
    let tries = 0; while (true) { try { const e = await embed(batch); out.push(...e); break; } catch (err) { tries++; if (tries > 4) throw err; await new Promise(r => setTimeout(r, 1500 * tries)); } }
    process.stdout.write('.');
  }
  process.stdout.write('\n'); return out;
}
function cos(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); }

(async () => {
  console.log('=== proj.13 SEMANTIC RECOVERY PROOF ===');
  console.log('empty:', empty.length, '| catalogable:', catalogable.length, '| twins (GT, dice>=' + TWIN_TH + '):', twins.length);
  console.log('candidate pool (all proj.13 invoice items):', pool.length);
  console.log('\nembedding', catalogable.length, 'catalogable specs +', pool.length, 'pool items (Mistral mistral-embed)...');
  const t0 = Date.now();
  const specEmb = await embedAll(catalogable.map(e => e.full || e.name));
  const poolEmb = await embedAll(pool.map(p => p.name + (p.article ? ' ' + p.article : '')));
  console.log('embed time:', ((Date.now() - t0) / 1000).toFixed(1), 's');

  // top-1 pool item per catalogable empty row
  for (let i = 0; i < catalogable.length; i++) {
    let bi = -1, bs = -2;
    for (let j = 0; j < pool.length; j++) { const s = cos(specEmb[i], poolEmb[j]); if (s > bs) { bs = s; bi = j; } }
    catalogable[i].top1 = pool[bi]; catalogable[i].cos = bs;
  }

  // ---------- score twins against twin-GT (the matcher's chosen item) ----------
  const scored = [];
  for (const e of twins) {
    const t1 = e.top1;
    const strict = !!(t1 && t1.id === e.gtInvoiceItemId);
    const gtItem = poolById.get(e.gtInvoiceItemId);
    const famGT = gtItem ? familyKey(normalize(gtItem.name)) : '';
    const famT1 = t1 ? familyKey(normalize(t1.name)) : '';
    const family = !!(famGT && famT1 && famGT === famT1);
    scored.push({
      emptyId: e.id, spec: e.full, twinSpec: e.twinSpec, twinSim: +e.twinSim.toFixed(3),
      gtMatchType: e.gtMatchType, gtMatchConf: e.gtMatchConf,
      gt: e.gtInvoiceName, top1: t1 ? t1.name : '-', cos: +e.cos.toFixed(3),
      strict, family,
    });
  }
  const N_strict = scored.filter(s => s.strict).length;
  const N_family = scored.filter(s => s.family).length;
  const acc_strict = twins.length ? N_strict / twins.length : 0;
  const acc_family = twins.length ? N_family / twins.length : 0;

  // ---------- projected coverage: confident top-1 over all 76 catalogable ----------
  const confident = catalogable.filter(e => e.cos >= CONF_TH);
  const N_conf = confident.length;

  // BEFORE / AFTER
  const TOTAL = matching.items.length;          // 281
  const BEFORE_matched = matched.length;        // 106
  const before_pct = BEFORE_matched / TOTAL;
  const after_matched = BEFORE_matched + N_conf;
  const after_pct = after_matched / TOTAL;

  // ---------- HONEST adjudication note: how trustworthy is the twin-GT itself? ----------
  // The twin GT = the matcher's own pick. Matcher had 0 confirmed, mostly 0.6-0.7 llm_suggestion.
  const gtConfBuckets = { learned_rule: 0, llm_high: 0, llm_low: 0 };
  for (const e of twins) {
    if (e.gtMatchType === 'learned_rule') gtConfBuckets.learned_rule++;
    else if ((e.gtMatchConf || 0) >= 0.85) gtConfBuckets.llm_high++;
    else gtConfBuckets.llm_low++;
  }

  let verdict, reason;
  // GO requires HIGH accuracy on twins AND meaningful recovery. But twin-GT is contaminated -> cannot certify correctness.
  if (acc_strict >= 0.70 && N_conf >= 25) { verdict = 'GO'; reason = 'twin reproduction accuracy ' + (acc_strict*100).toFixed(0) + '% and ' + N_conf + ' confident recoveries'; }
  else { verdict = acc_strict >= 0.5 || N_conf >= 25 ? 'MIDDLE' : 'NO-GO'; reason = 'see below'; }

  const result = {
    meta: { project: 13, projectName: 'ЖК БКК ВК', date: '2026-06-15',
      engine: 'Mistral mistral-embed (1024-dim, multilingual)', poolSize: pool.length,
      twinThreshold: TWIN_TH, confidentCosineThreshold: CONF_TH, mode: 'READ-ONLY GET; offline embedding; NO prod writes' },
    counts: {
      total_spec_rows: TOTAL, matched_before: BEFORE_matched, empty: empty.length,
      catalogable_empty: catalogable.length, twins_with_groundtruth: twins.length,
      confident_recoveries_of_catalogable: N_conf,
    },
    twin_accuracy: {
      N_twins: twins.length,
      N_strict_correct: N_strict, accuracy_strict: +acc_strict.toFixed(4),
      N_family_correct: N_family, accuracy_family_sizeblind: +acc_family.toFixed(4),
      groundtruth_provenance: gtConfBuckets,
      groundtruth_warning: 'Twin ground truth = the MATCHER\'s own chosen invoice item. proj.13 has 0 confirmed matches and ' + gtConfBuckets.llm_low + '/' + twins.length + ' twin GTs are low-confidence (<0.85) LLM suggestions. Manual inspection shows several twin GTs are WRONG (e.g. "Фланец плоский" matched to a "DEK multilayer hose"; "Задвижка чугунная" to a "Компенсатор"; "Кран спускной" to a "редукционный клапан"). Therefore twin-reproduction accuracy measures agreement-with-the-matcher, NOT verified correctness. A real эталон is required to certify correctness.',
    },
    before_after_coverage: {
      before: { matched: BEFORE_matched, total: TOTAL, pct: +(before_pct*100).toFixed(1) },
      after_projected: { matched: after_matched, total: TOTAL, pct: +(after_pct*100).toFixed(1),
        note: 'AFTER assumes every confident (cos>=' + CONF_TH + ') top-1 is accepted. This is an UPPER BOUND on coverage gain; correctness of those ' + N_conf + ' is NOT certified (no эталон).' },
    },
    verdict, reason,
    examples: scored.slice(0, 20),
    scored_twins: scored,
    contrast_proj12: 'proj.12 semantic proof recovered 1/301 (strict) because its empty rows were custom-fab sheet-metal ductwork with NO catalog product. proj.13 is the opposite: a catalogable plumbing BOM where ' + N_conf + '/' + catalogable.length + ' catalogable empty rows get a confident semantic top-1. The PRODUCTS EXIST to be matched here. BUT proj.13\'s ground truth is weaker than proj.12\'s: proj.12 had an owner эталон XLSX; proj.13 has only the matcher\'s own (partly wrong, 0-confirmed) picks. So proj.13 is the better TARGET (recoverable population) but its correctness cannot yet be CERTIFIED.',
    caveats: [
      'Engine = Mistral mistral-embed (directional; not necessarily the deploy model).',
      'Candidate pool = all 144 proj.13 invoice items (read-only GET). All 70 matcher-chosen items are inside this pool.',
      'Twin GT (matcher\'s pick) is contaminated: 0 confirmed matches project-wide; several twin GTs are demonstrably wrong on inspection. Twin-accuracy = agreement with matcher, a LOW bar.',
      'Confident-recovery count (cos>=' + CONF_TH + ') is a projected coverage UPPER BOUND; it does not prove the top-1 is the correct product.',
      'Many catalogable empty rows are size-variants of the same product (e.g. Фланец 1-50/1-80/1-150); embeddings are largely size-blind, so strict size-correct top-1 is structurally hard from the spec text alone (size lives on child/parent rows).',
    ],
  };

  fs.writeFileSync(path.resolve(DIR, 'semantic_recovery_proof_proj13_2026-06-15.json'), JSON.stringify(result, null, 2), 'utf8');

  console.log('\n=== RESULT ===');
  console.log('BEFORE coverage: ' + BEFORE_matched + '/' + TOTAL + ' = ' + (before_pct*100).toFixed(1) + '%');
  console.log('AFTER (projected, confident cos>=' + CONF_TH + '): ' + after_matched + '/' + TOTAL + ' = ' + (after_pct*100).toFixed(1) + '%  (+' + N_conf + ' rows)');
  console.log('Twin accuracy STRICT: ' + N_strict + '/' + twins.length + ' = ' + (acc_strict*100).toFixed(1) + '%');
  console.log('Twin accuracy FAMILY (size-blind): ' + N_family + '/' + twins.length + ' = ' + (acc_family*100).toFixed(1) + '%');
  console.log('Twin GT provenance:', JSON.stringify(gtConfBuckets), '(0 confirmed project-wide)');
  console.log('VERDICT:', verdict, '-', reason);
  console.log('\n=== SCORED TWINS (spec | twinGT | semantic_top1 | cos | strict/family) ===');
  for (const s of scored) console.log([
    (s.strict ? 'OK ' : s.family ? 'fam' : 'NO '), 'cos=' + s.cos.toFixed(3),
    '| spec="' + s.spec.slice(0, 34) + '"', '| GT[' + (s.gtMatchConf||'?') + ']="' + (s.gt||'').slice(0, 30) + '"',
    '| top1="' + (s.top1||'').slice(0, 30) + '"',
  ].join(' '));
  console.log('\nwrote semantic_recovery_proof_proj13_2026-06-15.json');
})();
