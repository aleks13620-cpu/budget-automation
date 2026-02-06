import { getDatabase, closeDatabase } from './connection';
import { CREATE_TABLES_SQL } from './schema';

function initializeDatabase(): void {
  console.log('Initializing database...');

  const db = getDatabase();

  try {
    db.exec(CREATE_TABLES_SQL);
    console.log('Database tables created successfully!');

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
