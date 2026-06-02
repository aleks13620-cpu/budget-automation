/**
 * Red->green spec for the broken-font name-corruption detector.
 * Run: cd backend && npx ts-node test_name_corruption.ts
 *
 * Fixtures are built from explicit Unicode code points (String.fromCodePoint) so the
 * exact bytes captured from real prod data in Stage 1 are unambiguous in source —
 * Latin/Cyrillic look-alikes (P U+0050 vs Р U+0420) are indistinguishable as literals.
 * Ground truth = Stage-1 manual validation, not the parser.
 */
import {
  isNameCorrupted,
  analyzeNameCorruption,
  NAME_CORRUPTION_RATIO_THRESHOLD,
} from './src/services/nameCorruption';

const cp = (...c: number[]) => String.fromCodePoint(...c);

// real fixtures (each code point matches the Stage-1 hex dump):
const RAD_0 = cp(0x50, 0x420, 0x30, 0x430, 0x30, 0x434, 0x438, 0x430, 0x442, 0x43e, 0x440); // P Р 0 а 0 диатор
const RAD_K = cp(0x50, 0x420, 0x4b, 0x430, 0x30, 0x434, 0x438, 0x430, 0x442, 0x43e, 0x440); // P Р K а 0 диатор
const RAD_L = cp(0x50, 0x420, 0x4c, 0x430, 0x30, 0x434, 0x438, 0x430, 0x442, 0x43e, 0x440); // P Р L а 0 диатор
const KVT = cp(0x32, 0x43a, 0x42, 0x442);                                                   // 2 к B т  (кВт -> Lat B)
const RAD_OK = cp(0x420, 0x430, 0x434, 0x438, 0x430, 0x442, 0x43e, 0x440);                  // Радиатор (clean)
const Y_OBR = cp(0x59, 0x2d, 0x43e, 0x431, 0x440);                                          // Y-обр  (legit)
const D_NAR = cp(0x44, 0x43d, 0x430, 0x440);                                                // Dнар   (legit)
const DU_X = cp(0x414, 0x443, 0x33, 0x32, 0x445, 0x32, 0x35);                               // Ду32х25 (Cyr х=x sep)
const EXPERT = 'EXPERT-ISOL-' + cp(0x41d, 0x424);                                           // EXPERT-ISOL-НФ
const BBR = '47.15.B-B.' + cp(0x420);                                                       // 47.15.B-B.Р
const ANU = cp(0x410, 0x41d, 0x423, 0x33, 0x410, 0x426, 0x41c, 0x421, 0x427, 0x31, 0x31, 0x30, 0x30, 0x33); // АНУ3АЦМСЧ11003

let pass = 0, fail = 0;
function check(desc: string, cond: boolean): void {
  if (cond) pass++;
  else { fail++; console.error('  FAIL:', desc); }
}

// real corruption must be detected
check('RAD_0 sandwich', isNameCorrupted(RAD_0).sandwich === true);
check('RAD_0 NOT latWedge (only digit between)', isNameCorrupted(RAD_0).latWedge === false);
check('RAD_K sandwich', isNameCorrupted(RAD_K).sandwich === true);
check('RAD_K latWedge', isNameCorrupted(RAD_K).latWedge === true);
check('RAD_L latWedge', isNameCorrupted(RAD_L).latWedge === true);
check('KVT sandwich', isNameCorrupted(KVT).sandwich === true);
check('KVT latWedge', isNameCorrupted(KVT).latWedge === true);

// legit HVAC codes must NOT be flagged (these broke the naive rule)
for (const [n, s] of [['Y_OBR', Y_OBR], ['D_NAR', D_NAR], ['DU_X', DU_X], ['EXPERT', EXPERT], ['BBR', BBR], ['RAD_OK', RAD_OK]] as const) {
  check(`${n} NOT sandwich`, isNameCorrupted(s).sandwich === false);
  check(`${n} NOT latWedge`, isNameCorrupted(s).latWedge === false);
}

// known residual: model code is digit-wedge (sandwich) but never lat-wedge
check('ANU sandwich (residual)', isNameCorrupted(ANU).sandwich === true);
check('ANU NOT latWedge', isNameCorrupted(ANU).latWedge === false);

// invoice-level aggregation
const corrupt = analyzeNameCorruption([RAD_0, RAD_K, KVT, RAD_OK]);
check('corrupt invoice ratio >= threshold', corrupt.ratio >= NAME_CORRUPTION_RATIO_THRESHOLD);
check('corrupt latWedgeRows == [1,2]', JSON.stringify(corrupt.latWedgeRows) === JSON.stringify([1, 2]));

const legit = analyzeNameCorruption([DU_X, Y_OBR, EXPERT, D_NAR]);
check('legit invoice below threshold', legit.ratio < NAME_CORRUPTION_RATIO_THRESHOLD);
check('legit latWedgeRows empty', legit.latWedgeRows.length === 0);

check('empty input ratio 0', analyzeNameCorruption([]).ratio === 0);

console.log(`\nname_corruption: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
