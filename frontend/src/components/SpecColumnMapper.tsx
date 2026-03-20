export interface SpecColumnMapping {
  position_number: number | null;
  name: number | null;
  characteristics: number | null;
  equipment_code: number | null;
  article: number | null;
  product_code: number | null;
  marking: number | null;
  type_size: number | null;
  manufacturer: number | null;
  unit: number | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
}

interface Props {
  mapping: SpecColumnMapping;
  onChange: (mapping: SpecColumnMapping) => void;
  mergeMultiline: boolean;
  onMergeMultilineChange: (val: boolean) => void;
  columnHeaders: string[]; // заголовки из строки header row
}

const FIELD_LABELS: Record<keyof SpecColumnMapping, string> = {
  position_number: '№ позиции',
  name: 'Наименование *',
  characteristics: 'Характеристики',
  equipment_code: 'Код оборудования',
  article: 'Артикул',
  product_code: 'Код продукции',
  marking: 'Маркировка',
  type_size: 'Типоразмер',
  manufacturer: 'Производитель',
  unit: 'Ед. изм.',
  quantity: 'Количество',
  price: 'Цена за единицу',
  amount: 'Общая стоимость',
};

export function SpecColumnMapper({ mapping, onChange, mergeMultiline, onMergeMultilineChange, columnHeaders }: Props) {
  const handleChange = (field: keyof SpecColumnMapping, value: string) => {
    onChange({ ...mapping, [field]: value === '' ? null : parseInt(value, 10) });
  };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.5rem', marginBottom: '0.5rem' }}>
        {(Object.keys(FIELD_LABELS) as (keyof SpecColumnMapping)[]).map(field => (
          <label key={field} style={{ display: 'flex', flexDirection: 'column', fontSize: '0.85rem' }}>
            <span style={{ marginBottom: '2px' }}>{FIELD_LABELS[field]}</span>
            <select
              value={mapping[field] ?? ''}
              onChange={e => handleChange(field, e.target.value)}
              style={{ fontSize: '0.85rem' }}
            >
              <option value="">—</option>
              {columnHeaders.map((header, i) => (
                <option key={i} value={i}>
                  {i + 1}{header ? `: ${header.slice(0, 30)}` : ''}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
        <input
          type="checkbox"
          checked={mergeMultiline}
          onChange={e => onMergeMultilineChange(e.target.checked)}
        />
        Объединять строки-продолжения (толщиной, сечение, с нанесением...)
      </label>
    </div>
  );
}
