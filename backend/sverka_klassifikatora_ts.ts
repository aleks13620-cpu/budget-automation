/** То же по всей базе, на TS: каждая строка specification_items, без фильтров. */
const fs = require('fs');
const path = require('path');
const BE = 'C:/Users/home/vscode101/budget-automation/backend';
const Database = require(BE + '/node_modules/better-sqlite3');
const { classifySpecItem, buildFullName } = require(BE + '/src/services/specClassifier');

const db = new Database('C:/Users/home/vscode101/budget-automation/database/budget_automation.db',
  { readonly: true });
const rows: any[] = db.prepare('select * from specification_items').all();
db.close();
const byId = new Map<number, any>(rows.map((r) => [r.id, r]));

const out = rows.map((r) => {
  const fullName = buildFullName(r, byId);
  const c = classifySpecItem(r, fullName);
  return { id: r.id, full_name: fullName, group: c.group, mark: c.mark, mark_src: c.markSrc };
});
fs.writeFileSync('C:/Users/home/vscode101/budget-automation/price-harvester/out/sverka_ts.json', JSON.stringify(out, null, 1), 'utf8');
console.log(`ts (вся база): ${out.length} строк`);
