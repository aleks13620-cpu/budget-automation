import dotenv from 'dotenv'; dotenv.config();
import { parseSpecFromPdf } from './src/services/gigachatSpecFromPdf';

async function main() {
  const result = await parseSpecFromPdf('C:/Users/home/Downloads/Документы/PDF/5-ПР_21 – ОВ (1)-45-75.pdf');
  console.log('Total items:', result.items.length);

  // Show items with full_name (parent + child merged)
  console.log('\n=== Items with full_name (first 20): ===');
  let count = 0;
  for (const item of result.items) {
    if (item.full_name && count < 20) {
      const pos = item.position_number || '';
      console.log(`pos=${pos.padEnd(3)} | q=${String(item.quantity ?? '-').padEnd(5)} | name=${item.name.substring(0,30).padEnd(30)} | full=${item.full_name.substring(0,90)}`);
      count++;
    }
  }

  // Show parent items (have full_name from continuation merging)
  console.log('\n=== Parents with merged continuations: ===');
  count = 0;
  for (const item of result.items) {
    if (item.position_number && item.full_name && count < 15) {
      console.log(`pos=${item.position_number.padEnd(3)} | name=${item.name.substring(0,40).padEnd(40)} | full=${item.full_name.substring(0,100)}`);
      count++;
    }
  }

  // Count items by type
  let withPos = 0, withFullName = 0, withQty = 0;
  for (const item of result.items) {
    if (item.position_number) withPos++;
    if (item.full_name) withFullName++;
    if (item.quantity != null) withQty++;
  }
  console.log(`\nStats: ${result.items.length} total, ${withPos} with position, ${withFullName} with full_name, ${withQty} with quantity`);
}
main().catch(console.error);
