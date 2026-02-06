export interface InvoiceRow {
  article: string | null;
  name: string;
  unit: string | null;
  quantity: number | null;
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
}
