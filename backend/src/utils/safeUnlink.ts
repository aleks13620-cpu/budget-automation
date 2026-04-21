import fs from 'fs';

export function safeUnlink(filePath: string): void {
  fs.unlink(filePath, (error) => {
    if (!error) {
      return;
    }

    console.error('safe_unlink_failed', {
      timestamp: new Date().toISOString(),
      filePath,
      error: error.message,
    });
  });
}
