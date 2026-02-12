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
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch { /* column already exists */ }
    }

    // Create indexes after migrations (some indexes depend on migrated columns)
    db.exec(CREATE_INDEXES_SQL);
    console.log('Indexes created successfully!');

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
