export interface SpecificationRow {
  position_number: string | null;
  name: string;
  characteristics: string | null;
  equipment_code: string | null;
  manufacturer: string | null;
  unit: string | null;
  quantity: number | null;
}

export interface ParseResult {
  items: SpecificationRow[];
  errors: string[];
  totalRows: number;
  skippedRows: number;
}
