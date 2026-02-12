import { useState, useEffect } from 'react';
import { api } from '../api';
import { ColumnMapper } from '../components/ColumnMapper';
import type { ColumnMapping } from '../components/ColumnMapper';

interface PreviewData {
  rows: string[][];
  totalRows: number;
  detectedMapping: (ColumnMapping & { headerRow: number }) | null;
  supplierConfig: (ColumnMapping & { headerRow: number }) | null;
  parsingCategory?: string;
  parsingCategoryReason?: string;
  fullText?: string;
}

interface InvoiceInfo {
  id: number;
  supplier_id: number | null;
  supplier_name: string | null;
  file_name: string;
  parsing_category: string | null;
  parsing_category_reason: string | null;
  status: string;
}

interface Props {
  invoiceId: number;
  onBack: () => void;
}

type SeparatorMethod = 'tab' | 'spaces' | 'custom';

const SEPARATOR_OPTIONS: { value: SeparatorMethod; label: string; description: string }[] = [
  { value: 'tab', label: 'Табуляция', description: 'Разделение по символу табуляции (\\t)' },
  { value: 'spaces', label: 'Пробелы (2+)', description: 'Разделение по двум и более пробелам подряд' },
  { value: 'custom', label: 'Свой разделитель', description: 'Указать произвольный символ или строку' },
];

function CategoryBPanel({ invoice, preview, invoiceId, onBack }: {
  invoice: InvoiceInfo;
  preview: PreviewData;
  invoiceId: number;
  onBack: () => void;
}) {
  const [sepMethod, setSepMethod] = useState<SeparatorMethod>('spaces');
  const [customSep, setCustomSep] = useState(';');
  const [splitRows, setSplitRows] = useState<string[][] | null>(null);
  const [splitMapping, setSplitMapping] = useState<ColumnMapping>({
    article: null, name: null, unit: null, quantity: null, price: null, amount: null,
  });
  const [splitHeaderRow, setSplitHeaderRow] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [reparsing, setReparsing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showRawText, setShowRawText] = useState(true);

  const handlePreviewSplit = async () => {
    setPreviewing(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/invoices/${invoiceId}/preview-split`, {
        separatorMethod: sepMethod,
        separatorValue: sepMethod === 'custom' ? customSep : undefined,
      });
      setSplitRows(data.rows);
      if (data.detectedMapping) {
        setSplitMapping({
          article: data.detectedMapping.article,
          name: data.detectedMapping.name,
          unit: data.detectedMapping.unit,
          quantity: data.detectedMapping.quantity,
          price: data.detectedMapping.price,
          amount: data.detectedMapping.amount,
        });
        setSplitHeaderRow(data.detectedMapping.headerRow);
      }
      setShowRawText(false);
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при предпросмотре разделения' });
    } finally {
      setPreviewing(false);
    }
  };

  const handleReparseWithSep = async () => {
    setReparsing(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/invoices/${invoiceId}/reparse-with-separator`, {
        separatorMethod: sepMethod,
        separatorValue: sepMethod === 'custom' ? customSep : undefined,
        mapping: { ...splitMapping, headerRow: splitHeaderRow },
      });

      if (data.imported === 0) {
        setMessage({ type: 'error', text: 'Позиции не найдены. Попробуйте другой разделитель или настройте колонки.' });
      } else {
        setMessage({ type: 'success', text: `Пересобрано: ${data.imported} позиций` });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при пересборке' });
    } finally {
      setReparsing(false);
    }
  };

  const splitHeaderCols = splitRows ? (splitRows[splitHeaderRow] || []) : [];

  return (
    <div>
      <h1>Настройка: {invoice.file_name}</h1>
      {invoice.supplier_name && <p className="muted">Поставщик: {invoice.supplier_name}</p>}

      <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 4, padding: '1rem', margin: '1rem 0' }}>
        <strong>Требуется настройка разделителей</strong>
        <p style={{ margin: '0.5rem 0 0' }}>
          {preview.parsingCategoryReason || invoice.parsing_category_reason || 'Текст извлечён, но таблица не разделена на колонки.'}
        </p>
      </div>

      {message && (
        <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>
          {message.text}
        </p>
      )}

      {/* Raw text toggle */}
      {preview.fullText && (
        <div style={{ marginBottom: '1rem' }}>
          <h3 style={{ cursor: 'pointer' }} onClick={() => setShowRawText(!showRawText)}>
            {showRawText ? '▼' : '▶'} Извлечённый текст (первые 30 строк)
          </h3>
          {showRawText && (
            <pre style={{ maxHeight: 250, overflow: 'auto', background: '#f8f9fa', padding: '0.75rem', fontSize: '0.8rem', border: '1px solid #dee2e6', borderRadius: 4, whiteSpace: 'pre-wrap' }}>
              {preview.fullText.split('\n').slice(0, 30).join('\n')}
            </pre>
          )}
        </div>
      )}

      {/* Separator method selection */}
      <h3>Метод разделения</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
        {SEPARATOR_OPTIONS.map(opt => (
          <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="radio"
              name="separator"
              value={opt.value}
              checked={sepMethod === opt.value}
              onChange={() => setSepMethod(opt.value)}
            />
            <span><strong>{opt.label}</strong> — {opt.description}</span>
          </label>
        ))}
      </div>

      {sepMethod === 'custom' && (
        <div style={{ marginBottom: '1rem' }}>
          <label>
            Разделитель:{' '}
            <input
              type="text"
              value={customSep}
              onChange={e => setCustomSep(e.target.value)}
              style={{ width: 120, padding: '4px 8px' }}
              placeholder="напр. ; или |"
            />
          </label>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button className="btn btn-primary" onClick={handlePreviewSplit} disabled={previewing}>
          {previewing ? 'Разделение...' : 'Предпросмотр разделения'}
        </button>
        <button className="btn btn-secondary" onClick={onBack}>Назад</button>
      </div>

      {/* Split result: ColumnMapper + table */}
      {splitRows && (
        <>
          <h3>Результат разделения ({splitRows.length} строк, {splitHeaderCols.length} колонок)</h3>

          <ColumnMapper
            columns={splitHeaderCols}
            mapping={splitMapping}
            headerRow={splitHeaderRow}
            totalRows={splitRows.length}
            onChange={setSplitMapping}
            onHeaderRowChange={setSplitHeaderRow}
          />

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <button className="btn btn-primary" onClick={handleReparseWithSep} disabled={reparsing}>
              {reparsing ? 'Пересборка...' : 'Пересобрать счёт'}
            </button>
          </div>

          <div className="preview-table-wrap" style={{ maxHeight: '500px', overflowY: 'auto' }}>
            <table>
              <tbody>
                {splitRows.map((row, rowIdx) => (
                  <tr key={rowIdx} className={rowIdx === splitHeaderRow ? 'highlight' : ''}>
                    <td style={{ color: '#999', fontSize: '0.75rem' }}>{rowIdx + 1}</td>
                    {row.map((cell, colIdx) => {
                      const isMapped = Object.values(splitMapping).includes(colIdx);
                      return (
                        <td key={colIdx} style={isMapped ? { background: '#e0e7ff' } : undefined}>
                          {cell || ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function InvoicePreview({ invoiceId, onBack }: Props) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [invoice, setInvoice] = useState<InvoiceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [mapping, setMapping] = useState<ColumnMapping>({
    article: null, name: null, unit: null, quantity: null, price: null, amount: null,
  });
  const [headerRow, setHeaderRow] = useState(0);
  const [saving, setSaving] = useState(false);
  const [reparsing, setReparsing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [previewRes, invoiceRes] = await Promise.all([
          api.get(`/invoices/${invoiceId}/preview`),
          api.get(`/invoices/${invoiceId}`),
        ]);

        const data: PreviewData = previewRes.data;
        setPreview(data);
        setInvoice(invoiceRes.data.invoice);

        // Initialize mapping: prefer saved config, then detected, then empty
        const source = data.supplierConfig || data.detectedMapping;
        if (source) {
          setMapping({
            article: source.article,
            name: source.name,
            unit: source.unit,
            quantity: source.quantity,
            price: source.price,
            amount: source.amount,
          });
          setHeaderRow(source.headerRow);
        }
      } catch {
        setMessage({ type: 'error', text: 'Ошибка загрузки предпросмотра' });
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [invoiceId]);

  const ensureSupplier = async (): Promise<{ supplier_id: number; supplier_name: string } | null> => {
    if (invoice?.supplier_id) {
      return { supplier_id: invoice.supplier_id, supplier_name: invoice.supplier_name || '' };
    }
    try {
      const { data } = await api.post(`/invoices/${invoiceId}/ensure-supplier`);
      setInvoice(prev => prev ? { ...prev, supplier_id: data.supplier_id, supplier_name: data.supplier_name } : prev);
      return data;
    } catch {
      setMessage({ type: 'error', text: 'Не удалось создать поставщика' });
      return null;
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const supplier = await ensureSupplier();
      if (!supplier) { setSaving(false); return; }

      await api.put(`/suppliers/${supplier.supplier_id}/parser-config`, {
        config: { ...mapping, headerRow },
      });
      setMessage({ type: 'success', text: `Настройки сохранены для ${supplier.supplier_name}. Нажмите «Пересобрать» для применения.` });
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при сохранении настроек' });
    } finally {
      setSaving(false);
    }
  };

  const handleReparse = async () => {
    setReparsing(true);
    setMessage(null);
    try {
      await ensureSupplier();

      const { data } = await api.post(`/invoices/${invoiceId}/reparse`, {
        mapping: { ...mapping, headerRow },
      });

      const msgs: string[] = [];
      if (data.imported === 0) {
        msgs.push('Позиции не найдены');
      } else {
        msgs.push(`Пересобрано: ${data.imported} позиций`);
      }
      if (data.errors && data.errors.length > 0) {
        msgs.push(`Предупреждения: ${data.errors.length}`);
      }
      const msgType = data.imported === 0 ? 'error' : 'success';
      setMessage({ type: msgType as 'success' | 'error', text: msgs.join('. ') });

      const [previewRes, invoiceRes] = await Promise.all([
        api.get(`/invoices/${invoiceId}/preview`),
        api.get(`/invoices/${invoiceId}`),
      ]);
      setPreview(previewRes.data);
      setInvoice(invoiceRes.data.invoice);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при пересборке' });
    } finally {
      setReparsing(false);
    }
  };

  if (loading) return <p className="loading">Загрузка предпросмотра...</p>;
  if (!preview || !invoice) return <p className="error-msg">Не удалось загрузить данные</p>;

  const category = preview.parsingCategory || invoice.parsing_category;

  // --- Category C: unreadable PDF ---
  if (category === 'C') {
    return (
      <div>
        <h1>Счёт: {invoice.file_name}</h1>
        {invoice.supplier_name && <p className="muted">Поставщик: {invoice.supplier_name}</p>}

        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, padding: '1rem', margin: '1rem 0' }}>
          <strong>PDF не распознан</strong>
          <p style={{ margin: '0.5rem 0 0' }}>
            {preview.parsingCategoryReason || invoice.parsing_category_reason || 'Текст не удалось извлечь из документа.'}
          </p>
          <p style={{ margin: '0.5rem 0 0', color: '#666', fontSize: '0.85rem' }}>
            Возможные причины: отсканированный документ, защищённый PDF, нестандартные шрифты.
          </p>
        </div>

        <h3>Действия</h3>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled title="Будет реализовано в следующем этапе">
            Запросить Excel
          </button>
          <button className="btn btn-primary" disabled title="Будет реализовано в следующем этапе">
            Ввести вручную
          </button>
          <button className="btn btn-secondary" disabled title="Будет реализовано в следующем этапе">
            Пропустить
          </button>
          <button className="btn btn-secondary" onClick={onBack}>Назад</button>
        </div>
      </div>
    );
  }

  // --- Category B: text readable but no column structure ---
  if (category === 'B') {
    return (
      <CategoryBPanel
        invoice={invoice}
        preview={preview}
        invoiceId={invoiceId}
        onBack={onBack}
      />
    );
  }

  // --- Category A (default): normal preview ---
  const headerCols = preview.rows[headerRow] || [];

  return (
    <div>
      <h1>Предпросмотр: {invoice.file_name}</h1>
      {invoice.supplier_name && (
        <p className="muted">Поставщик: {invoice.supplier_name}</p>
      )}

      {message && (
        <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>
          {message.text}
        </p>
      )}

      <h3>Настройка колонок</h3>
      <ColumnMapper
        columns={headerCols}
        mapping={mapping}
        headerRow={headerRow}
        totalRows={preview.rows.length}
        onChange={setMapping}
        onHeaderRowChange={setHeaderRow}
      />

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Сохранение...' : 'Сохранить настройки'}
        </button>
        <button className="btn btn-primary" onClick={handleReparse} disabled={reparsing}>
          {reparsing ? 'Пересборка...' : 'Пересобрать счёт'}
        </button>
        <button className="btn btn-secondary" onClick={onBack}>Назад</button>
      </div>

      {(() => {
        const FIELD_LABELS: Record<string, string> = {
          article: 'Артикул', name: 'Наименование', unit: 'Ед. изм.',
          quantity: 'Количество', price: 'Цена', amount: 'Сумма',
        };
        const entries = Object.entries(mapping).filter(([, v]) => v !== null) as [string, number][];
        if (entries.length === 0) return null;
        return (
          <div style={{ background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: 4, padding: '0.5rem 0.75rem', marginBottom: '1rem', fontSize: '0.85rem' }}>
            <strong>Активное сопоставление</strong> (строка заголовка: {headerRow + 1})
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.25rem' }}>
              {entries.map(([field, colIdx]) => (
                <span key={field} style={{ background: '#e0e7ff', padding: '2px 6px', borderRadius: 3 }}>
                  {FIELD_LABELS[field] || field} &larr; кол. {colIdx + 1}{headerCols[colIdx] ? ` (${headerCols[colIdx]})` : ''}
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      <h3>Данные файла ({preview.totalRows} строк)</h3>
      <div className="preview-table-wrap" style={{ maxHeight: '600px', overflowY: 'auto' }}>
        <table>
          <tbody>
            {preview.rows.map((row, rowIdx) => (
              <tr key={rowIdx} className={rowIdx === headerRow ? 'highlight' : ''}>
                <td style={{ color: '#999', fontSize: '0.75rem' }}>{rowIdx + 1}</td>
                {row.map((cell, colIdx) => {
                  const isMapped = Object.values(mapping).includes(colIdx);
                  return (
                    <td
                      key={colIdx}
                      style={isMapped ? { background: '#e0e7ff' } : undefined}
                    >
                      {cell || ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
