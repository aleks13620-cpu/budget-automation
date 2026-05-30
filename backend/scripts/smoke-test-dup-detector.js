#!/usr/bin/env node
// Smoke test for #15 Phase 2: computeDupGroups.
// Verifies grouping by normalized name + DN, leader = min(id),
// synthesized parent context for parameterized children (e.g. "DN15" rows
// with same position_number → inherit different parents → different groups).

const path = require('path');
const { computeDupGroups } = require(path.join(__dirname, '..', 'dist', 'routes', 'matching'));

let failed = [];
function assert(label, cond) {
  console.log(`  [${cond ? 'OK  ' : 'FAIL'}] ${label}`);
  if (!cond) failed.push(label);
}

// =========================================================================
// Test 1: trivial 4-row duplicate group.
// =========================================================================
console.log('\n=== Test 1: 4 identical pipes DN15 → one group ===');
{
  const specs = [
    { id: 101, name: 'Труба стальная ВГП оцинкованная DN 15', full_name: null, position_number: '1' },
    { id: 102, name: 'Труба стальная ВГП оцинкованная DN 15', full_name: null, position_number: '2' },
    { id: 103, name: 'Труба стальная ВГП оцинкованная DN 15', full_name: null, position_number: '3' },
    { id: 104, name: 'Труба стальная ВГП оцинкованная DN 15', full_name: null, position_number: '4' },
  ];
  const groups = computeDupGroups(specs);
  assert('all 4 specs in a group', groups.size === 4);
  const meta = groups.get(101);
  assert('group size = 4', meta && meta.size === 4);
  assert('leader = 101 (min id)', meta && meta.leaderSpecItemId === 101);
  assert('101 is leader', meta && meta.role === 'leader');
  assert('102/103/104 are followers',
    groups.get(102)?.role === 'follower'
    && groups.get(103)?.role === 'follower'
    && groups.get(104)?.role === 'follower');
  assert('all 4 share same key', meta?.key === groups.get(102)?.key
    && meta?.key === groups.get(103)?.key
    && meta?.key === groups.get(104)?.key);
}

// =========================================================================
// Test 2: two distinct groups + one singleton.
// =========================================================================
console.log('\n=== Test 2: 4 pipes DN15 + 3 valves DN15 + 1 unique → 2 groups ===');
{
  const specs = [
    { id: 201, name: 'Труба стальная ВГП оцинкованная DN 15', full_name: null, position_number: '1' },
    { id: 202, name: 'Труба стальная ВГП оцинкованная DN 15', full_name: null, position_number: '2' },
    { id: 203, name: 'Клапан шаровый Valtec 214 DN 15', full_name: null, position_number: '3' },
    { id: 204, name: 'Клапан шаровый Valtec 214 DN 15', full_name: null, position_number: '4' },
    { id: 205, name: 'Клапан шаровый Valtec 214 DN 15', full_name: null, position_number: '5' },
    { id: 206, name: 'Уникальная позиция xyz', full_name: null, position_number: '6' },
  ];
  const groups = computeDupGroups(specs);
  assert('5 spec_ids in groups (singleton excluded)', groups.size === 5);
  assert('206 (unique) not in any group', !groups.has(206));
  assert('pipe group size = 2', groups.get(201)?.size === 2);
  assert('valve group size = 3', groups.get(203)?.size === 3);
  assert('pipe leader = 201', groups.get(201)?.leaderSpecItemId === 201);
  assert('valve leader = 203', groups.get(203)?.leaderSpecItemId === 203);
  assert('different keys', groups.get(201)?.key !== groups.get(203)?.key);
}

// =========================================================================
// Test 3: same name but different DN → different groups.
// =========================================================================
console.log('\n=== Test 3: same name, different DN → different groups ===');
{
  const specs = [
    { id: 301, name: 'Труба стальная DN 15', full_name: null, position_number: '1' },
    { id: 302, name: 'Труба стальная DN 15', full_name: null, position_number: '2' },
    { id: 303, name: 'Труба стальная DN 20', full_name: null, position_number: '3' },
    { id: 304, name: 'Труба стальная DN 20', full_name: null, position_number: '4' },
  ];
  const groups = computeDupGroups(specs);
  assert('all 4 spec_ids in groups', groups.size === 4);
  assert('301/302 same key', groups.get(301)?.key === groups.get(302)?.key);
  assert('303/304 same key', groups.get(303)?.key === groups.get(304)?.key);
  assert('DN15 group differs from DN20 group',
    groups.get(301)?.key !== groups.get(303)?.key);
}

// =========================================================================
// Test 4: parameterized children inherit DIFFERENT parents → NOT merged.
// (Without synthesizedNameById both "DN15" rows would collapse into one group.)
// =========================================================================
console.log('\n=== Test 4: param children, different parents → NOT merged ===');
{
  const specs = [
    // Family A: parent "Тройник чугунный" with position "1"
    { id: 401, name: 'Тройник чугунный', full_name: 'Тройник чугунный', position_number: '1' },
    { id: 402, name: 'DN 15', full_name: null, position_number: '1' },
    // Family B: parent "Клапан латунный" with position "2"
    { id: 403, name: 'Клапан латунный', full_name: 'Клапан латунный', position_number: '2' },
    { id: 404, name: 'DN 15', full_name: null, position_number: '2' },
  ];
  const groups = computeDupGroups(specs);
  assert('402 and 404 are NOT in same group',
    !groups.has(402) || !groups.has(404) || groups.get(402)?.key !== groups.get(404)?.key);
  // (Either each is unique or they belong to different groups.)
}

// =========================================================================
// Test 5: parameterized children with SAME parent → ARE merged.
// =========================================================================
console.log('\n=== Test 5: param children, same parent → merged ===');
{
  const specs = [
    { id: 501, name: 'Труба ППР', full_name: 'Труба ППР', position_number: '10' },
    { id: 502, name: 'DN 15', full_name: null, position_number: '10' },
    { id: 503, name: 'Труба ППР', full_name: 'Труба ППР', position_number: '11' },
    { id: 504, name: 'DN 15', full_name: null, position_number: '11' },
    // 503 has same full_name → both 502 and 504 synthesize to "Труба ППР DN 15" → 1 group of 2.
    // Note: real-world rows for 501 and 503 are full_name-equal too, they form a separate group of 2.
  ];
  const groups = computeDupGroups(specs);
  assert('502 and 504 in same group',
    groups.has(502) && groups.has(504) && groups.get(502)?.key === groups.get(504)?.key);
  assert('502 group size = 2', groups.get(502)?.size === 2);
  assert('501 and 503 in same group (identical full_name)',
    groups.has(501) && groups.has(503) && groups.get(501)?.key === groups.get(503)?.key);
}

// =========================================================================
// Test 6: leader stability — synthetic injection of extra spec doesn't shift the leader.
// =========================================================================
console.log('\n=== Test 6: leader stability (min id) ===');
{
  const specs = [
    { id: 705, name: 'Клапан Valtec DN 15', full_name: null, position_number: '5' },
    { id: 603, name: 'Клапан Valtec DN 15', full_name: null, position_number: '3' },
    { id: 700, name: 'Клапан Valtec DN 15', full_name: null, position_number: '7' },
    { id: 601, name: 'Клапан Valtec DN 15', full_name: null, position_number: '1' },
  ];
  const groups = computeDupGroups(specs);
  assert('group size = 4', groups.get(601)?.size === 4);
  assert('leader = 601 (min id, regardless of insertion order)',
    groups.get(601)?.leaderSpecItemId === 601
    && groups.get(603)?.leaderSpecItemId === 601
    && groups.get(700)?.leaderSpecItemId === 601
    && groups.get(705)?.leaderSpecItemId === 601);
  assert('601 is leader, others followers',
    groups.get(601)?.role === 'leader'
    && groups.get(603)?.role === 'follower'
    && groups.get(700)?.role === 'follower'
    && groups.get(705)?.role === 'follower');
}

// =========================================================================
// Summary
// =========================================================================
console.log('\n=== Summary ===');
if (failed.length === 0) {
  console.log('SMOKE TEST: PASS — all dup-grouping invariants hold');
  process.exit(0);
} else {
  console.log(`SMOKE TEST: FAIL — ${failed.length} assertions failed:`);
  for (const f of failed) console.log('  ' + f);
  process.exit(1);
}
