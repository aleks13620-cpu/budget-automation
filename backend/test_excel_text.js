const XLSX = require('xlsx');
const fs = require('fs');

const filePath = 'C:\\Users\\home\\vscode101\\data\\uploads\\1771671796618-444421021.xls';

if (!fs.existsSync(filePath)) {
  console.log('FILE NOT FOUND:', filePath);
  process.exit(1);
}

const wb = XLSX.readFile(filePath);
const ws = wb.Sheets[wb.SheetNames[0]];
const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const nonEmptyRows = rawRows.filter(row => row.some(cell => String(cell).trim() !== ''));
const colCount = Math.max(...nonEmptyRows.map(r => r.length), 0);
const nonEmptyCols = Array.from({ length: colCount }, (_, i) => i)
  .filter(ci => nonEmptyRows.some(row => String(row[ci] || '').trim() !== ''));

const text = nonEmptyRows.map(row =>
  nonEmptyCols.map(ci => String(row[ci] || '').replace(/\n/g, ' ').trim()).join('\t')
).join('\n');

const lines = text.split('\n');
console.log('=== TOTAL ROWS:', nonEmptyRows.length, '| COLS:', nonEmptyCols.length, '===');
console.log('=== TEXT LENGTH:', text.length, 'chars | ~input tokens:', Math.round(text.length/4), '===');
console.log('=== SHEETS:', wb.SheetNames.join(', '), '===');
console.log('');
console.log('--- ПЕРВЫЕ 55 СТРОК ---');
lines.slice(0, 55).forEach((line, i) => {
  console.log((i+1).toString().padStart(3) + ' | ' + line.substring(0, 130));
});
if (lines.length > 55) {
  console.log('...');
  console.log('--- ПОСЛЕДНИЕ 5 СТРОК ---');
  lines.slice(-5).forEach((line, i) => {
    console.log((lines.length - 4 + i).toString().padStart(3) + ' | ' + line.substring(0, 130));
  });
}
