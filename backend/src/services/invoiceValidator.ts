import { InvoiceRow, InvoiceMetadata } from '../types/invoice';
import { ValidationResult, ValidationError, ValidationWarning } from '../types/validation';

// ---------------------------------------------------------------------------
// Проверка ИНН по контрольной сумме (ГОСТ Р 51141)
// ---------------------------------------------------------------------------

const INN_COEFFICIENTS_10  = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_COEFFICIENTS_12A = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_COEFFICIENTS_12B = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function checksum(digits: number[], coefficients: number[]): number {
  return coefficients.reduce((sum, coef, i) => sum + coef * digits[i], 0) % 11 % 10;
}

export function isValidINN(inn: string): boolean {
  if (!/^\d{10}$/.test(inn) && !/^\d{12}$/.test(inn)) return false;
  const d = inn.split('').map(Number);

  if (inn.length === 10) {
    return d[9] === checksum(d, INN_COEFFICIENTS_10);
  }

  // 12-значный ИНН (физлицо): две контрольных цифры
  return d[10] === checksum(d, INN_COEFFICIENTS_12A) &&
         d[11] === checksum(d, INN_COEFFICIENTS_12B);
}

// ---------------------------------------------------------------------------
// Основная функция валидации
// ---------------------------------------------------------------------------

/**
 * Валидировать распарсенные позиции счёта против извлечённых метаданных.
 *
 * Errors (блокирующие):
 *   SUM_MISMATCH    — сумма позиций не совпадает с итого документа
 *   MISSING_REQUIRED — обязательные поля отсутствуют (зарезервировано)
 *   INVALID_DATA     — критически некорректные данные (зарезервировано)
 *
 * Warnings (некритичные):
 *   INVALID_INN      — ИНН не проходит контрольную сумму
 *   MISSING_PRICE    — позиция без цены
 *   ZERO_QUANTITY    — позиция с нулевым количеством
 *   SUSPICIOUS_TOTAL — price × quantity ≠ сумма позиции
 */
export function validateInvoice(
  items: InvoiceRow[],
  metadata: InvoiceMetadata
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // --- Проверка 1: сумма позиций ≈ итого (допуск 1 руб на округление) ---
  if (metadata.totalWithVat !== null && metadata.totalWithVat > 0) {
    const itemsSum = items.reduce((sum, item) => sum + (item.amount ?? 0), 0);
    if (Math.abs(itemsSum - metadata.totalWithVat) > 1) {
      errors.push({
        type: 'SUM_MISMATCH',
        message: `Сумма позиций (${itemsSum.toFixed(2)}) не совпадает с итого (${metadata.totalWithVat.toFixed(2)})`,
        details: { expected: metadata.totalWithVat, actual: itemsSum, diff: itemsSum - metadata.totalWithVat },
      });
    }
  }

  // --- Проверка 2: ИНН поставщика ---
  if (metadata.supplierINN && !isValidINN(metadata.supplierINN)) {
    warnings.push({
      type: 'INVALID_INN',
      message: `Некорректный ИНН поставщика: ${metadata.supplierINN}`,
      details: { inn: metadata.supplierINN, party: 'supplier' },
    });
  }

  // --- Проверка 3: ИНН покупателя ---
  if (metadata.buyerINN && !isValidINN(metadata.buyerINN)) {
    warnings.push({
      type: 'INVALID_INN',
      message: `Некорректный ИНН покупателя: ${metadata.buyerINN}`,
      details: { inn: metadata.buyerINN, party: 'buyer' },
    });
  }

  // --- Проверка 4: цена > 0 для каждой позиции ---
  items.forEach((item, index) => {
    if (item.price === null || item.price <= 0) {
      warnings.push({
        type: 'MISSING_PRICE',
        message: `Позиция ${index + 1} без цены: «${item.name}»`,
        details: { position: index + 1, name: item.name, price: item.price },
      });
    }
  });

  // --- Проверка 5: количество > 0 ---
  items.forEach((item, index) => {
    if (item.quantity === null || item.quantity <= 0) {
      warnings.push({
        type: 'ZERO_QUANTITY',
        message: `Позиция ${index + 1} с нулевым количеством: «${item.name}»`,
        details: { position: index + 1, name: item.name, quantity: item.quantity },
      });
    }
  });

  // --- Проверка 6: price × quantity ≈ amount (допуск 1 руб) ---
  items.forEach((item, index) => {
    if (item.price !== null && item.quantity !== null && item.amount !== null) {
      const expected = item.price * item.quantity;
      if (Math.abs(expected - item.amount) > 1) {
        warnings.push({
          type: 'SUSPICIOUS_TOTAL',
          message: `Позиция ${index + 1}: цена × кол-во (${expected.toFixed(2)}) ≠ сумма (${item.amount.toFixed(2)})`,
          details: { position: index + 1, price: item.price, quantity: item.quantity, expected, actual: item.amount },
        });
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
