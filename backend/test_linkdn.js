const { parseFromRawData } = require('./dist/services/excelParser');

const header = [
  '\u041f\u043e\u0437.',
  '"\u041d\u0430\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u043d\u0438\u0435 \u0432 \u0441\u043f\u0435\u0446\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u0438"',
  '"\u041d\u0430\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u043d\u0438\u0435 \u0432 \u041a\u0421"',
  '', '', '', '', '', '', '', '', '', '', '', '', ''
];

const rawRows = [
  header,
  ['\u0438\u0437\u043e\u043b\u044f\u0446\u0438\u044f', '\u0426\u0438\u043b\u0438\u043d\u0434\u0440\u044b \u0442\u0435\u043f\u043b\u043e\u0438\u0437\u043e\u043b\u044f\u0446\u0438\u043e\u043d\u043d\u044b\u0435 \u0438\u0437 \u043c\u0438\u043d\u0435\u0440\u0430\u043b\u044c\u043d\u043e\u0439 \u0432\u0430\u0442\u044b', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['\u0438\u0437\u043e\u043b\u044f\u0446\u0438\u044f', '\u03b4=30\u043c\u043c \u00d822', '', '', '', '\u043c', '94', '', '', '', '', '', '', '', '', ''],
  ['\u0438\u0437\u043e\u043b\u044f\u0446\u0438\u044f', '\u03b4=30\u043c\u043c \u00d827', '', '', '', '\u043c', '46', '', '', '', '', '', '', '', '', ''],
];

const mapping = {
  position_number: 0, name: 1, characteristics: null, equipment_code: 2,
  article: null, product_code: null, marking: null, type_size: null,
  manufacturer: null, unit: 5, quantity: 6, price: null, amount: null
};

const result = parseFromRawData(rawRows, 0, mapping, true);
console.log('Parsed items:');
for (const item of result.items) {
  console.log(`  name: ${item.name.slice(0,50)} | pos: ${item.position_number} | full_name: ${item.full_name} | parent: ${item._parentIndex}`);
}
