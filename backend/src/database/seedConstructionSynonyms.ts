/**
 * Заливка словаря construction_synonyms из constructionSynonymsSeed.ts.
 *
 * По умолчанию: удаляет все строки с source='seed' и вставляет актуальный сид
 * (строки source='learned' не трогаются).
 *
 * Запуск (dev, из папки backend):
 *   npm run db:seed-construction-synonyms
 *   npm run db:seed-construction-synonyms -- --append
 *
 * Production (Docker, из каталога с docker-compose.yml):
 *   docker compose exec app node backend/dist/database/seedConstructionSynonyms.js
 *   docker compose exec app node backend/dist/database/seedConstructionSynonyms.js --append
 */

import { getDatabase, closeDatabase } from './connection';
import { CONSTRUCTION_SYNONYMS_SEED } from './constructionSynonymsSeed';
import { invalidateMatcherSynonymCaches } from '../services/matcher';

const append = process.argv.includes('--append');

function main(): void {
  const db = getDatabase();

  try {
    if (append) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO construction_synonyms (abbreviation, full_form, category, source)
         VALUES (?, ?, ?, 'seed')`,
      );
      let inserted = 0;
      for (const [abbr, full, cat] of CONSTRUCTION_SYNONYMS_SEED) {
        const r = stmt.run(abbr, full, cat);
        if (r.changes > 0) inserted += 1;
      }
      const skipped = CONSTRUCTION_SYNONYMS_SEED.length - inserted;
      console.log(
        `[seedConstructionSynonyms] append: вставлено ${inserted}, пропущено (уже есть) ${skipped}`,
      );
    } else {
      const sync = db.transaction(() => {
        const del = db.prepare(`DELETE FROM construction_synonyms WHERE source = 'seed'`).run();
        console.log(`[seedConstructionSynonyms] удалено строк seed: ${del.changes}`);
        const ins = db.prepare(
          `INSERT INTO construction_synonyms (abbreviation, full_form, category, source)
           VALUES (?, ?, ?, 'seed')`,
        );
        for (const [abbr, full, cat] of CONSTRUCTION_SYNONYMS_SEED) {
          ins.run(abbr, full, cat);
        }
      });
      sync();
      console.log(`[seedConstructionSynonyms] вставлено строк: ${CONSTRUCTION_SYNONYMS_SEED.length}`);
    }

    invalidateMatcherSynonymCaches();
    console.log('[seedConstructionSynonyms] готово. Перезапустите backend, если он уже был запущен.');
  } finally {
    closeDatabase();
  }
}

main();
