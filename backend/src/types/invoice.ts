export interface InvoiceRow {
  article: string | null;
  name: string;
  unit: string | null;
  quantity: number | null;
  quantity_packages: number | null;
  price: number | null;
  amount: number | null;
  row_index: number;
}

export interface InvoiceParseResult {
  items: InvoiceRow[];
  errors: string[];
  totalRows: number;
  skippedRows: number;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  supplierName: string | null;
  totalAmount: number | null;
  vatAmount: number | null;
  discountDetected: number | null;
}

// ---------------------------------------------------------------------------
// Расширенные типы для Excel-парсера (этап доработки 09.03.2026)
// ---------------------------------------------------------------------------

/** Метаданные счёта, извлекаемые из шапки документа */
export interface InvoiceMetadata {
  documentNumber: string | null;
  documentDate: string | null;
  supplierName: string | null;
  supplierINN: string | null;
  buyerName: string | null;
  buyerINN: string | null;
  totalWithVat: number | null;
  vatAmount: number | null;
}

/** Оценка уверенности на каждом этапе парсинга (0–100) */
export interface ParsingConfidence {
  headerDetection: number;
  columnMapping: Record<string, number>;
  metadataExtraction: number;
  dataExtraction: number;
  overall: number;
}

/** Результат Excel-парсинга с категорией, уверенностью и валидацией */
export interface ExcelParseResult {
  category: 'A' | 'B' | 'C';
  metadata: InvoiceMetadata;
  items: InvoiceRow[];
  errors: string[];
  totalRows: number;
  skippedRows: number;
  discountDetected: number | null;
  confidence: ParsingConfidence;
  validation: import('./validation').ValidationResult;
  rawData?: string[][];
}
