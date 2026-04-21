// Test sanitizeJSON with real GigaChat failure patterns
function sanitizeJSON(json) {
  let result = '';
  let inString = false;
  const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === '\\') {
        const next = json[i + 1];
        if (next !== undefined && VALID_ESCAPES.has(next)) {
          result += ch + next; i++;
        } else if (next !== undefined) {
          // Invalid escape — emit the next char without backslash
          result += next; i++;
        }
      } else if (ch === '"') {
        inString = false; result += ch;
      } else if (ch === '\n' || ch === '\r') {
        result += ' ';
      } else if (ch < ' ') {
        // skip control chars
      } else {
        result += ch;
      }
    } else {
      if (ch === '"') { inString = true; result += ch; }
      else { result += ch; }
    }
  }
  result = result.replace(/,(\s*[}\]])/g, '$1');
  return result;
}

let passed = 0;
let failed = 0;

function test(name, input, expectParseable, expectedField) {
  try {
    const sanitized = sanitizeJSON(input);
    const parsed = JSON.parse(sanitized);
    if (expectedField) {
      const keys = expectedField.path.split('.');
      let val = parsed;
      for (const k of keys) val = val[k];
      if (val === expectedField.value) {
        console.log(`  PASS: ${name}`);
        passed++;
      } else {
        console.log(`  FAIL: ${name} — expected ${JSON.stringify(expectedField.value)}, got ${JSON.stringify(val)}`);
        failed++;
      }
    } else {
      if (expectParseable) {
        console.log(`  PASS: ${name} (parsed OK)`);
        passed++;
      }
    }
  } catch (e) {
    if (!expectParseable) {
      console.log(`  PASS: ${name} (expected parse failure)`);
      passed++;
    } else {
      console.log(`  FAIL: ${name} — ${e.message}`);
      failed++;
    }
  }
}

console.log('\n=== Test 1: Bad escaped character (\\Н, \\р) ===');
// GigaChat outputs \Н (invalid escape before Cyrillic)
test('bad escape \\Н', '{"name": "\\Наименование"}', true, { path: 'name', value: 'Наименование' });
test('bad escape \\р', '{"name": "ООО \\рога"}', true, { path: 'name', value: 'ООО рога' });

console.log('\n=== Test 2: Real newlines inside strings ===');
test('real newline in string', '{"name": "строка\nновая строка"}', true, { path: 'name', value: 'строка новая строка' });
test('real CRLF in string', '{"name": "строка\r\nновая"}', true, { path: 'name', value: 'строка  новая' });

console.log('\n=== Test 3: Trailing commas ===');
test('trailing comma in object', '{"a": 1, "b": 2,}', true, { path: 'a', value: 1 });
test('trailing comma in array', '{"items": [1, 2, 3,]}', true, { path: 'items', value: [1, 2, 3] });

console.log('\n=== Test 4: Valid JSON passes through unchanged ===');
test('valid simple JSON', '{"name": "ООО Тест", "total": 12345.67}', true, { path: 'name', value: 'ООО Тест' });
test('valid JSON with proper escapes', '{"name": "ООО \\"Кавычки\\""}', true, { path: 'name', value: 'ООО "Кавычки"' });

console.log('\n=== Test 5: Mixed issues (real GigaChat output) ===');
const gigaChatLike = `{
  "supplier": {"name": "\\Наименование поставщика: ООО Тест"},
  "items": [
    {"name": "Товар 1\nс переносом", "price": 100, "quantity": 2},
    {"name": "Товар 2", "price": 200, "quantity": 1,}
  ],
  "total_with_vat": 400,
}`;
test('mixed issues', gigaChatLike, true, { path: 'total_with_vat', value: 400 });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
