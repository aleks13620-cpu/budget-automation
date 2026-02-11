import { useState, useEffect } from 'react';
import { api } from '../api';
import { ColumnMapper } from '../components/ColumnMapper';
import type { ColumnMapping } from '../components/ColumnMapper';

interface PreviewData {
  rows: string[][];
  totalRows: number;
  detectedMapping: (ColumnMapping & { headerRow: number }) | null;
  supplierConfig: (ColumnMapping & { headerRow: number }) | null;
}

interface InvoiceInfo {
  id: number;
  supplier_id: number | null;
  supplier_name: string | null;
  file_name: string;
}

interface Props {
  invoiceId: number;
  onBack: () => void;
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
      // Ensure supplier exists before reparse
      await ensureSupplier();

      const { data } = await api.post(`/invoices/${invoiceId}/reparse`, {
        mapping: { ...mapping, headerRow },
      });

      // Build result message with validation
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

      // Refetch preview and invoice data so UI updates
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

  // Get column headers from the header row
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
                  // Highlight mapped columns
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
