export interface ColumnMapping {
  article: number | null;
  name: number | null;
  unit: number | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
}

const FIELD_LABELS: Record<keyof ColumnMapping, string> = {
  article: 'Артикул',
  name: 'Наименование',
  unit: 'Ед. изм.',
  quantity: 'Количество',
  price: 'Цена',
  amount: 'Сумма',
};

interface Props {
  columns: string[];
  mapping: ColumnMapping;
  headerRow: number;
  totalRows: number;
  onChange: (mapping: ColumnMapping) => void;
  onHeaderRowChange: (row: number) => void;
}

export function ColumnMapper({ columns, mapping, headerRow, totalRows, onChange, onHeaderRowChange }: Props) {
  const handleFieldChange = (field: keyof ColumnMapping, value: string) => {
    onChange({
      ...mapping,
      [field]: value === '' ? null : parseInt(value, 10),
    });
  };

  return (
    <div className="column-mapper">
      <div className="mapper-item">
        <label>Строка заголовка</label>
        <select
          value={headerRow}
          onChange={e => onHeaderRowChange(parseInt(e.target.value, 10))}
        >
          {Array.from({ length: Math.min(totalRows, 20) }, (_, i) => (
            <option key={i} value={i}>Строка {i + 1}</option>
          ))}
        </select>
      </div>

      {(Object.keys(FIELD_LABELS) as (keyof ColumnMapping)[]).map(field => (
        <div key={field} className="mapper-item">
          <label>{FIELD_LABELS[field]}</label>
          <select
            value={mapping[field] ?? ''}
            onChange={e => handleFieldChange(field, e.target.value)}
          >
            <option value="">— Пропустить —</option>
            {columns.map((col, idx) => (
              <option key={idx} value={idx}>
                {col || `Колонка ${idx + 1}`}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
