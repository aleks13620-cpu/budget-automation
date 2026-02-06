import Database from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Resolve path relative to backend folder (where package.json is)
const backendRoot = path.resolve(__dirname, '../..');
const dbPath = path.resolve(backendRoot, process.env.DATABASE_PATH || '../database/budget_automation.db');

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
