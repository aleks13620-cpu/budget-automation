// Типы для валидации счетов

export interface ValidationError {
  type: 'SUM_MISMATCH' | 'MISSING_REQUIRED' | 'INVALID_DATA';
  message: string;
  details: unknown;
}

export interface ValidationWarning {
  type: 'INVALID_INN' | 'MISSING_PRICE' | 'ZERO_QUANTITY' | 'SUSPICIOUS_TOTAL';
  message: string;
  details: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}
