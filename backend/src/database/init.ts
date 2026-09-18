import { getDatabase, closeDatabase } from './connection';
import { CREATE_TABLES_SQL, CREATE_INDEXES_SQL } from './schema';
import { CONSTRUCTION_SYNONYMS_SEED } from './constructionSynonymsSeed';

function initializeDatabase(): void {
  console.log('Initializing database...');

  const db = getDatabase();

  try {
    db.exec(CREATE_TABLES_SQL);
    console.log('Database tables created successfully!');

    // Migrations (idempotent — ALTER wrapped in try-catch)
    const migrations = [
      'ALTER TABLE suppliers ADD COLUMN vat_rate INTEGER DEFAULT 20',
      'ALTER TABLE suppliers ADD COLUMN prices_include_vat INTEGER DEFAULT 1',
      'ALTER TABLE specification_items ADD COLUMN specification_id INTEGER REFERENCES specifications(id) ON DELETE CASCADE',
      'ALTER TABLE matching_rules ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)',
      'ALTER TABLE invoices ADD COLUMN parsing_category TEXT',
      'ALTER TABLE invoices ADD COLUMN parsing_category_reason TEXT',
      'ALTER TABLE invoice_items ADD COLUMN is_manual INTEGER DEFAULT 0',
      'ALTER TABLE invoice_items ADD COLUMN is_delivery INTEGER DEFAULT 0',
      'ALTER TABLE invoice_items ADD COLUMN quantity_packages REAL DEFAULT NULL',
      'ALTER TABLE invoices ADD COLUMN discount_detected REAL DEFAULT NULL',
      'ALTER TABLE invoices ADD COLUMN discount_applied INTEGER DEFAULT 0',
      'ALTER TABLE matched_items ADD COLUMN source TEXT DEFAULT \'invoice\'',
      'ALTER TABLE invoice_items ADD COLUMN needs_unit_review INTEGER DEFAULT 0',
      'ALTER TABLE invoice_items ADD COLUMN original_price REAL DEFAULT NULL',
      'ALTER TABLE invoice_items ADD COLUMN original_unit TEXT DEFAULT NULL',
      'ALTER TABLE matched_items ADD COLUMN is_analog INTEGER DEFAULT 0',
      'ALTER TABLE specification_items ADD COLUMN parent_item_id INTEGER REFERENCES specification_items(id)',
      'ALTER TABLE specification_items ADD COLUMN full_name TEXT',
      'ALTER TABLE invoices ADD COLUMN vat_amount REAL DEFAULT NULL',
      'ALTER TABLE invoices ADD COLUMN needs_amount_review INTEGER DEFAULT 0',
      'ALTER TABLE specification_items ADD COLUMN article TEXT',
      'ALTER TABLE specification_items ADD COLUMN product_code TEXT',
      'ALTER TABLE specification_items ADD COLUMN marking TEXT',
      'ALTER TABLE specification_items ADD COLUMN type_size TEXT',
      'ALTER TABLE invoices ADD COLUMN vat_rate INTEGER DEFAULT 22',
      'ALTER TABLE specifications ADD COLUMN raw_data TEXT',
      'UPDATE suppliers SET vat_rate = 22 WHERE vat_rate = 20',
      `CREATE TABLE IF NOT EXISTS specification_items_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        specification_id INTEGER NOT NULL REFERENCES specifications(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        items_snapshot TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      'ALTER TABLE matching_rules ADD COLUMN is_negative INTEGER DEFAULT 0',
      "ALTER TABLE matching_rules ADD COLUMN source TEXT DEFAULT 'manual'",
      `CREATE TABLE IF NOT EXISTS operator_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        supplier_id INTEGER REFERENCES suppliers(id),
        spec_item_id INTEGER REFERENCES specification_items(id) ON DELETE SET NULL,
        invoice_item_id INTEGER,
        price_list_item_id INTEGER,
        source TEXT DEFAULT 'invoice',
        comment TEXT,
        status TEXT DEFAULT 'new',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      'ALTER TABLE operator_feedback ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)',
      'ALTER TABLE operator_feedback ADD COLUMN price_list_item_id INTEGER',
      "ALTER TABLE operator_feedback ADD COLUMN source TEXT DEFAULT 'invoice'",
      `CREATE TABLE IF NOT EXISTS gigachat_match_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spec_text TEXT NOT NULL,
        invoice_text TEXT NOT NULL,
        is_match INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(spec_text, invoice_text)
      )`,
      "ALTER TABLE operator_feedback ADD COLUMN status TEXT DEFAULT 'new'",
      "ALTER TABLE specifications ADD COLUMN parse_source TEXT DEFAULT 'excel'",
      `CREATE TABLE IF NOT EXISTS gigachat_file_cache (
        file_hash TEXT NOT NULL,
        purpose TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (file_hash, purpose)
      )`,
      'ALTER TABLE gigachat_file_cache ADD COLUMN expires_at INTEGER',
      `CREATE TABLE IF NOT EXISTS construction_synonyms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        abbreviation TEXT NOT NULL,
        full_form TEXT NOT NULL,
        category TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'seed',
        times_used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      'ALTER TABLE matched_items ADD COLUMN matching_rule_id INTEGER',
      'ALTER TABLE matched_items ADD COLUMN match_reason TEXT',
      // Цены, найденные снаружи (поиск по интернету, прайсы поставщиков). Раньше таблицу
      // заводил только python-скрипт харвестера, и на проде её не было вовсе — а экспорт
      // спецификации теперь из неё читает. Без этой миграции выгрузка падала бы с
      // «no such table» по ВСЕМ проектам. DDL держать одинаковым с price-harvester/src/db.py.
      `CREATE TABLE IF NOT EXISTS external_prices (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        business_key   TEXT NOT NULL UNIQUE,
        project_id     INTEGER,
        spec_item_id   INTEGER,
        query_name     TEXT,
        source         TEXT NOT NULL,
        source_url     TEXT NOT NULL,
        snapshot_date  TEXT NOT NULL,
        supplier_name  TEXT,
        manufacturer   TEXT,
        article        TEXT,
        name           TEXT NOT NULL,
        unit           TEXT,
        price          REAL,
        currency       TEXT DEFAULT 'RUB',
        vat_included   INTEGER,
        vat_rate       INTEGER,
        min_batch      REAL,
        lead_time_days INTEGER,
        in_stock       INTEGER,
        match_score    REAL,
        status         TEXT NOT NULL DEFAULT 'found',
        raw_data       TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_external_prices_spec    ON external_prices(spec_item_id)',
      'CREATE INDEX IF NOT EXISTS idx_external_prices_project ON external_prices(project_id)',
      'CREATE INDEX IF NOT EXISTS idx_external_prices_source  ON external_prices(source)',
      // Очередь заданий кнопки «Найти цены». Поиск идёт НЕ на проде: ключ Yandex Search и
      // «домашний» IP живут на рабочей машине. Кнопка только кладёт сюда строку, воркер с
      // рабочей машины забирает её через /api/price-search/jobs/next и возвращает цены.
      // Таблица — единственное место, где браузер и воркер встречаются.
      `CREATE TABLE IF NOT EXISTS price_search_jobs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id   INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'queued',
        requested_at TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT,
        rows_written INTEGER,
        message      TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_price_search_jobs_status ON price_search_jobs(status)',
      // Подпись шапки файла, для которого разметку колонок задали руками. По её полному
      // совпадению разметка переиспользуется при загрузке следующего такого же бланка
      // (иначе человек размечает каждый раз заново и теряет артикулы).
      // Значение у уже сохранённых конфигов (на проде их 1) досчитывается лениво, при первом
      // обращении — см. findParserConfigByHeader в routes/specifications.ts.
      'ALTER TABLE specification_parser_configs ADD COLUMN header_signature TEXT',
      // Ф10 — поставщики Арты (глобальный справочник, не по проекту): откуда берётся цена,
      // галочка «искать» и скидка договора, которые снабженец Иван правит руками. Воркер
      // поиска цен получает список через sites в /api/price-search/jobs/next.
      `CREATE TABLE IF NOT EXISTS supplier_sites (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL UNIQUE,
        domain         TEXT,
        price_source   TEXT NOT NULL,
        source_key     TEXT,
        search_enabled INTEGER NOT NULL DEFAULT 1,
        discount_pct   REAL NOT NULL DEFAULT 0,
        note           TEXT,
        sort_order     INTEGER,
        created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      // Ф11 — галочка Ивана «Искать по всему интернету» на кнопке «Найти цены»: снята — воркер
      // ищет только на сайтах поставщиков с price_source='search' и search_enabled=1, а не по
      // всему интернету. DEFAULT 1 = как сегодня, старые задания не меняют поведение.
      'ALTER TABLE price_search_jobs ADD COLUMN search_internet INTEGER NOT NULL DEFAULT 1',
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch { /* column already exists */ }
    }

    // "Показывать на главных показателях" flag (worker_brief_2026-06-14_dashboard_visibility_flag).
    // DEFAULT 1 => after deploy ALL projects stay visible (nothing disappears
    // suddenly); the owner hides test projects one-by-one via the toggle button.
    // Explicit idempotency guard (PRAGMA table_info) on top of the surrounding
    // try-catch, so a second server start neither fails nor adds a duplicate
    // column — and we don't silently swallow a real error on the live prod DB.
    const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    if (!projectColumns.some(c => c.name === 'show_on_dashboard')) {
      db.exec('ALTER TABLE projects ADD COLUMN show_on_dashboard INTEGER NOT NULL DEFAULT 1');
    }

    const matchedItemColumns = db.prepare('PRAGMA table_info(matched_items)').all() as Array<{ name: string; notnull: number }>;
    const hasPriceListItemId = matchedItemColumns.some(column => column.name === 'price_list_item_id');
    const invoiceItemColumn = matchedItemColumns.find(column => column.name === 'invoice_item_id');

    if (!hasPriceListItemId || invoiceItemColumn?.notnull === 1) {
      const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
      db.pragma('foreign_keys = OFF');
      try {
        db.exec('DROP TABLE IF EXISTS matched_items_migration');
        db.exec(`
          CREATE TABLE matched_items_migration (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            specification_item_id INTEGER NOT NULL,
            invoice_item_id INTEGER,
            price_list_item_id INTEGER,
            confidence REAL,
            match_type TEXT,
            match_reason TEXT,
            is_confirmed INTEGER DEFAULT 0,
            is_selected INTEGER DEFAULT 0,
            source TEXT DEFAULT 'invoice',
            is_analog INTEGER DEFAULT 0,
            matching_rule_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (specification_item_id) REFERENCES specification_items(id) ON DELETE CASCADE,
            FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id) ON DELETE CASCADE,
            FOREIGN KEY (price_list_item_id) REFERENCES price_list_items(id) ON DELETE CASCADE,
            FOREIGN KEY (matching_rule_id) REFERENCES matching_rules(id) ON DELETE SET NULL,
            CHECK (
              (COALESCE(source, 'invoice') = 'invoice' AND invoice_item_id IS NOT NULL AND price_list_item_id IS NULL)
              OR
              (source = 'price_list' AND price_list_item_id IS NOT NULL AND invoice_item_id IS NULL)
            )
          )
        `);
        db.exec(`
          INSERT INTO matched_items_migration (
            id, specification_item_id, invoice_item_id, price_list_item_id, confidence,
            match_type, match_reason, is_confirmed, is_selected, source, is_analog,
            matching_rule_id, created_at
          )
          SELECT
            id,
            specification_item_id,
            CASE WHEN COALESCE(source, 'invoice') = 'price_list' THEN NULL ELSE invoice_item_id END,
            CASE WHEN COALESCE(source, 'invoice') = 'price_list' THEN invoice_item_id ELSE NULL END,
            confidence,
            match_type,
            match_reason,
            COALESCE(is_confirmed, 0),
            COALESCE(is_selected, 0),
            CASE WHEN COALESCE(source, 'invoice') = 'price_list' THEN 'price_list' ELSE 'invoice' END,
            COALESCE(is_analog, 0),
            matching_rule_id,
            created_at
          FROM matched_items
          WHERE (
            COALESCE(source, 'invoice') = 'price_list'
            AND EXISTS (SELECT 1 FROM price_list_items WHERE price_list_items.id = matched_items.invoice_item_id)
          ) OR (
            COALESCE(source, 'invoice') <> 'price_list'
            AND EXISTS (SELECT 1 FROM invoice_items WHERE invoice_items.id = matched_items.invoice_item_id)
          )
        `);
        db.exec('DROP TABLE matched_items');
        db.exec('ALTER TABLE matched_items_migration RENAME TO matched_items');
      } finally {
        if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
      }
    }

    // Phase 8.2: merge duplicate matching_rules before adding UNIQUE constraint.
    // Keep the most recent operator intent (updated_at/id), but preserve usage
    // volume by summing times_used into the surviving row.
    db.exec(`
      WITH ranked AS (
        SELECT
          id,
          FIRST_VALUE(id) OVER (
            PARTITION BY specification_pattern, invoice_pattern, COALESCE(supplier_id, -1)
            ORDER BY datetime(COALESCE(updated_at, created_at, '1970-01-01 00:00:00')) DESC, id DESC
          ) AS keep_id
        FROM matching_rules
      ),
      duplicate_rules AS (
        SELECT id, keep_id FROM ranked WHERE id <> keep_id
      )
      UPDATE matched_items
      SET matching_rule_id = (
        SELECT keep_id
        FROM duplicate_rules
        WHERE duplicate_rules.id = matched_items.matching_rule_id
      )
      WHERE matching_rule_id IN (SELECT id FROM duplicate_rules)
    `);
    db.exec(`
      WITH ranked AS (
        SELECT
          id,
          COALESCE(times_used, 0) AS times_used,
          FIRST_VALUE(id) OVER (
            PARTITION BY specification_pattern, invoice_pattern, COALESCE(supplier_id, -1)
            ORDER BY datetime(COALESCE(updated_at, created_at, '1970-01-01 00:00:00')) DESC, id DESC
          ) AS keep_id
        FROM matching_rules
      ),
      merged AS (
        SELECT keep_id, SUM(times_used) AS total_times_used
        FROM ranked
        GROUP BY keep_id
        HAVING COUNT(*) > 1
      )
      UPDATE matching_rules
      SET
        times_used = (SELECT total_times_used FROM merged WHERE merged.keep_id = matching_rules.id),
        updated_at = CURRENT_TIMESTAMP
      WHERE id IN (SELECT keep_id FROM merged)
    `);
    db.exec(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY specification_pattern, invoice_pattern, COALESCE(supplier_id, -1)
            ORDER BY datetime(COALESCE(updated_at, created_at, '1970-01-01 00:00:00')) DESC, id DESC
          ) AS rn
        FROM matching_rules
      )
      DELETE FROM matching_rules
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_matching_rules_unique
      ON matching_rules(specification_pattern, invoice_pattern, COALESCE(supplier_id, -1))
    `);

    // Create indexes after migrations (some indexes depend on migrated columns)
    db.exec(CREATE_INDEXES_SQL);
    console.log('Indexes created successfully!');

    // Seed size synonyms
    const synonymCount = (db.prepare('SELECT COUNT(*) as c FROM size_synonyms').get() as any).c;
    if (synonymCount === 0) {
      const ins = db.prepare('INSERT OR IGNORE INTO size_synonyms (canonical, synonym) VALUES (?, ?)');
      [['DN15','ДУ15'],['DN15','Ду15'],['DN15','ду15'],['DN20','ДУ20'],['DN20','Ду20'],
       ['DN25','ДУ25'],['DN25','Ду25'],['DN32','ДУ32'],['DN32','Ду32'],
       ['DN40','ДУ40'],['DN40','Ду40'],['DN50','ДУ50'],['DN50','Ду50'],
       ['DN65','ДУ65'],['DN65','Ду65'],['DN80','ДУ80'],['DN80','Ду80'],
       ['DN100','ДУ100'],['DN100','Ду100']
      ].forEach(([c,s]) => ins.run(c, s));
    }

    const constructionCount = (db.prepare('SELECT COUNT(*) as c FROM construction_synonyms').get() as { c: number }).c;
    if (constructionCount === 0) {
      const cins = db.prepare(
        'INSERT OR IGNORE INTO construction_synonyms (abbreviation, full_form, category, source) VALUES (?, ?, ?, ?)'
      );
      for (const [abbr, full, cat] of CONSTRUCTION_SYNONYMS_SEED) {
        cins.run(abbr, full, cat, 'seed');
      }
    }

    // Ф10 — 8 стартовых поставщиков Арты. INSERT OR IGNORE по name (UNIQUE): повторный старт
    // не плодит строк и не затирает правку Ивана (search_enabled/discount_pct) — только
    // добавляет отсутствующие имена.
    const sins = db.prepare(
      `INSERT OR IGNORE INTO supplier_sites
        (name, domain, price_source, source_key, discount_pct, note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    ([
      ['Русклимат', 'rusklimat.com', 'api', 'rusklimat_api', 0, 'Цена партнёра Арты из API', 1],
      ['Сантехкомплект', 'santech.ru', 'open_price', 'santech_price', 0, 'Открытый прайс, базовая цена предоплаты', 2],
      // Терем: модуль прайса готов (terem_price.py), но в поиск не включён (решение CEO 18.09: цена прайса
      // выше сайта на 10–17%, совпадений с позициями 0) — без source_key, чтобы экран не обещал поиск.
      ['Терем', 'teremopt.ru', 'open_price', null, 0, 'Открытый прайс есть, в поиск не включён: цена прайса выше сайта на 10–17%', 3],
      // Неватом: модуль готов (nevatom.py), в поиск не включён (решение CEO 18.09: марок Неватома в проектах 0);
      // скидка 38% сохранена для будущего подключения.
      ['Неватом', 'nevatom.ru', 'site_discount', null, 38, 'Цена сайта минус скидка договора 38% (счёт № 86999 от 05.08.2026); в поиск не включён — марок Неватома в проектах нет', 4],
      ['ЭТМ', 'etm.ru', 'search', null, 0, 'Через общий поиск в интернете', 5],
      ['Проконсим', 'proconsim.ru', 'search', null, 0, 'Через общий поиск в интернете', 6],
      ['Лунда', 'lunda.ru', 'price_file', null, 0, 'Прайс файлом от менеджера', 7],
      ['ELF Group', 'samara.elfgroup.ru', 'price_file', null, 0, 'Ждём выгрузку YML от менеджера', 8],
    ] as Array<[string, string, string, string | null, number, string, number]>).forEach(row => sins.run(...row));

    // Verify tables
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table'
      ORDER BY name
    `).all();

    console.log('Created tables:');
    tables.forEach((t: any) => console.log(`  - ${t.name}`));

  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    closeDatabase();
  }
}

// Run if called directly
if (require.main === module) {
  initializeDatabase();
}

export { initializeDatabase };
