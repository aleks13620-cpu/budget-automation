import { useState, useEffect } from 'react';
import { api } from '../api';
import { SpecColumnMapper } from '../components/SpecColumnMapper';

interface SpecColumnMapping {
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
}

const DEFAULT_MAPPING: SpecColumnMapping = {
  position_number: null, name: null, characteristics: null, equipment_code: null,
  article: null, product_code: null, marking: null, type_size: null,
  manufacturer: null, unit: null, quantity: null,
};

interface Props {
  specId: number;
  onBack: () => void;
}

export function SpecificationEditor({ specId, onBack }: Props) {
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<SpecColumnMapping>(DEFAULT_MAPPING);
  const [mergeMultiline, setMergeMultiline] = useState(true);
  const [headerRow, setHeaderRow] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reparsing, setReparsing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api.get(`/specifications/${specId}/raw-data`).then(({ data }) => {
      setRows(data.rows || []);
      if (data.config) {
        setHeaderRow(data.config.header_row);
        try {
          const cm = JSON.parse(data.config.column_mapping);
          setMapping({ ...DEFAULT_MAPPING, ...cm });
        } catch {}
        setMergeMultiline(data.config.merge_multiline !== 0);
      }
    }).catch(() => {
      setMessage({ type: 'error', text: 'Не удалось загрузить сырые данные. Возможно, спецификация была загружена до v2.0.' });
    }).finally(() => setLoading(false));
  }, [specId]);

  const handleReparse = async () => {
    setReparsing(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/specifications/${specId}/reparse`, { headerRow, columnMapping: mapping, mergeMultiline });
      setMessage({ type: 'success', text: `Импортировано ${data.imported} позиций. Ошибок: ${data.errors?.length ?? 0}` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка пересборки' });
    } finally {
      setReparsing(false);
    }
  };

  const handleSaveConfig = async () => {
    try {
      await api.post(`/specifications/${specId}/parser-config`, { headerRow, columnMapping: mapping, mergeMultiline });
      setMessage({ type: 'success', text: 'Конфигурация сохранена' });
    } catch {
      setMessage({ type: 'error', text: 'Ошибка сохранения конфига' });
    }
  };

  const displayRows = rows.slice(0, 30);
  const columnCount = rows.length > 0 ? Math.max(...rows.slice(0, 5).map(r => r.length), 0) : 0;

  if (loading) return <div className="section"><p className="muted">Загрузка...</p></div>;

  return (
    <div className="section">
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>&larr; Назад</button>
        <h2 style={{ margin: 0 }}>Редактор спецификации #{specId}</h2>
      </div>

      {message && (
        <div className={`alert alert-${message.type === 'success' ? 'success' : 'danger'}`} style={{ marginBottom: '1rem' }}>
          {message.text}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="muted">Сырые данные не сохранены для этой спецификации (загружена до v2.0)</p>
      ) : (
        <>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <span>Строка заголовка (0-based):</span>
              <input
                type="number"
                min={0}
                max={rows.length - 1}
                value={headerRow}
                onChange={e => setHeaderRow(parseInt(e.target.value, 10) || 0)}
                style={{ width: '80px' }}
              />
            </label>
          </div>

          <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
            <table style={{ fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <tbody>
                {displayRows.map((row, ri) => (
                  <tr key={ri} style={{ background: ri === headerRow ? '#e3f2fd' : ri % 2 === 0 ? '#fff' : '#f8f9fa' }}>
                    <td style={{ padding: '2px 4px', color: '#999', minWidth: '30px', fontWeight: ri === headerRow ? 'bold' : 'normal' }}>{ri}</td>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{ padding: '2px 6px', border: '1px solid #e0e0e0', whiteSpace: 'nowrap', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {String(cell ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 30 && <p className="muted" style={{ marginTop: '0.25rem' }}>Показаны первые 30 строк из {rows.length}</p>}
          </div>

          <h3>Маппинг колонок</h3>
          <SpecColumnMapper
            mapping={mapping}
            onChange={setMapping}
            mergeMultiline={mergeMultiline}
            onMergeMultilineChange={setMergeMultiline}
            columnCount={columnCount}
          />

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={handleReparse} disabled={reparsing}>
              {reparsing ? 'Пересборка...' : 'Пересобрать позиции'}
            </button>
            <button className="btn btn-secondary" onClick={handleSaveConfig}>
              Сохранить конфиг
            </button>
          </div>
        </>
      )}
    </div>
  );
}
