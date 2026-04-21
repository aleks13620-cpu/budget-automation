import fs from 'fs';
import multer from 'multer';
import path from 'path';

const DEFAULT_UPLOAD_PATH = path.resolve(__dirname, '../../..', process.env.UPLOAD_PATH || '../data/uploads');

export function parseJsonSafe<T>(raw: string, fallback: T, context?: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error('json_parse_failed', {
      timestamp: new Date().toISOString(),
      context: context ?? null,
      error: error instanceof Error ? error.message : String(error),
      raw: raw.slice(0, 200),
    });
    return fallback;
  }
}

export function fixFilename(originalname: string): string {
  try {
    const fixed = Buffer.from(originalname, 'latin1').toString('utf8');
    return fixed.includes('\ufffd') ? originalname : fixed;
  } catch {
    return originalname;
  }
}

export function createUploadMiddleware(options: {
  allowedExtensions: string[];
  errorMessage: string;
  maxFileSizeBytes?: number;
  uploadPath?: string;
}): multer.Multer {
  const uploadPath = options.uploadPath ?? DEFAULT_UPLOAD_PATH;
  const allowedExtensions = options.allowedExtensions.map((ext) => ext.toLowerCase());
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 50 * 1024 * 1024;

  if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, uploadPath);
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    },
  });

  return multer({
    storage,
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowedExtensions.includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error(options.errorMessage));
      }
    },
    limits: { fileSize: maxFileSizeBytes },
  });
}
