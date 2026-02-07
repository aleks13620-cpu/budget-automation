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

  const handleSave = async () => {
    if (!invoice?.supplier_id) {
      setMessage({ type: 'error', text: 'Поставщик не определён, сохранение невозможно' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await api.put(`/suppliers/${invoice.supplier_id}/parser-config`, {
        config: { ...mapping, headerRow },
      });
      setMessage({ type: 'success', text: 'Настройки парсера сохранены' });
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при сохранении настроек' });
    } finally {
      setSaving(false);
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
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || !invoice.supplier_id}>
          {saving ? 'Сохранение...' : 'Сохранить настройки'}
        </button>
        <button className="btn btn-secondary" onClick={onBack}>Назад</button>
      </div>

      <h3>Данные файла ({preview.totalRows} строк всего, показано {preview.rows.length})</h3>
      <div className="preview-table-wrap">
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
