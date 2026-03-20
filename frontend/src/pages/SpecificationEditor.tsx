import { useState, useEffect } from 'react';
import { api } from '../api';
import { SpecColumnMapper } from '../components/SpecColumnMapper';
import type { SpecColumnMapping } from '../components/SpecColumnMapper';

const DEFAULT_MAPPING: SpecColumnMapping = {
  position_number: null, name: null, characteristics: null, equipment_code: null,
  article: null, product_code: null, marking: null, type_size: null,
  manufacturer: null, unit: null, quantity: null, price: null, amount: null,
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
        // Есть сохранённый конфиг — применяем его
        setHeaderRow(data.config.header_row);
        try {
          const cm = JSON.parse(data.config.column_mapping);
          setMapping({ ...DEFAULT_MAPPING, ...cm });
        } catch {}
        setMergeMultiline(data.config.merge_multiline !== 0);
      } else if (data.detectedMapping) {
        // Нет конфига — применяем авто-детект
        setHeaderRow(data.detectedMapping.headerRow);
        setMapping({ ...DEFAULT_MAPPING, ...data.detectedMapping.columnMapping });
      }
    }).catch(() => {
      // raw_data нет — спецификация загружена до v2.0
    }).finally(() => setLoading(false));
  }, [specId]);

  const handleReparse = async () => {
    if (!confirm('Пересобрать позиции спецификации? Текущие позиции будут заменены новыми.')) return;
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

  // Заголовки колонок из строки headerRow
  const columnHeaders: string[] = rows.length > 0 && rows[headerRow]
    ? rows[headerRow].map(c => String(c ?? '').trim())
    : [];

  const displayRows = rows.slice(0, 40);

  // Подсвечиваемые колонки (те что выбраны в маппере)
  const mappedCols = new Set(
    Object.values(mapping).filter((v): v is number => v !== null)
  );

  if (loading) return <div className="section"><p className="muted">Загрузка...</p></div>;

  return (
    <div className="section">
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>&larr; Назад</button>
        <h2 style={{ margin: 0 }}>Редактор спецификации #{specId}</h2>
      </div>

      {message && (
        <div style={{
          marginBottom: '1rem',
          padding: '0.75rem 1rem',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          background: message.type === 'success' ? '#d1fae5' : '#fee2e2',
          border: `1px solid ${message.type === 'success' ? '#6ee7b7' : '#fca5a5'}`,
          color: message.type === 'success' ? '#065f46' : '#991b1b',
          fontWeight: 500,
        }}>
          <span style={{ fontSize: '1.1rem' }}>{message.type === 'success' ? '✓' : '✕'}</span>
          {message.text}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '1rem' }}>
          <strong>Редактор недоступен</strong>
          <p style={{ margin: '0.5rem 0 0' }}>
            Эта спецификация была загружена до версии 2.0 — исходный файл Excel не сохранён в базе.
          </p>
          <p style={{ margin: '0.5rem 0 0', color: '#666' }}>
            <strong>Решение:</strong> удалите спецификацию в разделе проекта и загрузите Excel-файл повторно.
          </p>
        </div>
      ) : (
        <>
          {/* Строка заголовка */}
          <div style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
              Строка заголовка:
              <input
                type="number"
                min={0}
                max={rows.length - 1}
                value={headerRow}
                onChange={e => setHeaderRow(Math.max(0, parseInt(e.target.value, 10) || 0))}
                style={{ width: '70px', padding: '3px 6px' }}
              />
            </label>
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              Выделена синим в таблице. Колонки нумеруются с 1.
            </span>
          </div>

          {/* Маппинг колонок — над таблицей */}
          <div style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '0.75rem', marginBottom: '0.75rem', background: '#f8f9fa' }}>
            <h4 style={{ margin: '0 0 0.5rem' }}>Маппинг колонок</h4>
            <SpecColumnMapper
              mapping={mapping}
              onChange={setMapping}
              mergeMultiline={mergeMultiline}
              onMergeMultilineChange={setMergeMultiline}
              columnHeaders={columnHeaders}
            />
          </div>

          {/* Кнопки действий */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <button className="btn btn-primary" onClick={handleReparse} disabled={reparsing}>
              {reparsing ? 'Пересборка...' : 'Пересобрать позиции'}
            </button>
            <button className="btn btn-secondary" onClick={handleSaveConfig}>
              Сохранить конфиг
            </button>
          </div>

          {/* Таблица сырых данных */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: '0.75rem', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '100%' }}>
              <thead>
                <tr style={{ background: '#343a40', color: '#fff' }}>
                  <th style={{ padding: '3px 6px', width: '35px', textAlign: 'center' }}>№</th>
                  {(rows[0] || []).map((_, ci) => (
                    <th key={ci} style={{
                      padding: '3px 8px',
                      minWidth: '80px',
                      maxWidth: '180px',
                      background: mappedCols.has(ci) ? '#0d6efd' : '#343a40',
                      textAlign: 'center',
                    }}>
                      {ci + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, ri) => (
                  <tr key={ri} style={{
                    background: ri === headerRow ? '#cfe2ff' : ri % 2 === 0 ? '#fff' : '#f8f9fa',
                    fontWeight: ri === headerRow ? 600 : 'normal',
                  }}>
                    <td style={{ padding: '2px 4px', color: '#999', textAlign: 'center', borderRight: '1px solid #dee2e6' }}>{ri}</td>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{
                        padding: '2px 6px',
                        border: '1px solid #e0e0e0',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: '180px',
                        background: mappedCols.has(ci) ? '#e8f0fe' : undefined,
                      }}>
                        {String(cell ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 40 && (
              <p className="muted" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
                Показаны первые 40 строк из {rows.length}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
