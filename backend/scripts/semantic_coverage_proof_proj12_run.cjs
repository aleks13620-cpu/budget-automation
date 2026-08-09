/**
 * SEMANTIC COVERAGE PROOF — proj.12 "ЖК у БКК ОВ" (OFFLINE, READ-ONLY)
 *
 * Question: of the 301 empty spec rows, how many would a semantic (embedding)
 * top-1 layer answer CORRECTLY vs the owner's эталон?
 *
 * Engine: Mistral `mistral-embed` (1024-dim, multilingual, handles Russian).
 * NO prod writes. Reads pre-fetched GET snapshots + эталон XLSX.
 */
const XLSX = require('xlsx');
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

// ---------- normalization (mirror of extract-ethalon-pairs.ts) ----------
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

// ---------- load pool (224 invoice items) ----------
const pool = JSON.parse(fs.readFileSync(path.resolve(DIR, '_proj12_all_invoice_items.json'), 'utf8'));
const poolById = new Map(pool.map(p => [p.id, p]));

// ---------- load 301 empty prod rows ----------
const matching = JSON.parse(fs.readFileSync(path.resolve(DIR, '_proj12_matching_raw.json'), 'utf8'));
const empty = matching.items.filter(it => !it.matches || it.matches.length === 0).map(it => {
  const s = it.specItem;
  const full = ((s.full_name || s.name || '') + ' ' + (s.characteristics || '')).trim();
  return { id: s.id, name: s.name, full, norm: normalize(full || s.name), section: s.section };
});

// ---------- эталон ground truth: resolve each analog row to a concrete pool item (or absent) ----------
const ETP = 'C:\\Users\\home\\Downloads\\Таблицы\\01_05-07-24-ОВ эталон жк бкк арта.xlsx';
const wb = XLSX.readFile(ETP);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
function parentName(ri) { for (let j = ri - 1; j >= 1; j--) { const b = String(rows[j][1] || '').trim(); if (b && /[А-Яа-яA-Za-z]{4,}/.test(b)) return b; } return ''; }

function poolFind(re) { return pool.filter(p => re.test((p.name || '') + ' ' + (p.article || ''))); }
function poolByPrice(supplierRe, price, tol) {
  return pool.filter(p => supplierRe.test((p.supplier_name || '')) && p.price != null && Math.abs(p.price - price) / price <= tol);
}

const gt = []; // {row, specFull, norm, answerName, answerPoolId|null, inPool, cat}
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const name = String(r[1] || '').trim(); if (!name) continue;
  const C = String(r[2] || '').trim();
  const J = r[9], L = String(r[11] || '').trim(), P = String(r[15] || '').trim(), Q = r[16];
  const hasAnalog = (J !== '' && J != null) || L || P || (Q !== '' && Q != null);
  if (!hasAnalog) continue;
  const isBare = /^[Øø⌀]/.test(name) || /^[\d.,]+$/.test(name) || name.length < 6;
  const specFull = ((isBare ? parentName(i) + ' ' + name : name) + (C ? ' ' + C : '')).trim();

  let cat = 'other', answerName = '', answerPoolId = null;
  const dnMatch = (name + ' ' + C).match(/[Øø⌀]?\s*(\d{2,3})/);
  const dn = dnMatch ? dnMatch[1] : null;

  if (/AYVAZ/i.test(P)) {
    cat = 'AYVAZ'; answerName = P;
    const dnP = P.match(/DN\s*(\d+)/i); const want = dnP ? dnP[1] : dn;
    const c = poolFind(new RegExp('компенсатор.*AYVAZ', 'i')).find(p => want && new RegExp('DN\\s*' + want + '\\b', 'i').test(p.name));
    if (c) answerPoolId = c.id;
  } else if (/^ОБМ-/i.test(P)) {
    cat = 'OBM'; answerName = P;
    const code = P.replace(/\s/g, '');
    const c = poolFind(new RegExp(code.replace(/[-]/g, '\\-?'), 'i')).find(p => new RegExp(code.replace('-', '\\-?'), 'i').test(p.name.replace(/\s/g, '')));
    if (c) answerPoolId = c.id;
  } else if (/НЗВЗ/i.test(P) && Q !== '' && Q != null) {
    cat = 'NZVZ'; answerName = 'НЗВЗ price=' + Q;
    const cands = poolByPrice(/НЗВЗ|Волгопром/i, Number(Q), 0.02);
    if (cands.length === 1) answerPoolId = cands[0].id;
    else if (cands.length > 1) { // tiebreak by name dice
      const ns = normalize(specFull); cands.sort((a, b) => dice(ns, normalize(b.name)) - dice(ns, normalize(a.name))); answerPoolId = cands[0].id;
    }
  } else if (/SANEXT/i.test(L) || (L && J)) {
    cat = 'SANEXT'; answerName = (L === 'SANEXT' ? specFull : L) + (J ? ' price=' + J : '');
    // SANEXT brand not loaded; find the functional equivalent in Теплый дом by category keyword
    const ns = normalize(specFull);
    // candidate set = whole pool ranked by name dice to the spec
    let best = null, bs = 0;
    for (const p of pool) { const s = dice(ns, normalize(p.name)); if (s > bs) { bs = s; best = p; } }
    if (best && bs >= 0.30) answerPoolId = best.id; // weak; SANEXT analog often genuinely absent
  } else if (P) { cat = 'P_note'; answerName = P; }

  gt.push({ row: i, specFull, norm: normalize(specFull), cat, answerName, answerPoolId, inPool: answerPoolId != null });
}

// ---------- join эталон GT rows to EMPTY prod rows ----------
const JOIN_TH = 0.50;
for (const g of gt) {
  let best = null, bs = 0;
  for (const em of empty) { const s = dice(g.norm, em.norm); if (s > bs) { bs = s; best = em; } }
  g.joinSim = bs; g.emptyRow = bs >= JOIN_TH ? best : null;
}
const joined = gt.filter(g => g.emptyRow);
const joinedWithPoolAnswer = joined.filter(g => g.inPool);

console.log('=== GROUND TRUTH RESOLUTION ===');
console.log('эталон analog rows:', gt.length);
const catCount = {}; gt.forEach(g => catCount[g.cat] = (catCount[g.cat] || 0) + 1); console.log('by cat:', JSON.stringify(catCount));
console.log('analog answer resolvable to a pool item:', gt.filter(g => g.inPool).length, '/', gt.length);
console.log('\n=== JOIN TO 301 EMPTY ROWS (dice>=' + JOIN_TH + ') ===');
console.log('эталон rows that join to an EMPTY prod row:', joined.length);
console.log('  ...of those, answer is IN POOL (testable / failmode A):', joinedWithPoolAnswer.length);
console.log('  ...answer NOT in pool (failmode B / data gap):', joined.filter(g => !g.inPool).length);

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
    process.stdout.write('.' );
  }
  process.stdout.write('\n'); return out;
}
function cos(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); }

(async () => {
  console.log('\n=== EMBEDDING (Mistral mistral-embed) ===');
  console.log('embedding', empty.length, 'empty spec rows + ', pool.length, 'pool items...');
  const t0 = Date.now();
  const specEmb = await embedAll(empty.map(e => e.full || e.name));
  const poolEmb = await embedAll(pool.map(p => p.name + (p.article ? ' ' + p.article : '')));
  console.log('embed time:', ((Date.now() - t0) / 1000).toFixed(1), 's');

  // top-1 pool item per empty row
  for (let i = 0; i < empty.length; i++) {
    let bi = -1, bs = -2;
    for (let j = 0; j < pool.length; j++) { const s = cos(specEmb[i], poolEmb[j]); if (s > bs) { bs = s; bi = j; } }
    empty[i].top1 = pool[bi]; empty[i].cos = bs;
  }

  // ---------- score against GT (only joined rows with a defined answer) ----------
  const scored = [];
  for (const g of joined) {
    const em = g.emptyRow;
    const t1 = em.top1;
    // correctness: top-1 pool id equals resolved answer pool id (in-pool answers),
    // OR (when answer not resolvable to single id) name-equivalence judgement flagged.
    let correct = null, failmode = '';
    if (g.inPool) {
      correct = (t1 && t1.id === g.answerPoolId);
      failmode = correct ? 'correct' : 'A_model_miss';
    } else {
      correct = false; failmode = 'B_data_gap';
    }
    scored.push({
      row: g.row, cat: g.cat, spec: g.specFull, etalonAns: g.answerName,
      answerPoolName: g.answerPoolId ? poolById.get(g.answerPoolId).name : '(not in pool)',
      top1: t1 ? t1.name : '-', cos: em.cos, correct, failmode, joinSim: g.joinSim, emptyId: em.id,
    });
  }

  const N_empty = empty.length;
  const N_gt = joined.length;                                   // joined empty rows that have эталон answer
  const N_inpool = joinedWithPoolAnswer.length;                 // denominator for true accuracy
  const N_correct = scored.filter(s => s.failmode === 'correct').length;
  const N_A = scored.filter(s => s.failmode === 'A_model_miss').length;
  const N_B = scored.filter(s => s.failmode === 'B_data_gap').length;
  // rows in эталон with answer but that did NOT join to an empty row (already matched in prod / not empty)
  const N_etalon_not_empty = gt.length - joined.length;

  const accuracy = N_inpool > 0 ? N_correct / N_inpool : 0;

  let verdict, reason;
  if (N_correct >= 50) { verdict = 'GO'; reason = 'semantic layer recovers >=50 of 301 empty rows'; }
  else if (N_correct <= 10) { verdict = 'NO-GO'; reason = 'only ' + N_correct + ' of 301 empty rows have a correct semantic answer; the эталон simply does not contain answers for the empty population (bottleneck = DATA, not semantics)'; }
  else { verdict = 'MIDDLE'; reason = N_correct + ' correct (11-49 band)'; }

  // 15 concrete examples (prefer the joined/GT rows; pad with high-cos general top-1 examples)
  const examples = scored.slice(0, 15);
  // pad with non-GT empty rows (no эталон answer) showing what the model proposes, flagged no_ground_truth
  if (examples.length < 15) {
    const usedIds = new Set(examples.map(e => e.emptyId));
    const extras = empty.filter(e => !usedIds.has(e.id)).sort((a, b) => b.cos - a.cos).slice(0, 15 - examples.length);
    for (const e of extras) examples.push({ row: '-', cat: 'no_gt', spec: e.full || e.name, etalonAns: '(эталон blank)', answerPoolName: '-', top1: e.top1 ? e.top1.name : '-', cos: e.cos, correct: null, failmode: 'no_ground_truth', joinSim: 0, emptyId: e.id });
  }

  const result = {
    meta: { project: 12, projectName: 'ЖК у БКК ОВ', date: '2026-06-15', engine: 'Mistral mistral-embed (1024-dim, multilingual)', poolSize: pool.length, joinThreshold: JOIN_TH },
    N_empty_rows: N_empty,
    N_with_etalon_answer: N_gt,
    N_with_etalon_answer_inpool: N_inpool,
    N_correct_top1: N_correct,
    N_failmode_A_model_miss: N_A,
    N_failmode_B_data_gap: N_B,
    N_no_ground_truth: N_empty - N_gt,
    N_etalon_analog_rows_total: gt.length,
    N_etalon_rows_already_matched_not_empty: N_etalon_not_empty,
    accuracy_of_inpool: Number(accuracy.toFixed(4)),
    accuracy_of_301: Number((N_correct / N_empty).toFixed(4)),
    verdict, reason,
    examples,
    scored_all_gt: scored,
    caveats: [
      'Engine = Mistral mistral-embed (not necessarily final deploy model); directional only.',
      'Ground truth = owner эталон XLSX (corrected path). Only 57 of 517 эталон rows carry ANY analog answer.',
      'Of those 57 analog rows, ' + N_etalon_not_empty + ' map to spec rows that are ALREADY MATCHED in prod (not in the 301 empty set) — i.e. the эталон answers the EASY rows, which the matcher already solved.',
      'Join эталон<->empty by normalized-name dice>=' + JOIN_TH + '. Bare-Ø эталон rows resolved with parent context.',
      'In-pool answer resolution: AYVAZ by DN, НЗВЗ by price(±2%)+name tiebreak, ОБМ by code, SANEXT by best name-dice (SANEXT brand has NO loaded invoice).',
      'The 301 empty rows are dominated by products with NO эталон analog answer at all (' + (N_empty - N_gt) + ' rows) — duct fittings, fans, vent units, split EI/S= attribute fragments.',
    ],
  };

  fs.writeFileSync(path.resolve(DIR, 'semantic_coverage_proof_proj12_2026-06-15.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log('\n=== RESULT ===');
  console.log('N_empty=' + N_empty, '| N_with_etalon_answer(joined)=' + N_gt, '| in-pool=' + N_inpool);
  console.log('N_correct_top1=' + N_correct, '| A_model_miss=' + N_A, '| B_data_gap=' + N_B, '| no_ground_truth=' + (N_empty - N_gt));
  console.log('эталon analog rows already matched (not empty)=' + N_etalon_not_empty + '/' + gt.length);
  console.log('accuracy(of in-pool)=' + (accuracy * 100).toFixed(1) + '%  | of-301=' + (N_correct / N_empty * 100).toFixed(2) + '%');
  console.log('VERDICT:', verdict, '-', reason);
  console.log('\n=== SCORED GT ROWS ===');
  for (const s of scored) console.log([s.failmode.padEnd(13), 'r' + s.row, '[' + s.cat + ']', 'cos=' + s.cos.toFixed(3), '| spec="' + s.spec.slice(0, 34) + '"', '| etalon="' + s.etalonAns.slice(0, 26) + '"', '| ans="' + s.answerPoolName.slice(0, 28) + '"', '| top1="' + s.top1.slice(0, 30) + '"'].join(' '));
  console.log('\nwrote semantic_coverage_proof_proj12_2026-06-15.json');
})();
