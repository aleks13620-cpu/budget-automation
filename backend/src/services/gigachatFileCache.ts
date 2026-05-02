import crypto from 'crypto';
import fs from 'fs';
import { getDatabase } from '../database';

export type GigaChatFileCachePurpose = 'invoice_pdf' | 'invoice_excel' | 'spec_pdf';

export function sha256File(filePath: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

export function getGigaChatFileCache(fileHash: string, purpose: GigaChatFileCachePurpose): string | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT response_json FROM gigachat_file_cache WHERE file_hash = ? AND purpose = ? AND (expires_at IS NULL OR expires_at > unixepoch())')
    .get(fileHash, purpose) as { response_json: string } | undefined;
  return row?.response_json ?? null;
}

export function setGigaChatFileCache(fileHash: string, purpose: GigaChatFileCachePurpose, responseJson: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO gigachat_file_cache (file_hash, purpose, response_json, expires_at)
     VALUES (?, ?, ?, unixepoch() + 2592000)
     ON CONFLICT(file_hash, purpose) DO UPDATE SET
       response_json = excluded.response_json,
       expires_at = unixepoch() + 2592000,
       created_at = CURRENT_TIMESTAMP`
  ).run(fileHash, purpose, responseJson);
}

export function pruneExpiredGigaChatCache(): void {
  const db = getDatabase();
  const { changes } = db.prepare('DELETE FROM gigachat_file_cache WHERE expires_at IS NOT NULL AND expires_at < unixepoch()').run();
  if (changes > 0) console.log(`Pruned ${changes} expired GigaChat cache entries`);
}
