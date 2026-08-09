import dotenv from 'dotenv';
dotenv.config();

import { parseSpecFromPdf } from './src/services/gigachatSpecFromPdf';

async function main() {
  const filePath = 'C:/Users/home/Downloads/Документы/PDF/5-ПР_21 – ОВ (1)-45-75.pdf';
  console.log('Parsing spec PDF:', filePath);
  const result = await parseSpecFromPdf(filePath);
  console.log('Items:', result.items.length);
  console.log('Errors:', result.errors);
  console.log('Category:', result.category ?? 'n/a');
  if (result.items.length > 0) {
    console.log('\nFirst 5 items:');
    result.items.slice(0, 5).forEach((item, i) => {
      console.log(`${i + 1}. ${item.name.substring(0, 60)} | qty: ${item.quantity} | unit: ${item.unit}`);
    });
  }
}

main().catch(console.error);
