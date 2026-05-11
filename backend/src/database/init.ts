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
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch { /* column already exists */ }
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
