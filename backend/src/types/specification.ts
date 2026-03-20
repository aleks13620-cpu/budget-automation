export interface SpecificationRow {
  position_number: string | null;
  name: string;
  characteristics: string | null;
  equipment_code: string | null;
  article: string | null;
  product_code: string | null;
  marking: string | null;
  type_size: string | null;
  manufacturer: string | null;
  unit: string | null;
  quantity: number | null;
  full_name: string | null;
  /** Index into items array — resolved to DB id during INSERT, not stored in DB directly */
  _parentIndex: number | null;
}

export interface ParseResult {
  items: SpecificationRow[];
  errors: string[];
  totalRows: number;
  skippedRows: number;
}
