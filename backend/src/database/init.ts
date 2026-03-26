import { getDatabase, closeDatabase } from './connection';
import { CREATE_TABLES_SQL, CREATE_INDEXES_SQL } from './schema';

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
        spec_item_id INTEGER REFERENCES specification_items(id) ON DELETE SET NULL,
        invoice_item_id INTEGER,
        comment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS gigachat_match_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spec_text TEXT NOT NULL,
        invoice_text TEXT NOT NULL,
        is_match INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(spec_text, invoice_text)
      )`,
      "ALTER TABLE operator_feedback ADD COLUMN status TEXT DEFAULT 'new'",
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch { /* column already exists */ }
    }

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
