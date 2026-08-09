import FormData from 'form-data';
import fs from 'fs';
import http from 'http';

const BASE = 'http://localhost:3001/api';

function request(method: string, url: string, body?: any, headers?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts: http.RequestOptions = {
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method,
      headers: headers || {},
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function uploadFile(url: string, filePath: string, fields?: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    if (fields) for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const u = new URL(url);
    form.submit({ hostname: u.hostname, port: Number(u.port), path: u.pathname, method: 'POST' }, (err, res) => {
      if (err) return reject(err);
      let data = '';
      res!.on('data', (chunk) => data += chunk);
      res!.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
  });
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const proj = await request('POST', `${BASE}/projects`, '{"name":"Match Test OV"}', { 'Content-Type': 'application/json' });
  const pid = proj.id;
  console.log('Project:', pid);

  // Upload spec
  console.log('\n--- Uploading spec ---');
  const t0 = Date.now();
  const spec = await uploadFile(`${BASE}/projects/${pid}/specifications`, 'C:/Users/home/Downloads/Документы/PDF/5-ПР_21 – ОВ (1)-45-75.pdf', { section: 'Вентиляция' });
  console.log(`Spec: ${spec.imported ?? 0} items in ${Math.round((Date.now()-t0)/1000)}s, error: ${spec.error ?? 'none'}, category: ${spec.category ?? 'n/a'}`);

  if ((spec.imported ?? 0) === 0) {
    console.log('Spec parsing failed! Check server logs.');
    // Check server log
    const log = fs.readFileSync('/tmp/server2.log', 'utf8');
    const lines = log.split('\n').filter(l => l.includes('parseSpec') || l.includes('pdfplumber') || l.includes('python') || l.includes('GigaChat') || l.includes('Error'));
    console.log('Server log (relevant lines):');
    lines.forEach(l => console.log('  ', l));
    return;
  }

  // Upload invoices
  console.log('\n--- Uploading invoices ---');
  const inv1 = await uploadFile(`${BASE}/projects/${pid}/invoices`, 'C:/Users/home/Downloads/NED КП №ND23-155002-6 от 02 апр. 2026 (2).xlsx');
  console.log('NED:', inv1.imported ?? inv1.error);

  const inv2 = await uploadFile(`${BASE}/projects/${pid}/invoices`, 'C:/Users/home/Downloads/Таблицы/Вентиляция +отопление/Радиаторы Итеса Счет на оплату № 2768 от 15.04.2026 (1).pdf');
  console.log('Itesa:', inv2.imported ?? inv2.error);

  console.log('\nBefore matching:');
  const pre = await request('GET', `${BASE}/projects/${pid}/matching/stats`);
  console.log(JSON.stringify(pre));

  // Run matching
  console.log('\n--- Running matching ---');
  const startMatch = Date.now();
  await request('POST', `${BASE}/projects/${pid}/matching/run?mode=full`);

  for (let i = 0; i < 90; i++) {
    await sleep(3000);
    const status = await request('GET', `${BASE}/projects/${pid}/matching/status`);
    if (status.status === 'done' || status.status === 'idle') {
      console.log(`\nMatching done in ${Math.round((Date.now()-startMatch)/1000)}s:`);
      console.log(JSON.stringify(status, null, 2));
      break;
    }
    if (status.status === 'error') {
      console.log('Error:', JSON.stringify(status));
      break;
    }
    process.stdout.write('.');
  }

  const stats = await request('GET', `${BASE}/projects/${pid}/matching/stats`);
  console.log('\n=== FINAL ===');
  console.log(JSON.stringify(stats, null, 2));
  const pct = stats.total > 0 ? Math.round(stats.matched / stats.total * 100) : 0;
  console.log(`\n${stats.matched}/${stats.total} = ${pct}% (target ≥70%)`);
}

main().catch(console.error);
