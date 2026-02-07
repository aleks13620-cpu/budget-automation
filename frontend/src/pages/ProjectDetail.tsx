import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

interface SpecItem {
  id: number;
  name: string;
  unit: string | null;
  quantity: number | null;
  section: string | null;
}

interface Invoice {
  id: number;
  invoice_number: string | null;
  supplier_name: string | null;
  invoice_date: string | null;
  total_amount: number | null;
  item_count: number;
  file_name: string;
  created_at: string;
}

interface Props {
  projectId: number;
  onBack: () => void;
  onInvoicePreview: (invoiceId: number) => void;
}

export function ProjectDetail({ projectId, onInvoicePreview }: Props) {
  const [specItems, setSpecItems] = useState<SpecItem[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadingSpec, setUploadingSpec] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const invoiceFileRef = useRef<HTMLInputElement>(null);
  const specFileRef = useRef<HTMLInputElement>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [specRes, invRes] = await Promise.all([
        api.get(`/projects/${projectId}/specification`),
        api.get(`/projects/${projectId}/invoices`),
      ]);
      setSpecItems(specRes.data.items || []);
      setInvoices(invRes.data.invoices || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [projectId]);

  const handleUploadInvoice = async () => {
    const file = invoiceFileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const { data } = await api.post(`/projects/${projectId}/invoices`, formData);
      setMessage({ type: 'success', text: `Импортировано ${data.imported} позиций` });
      if (invoiceFileRef.current) invoiceFileRef.current.value = '';
      await loadData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка загрузки' });
    } finally {
      setUploading(false);
    }
  };

  const handleUploadSpec = async () => {
    const file = specFileRef.current?.files?.[0];
    if (!file) return;
    setUploadingSpec(true);
    setMessage(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const { data } = await api.post(`/projects/${projectId}/specification`, formData);
      setMessage({ type: 'success', text: `Импортировано ${data.imported} позиций спецификации` });
      if (specFileRef.current) specFileRef.current.value = '';
      await loadData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка загрузки' });
    } finally {
      setUploadingSpec(false);
    }
  };

  if (loading) return <p className="loading">Загрузка...</p>;

  return (
    <div>
      {message && (
        <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>
          {message.text}
        </p>
      )}

      {/* Specification section */}
      <div className="section">
        <h2>Спецификация</h2>
        {specItems.length === 0 ? (
          <>
            <p className="muted">Спецификация не загружена.</p>
            <div className="upload-area">
              <input type="file" accept=".xlsx,.xls" ref={specFileRef} />
              <button className="btn btn-primary btn-sm" onClick={handleUploadSpec} disabled={uploadingSpec}>
                {uploadingSpec ? 'Загрузка...' : 'Загрузить'}
              </button>
            </div>
          </>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Наименование</th>
                <th>Ед.</th>
                <th>Кол-во</th>
                <th>Раздел</th>
              </tr>
            </thead>
            <tbody>
              {specItems.slice(0, 50).map(item => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.unit || '—'}</td>
                  <td>{item.quantity ?? '—'}</td>
                  <td>{item.section || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {specItems.length > 50 && (
          <p className="muted">Показано 50 из {specItems.length} позиций</p>
        )}
      </div>

      {/* Invoices section */}
      <div className="section">
        <h2>Счета</h2>
        <div className="upload-area">
          <input type="file" accept=".pdf,.xlsx,.xls" ref={invoiceFileRef} />
          <button className="btn btn-primary btn-sm" onClick={handleUploadInvoice} disabled={uploading}>
            {uploading ? 'Загрузка...' : 'Загрузить счёт'}
          </button>
        </div>

        {invoices.length === 0 ? (
          <p className="muted">Нет загруженных счетов.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Номер</th>
                <th>Поставщик</th>
                <th>Дата</th>
                <th>Сумма</th>
                <th>Позиций</th>
                <th>Файл</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td>{inv.invoice_number || '—'}</td>
                  <td>{inv.supplier_name || '—'}</td>
                  <td>{inv.invoice_date || '—'}</td>
                  <td>{inv.total_amount != null ? inv.total_amount.toLocaleString('ru-RU') : '—'}</td>
                  <td>{inv.item_count}</td>
                  <td>{inv.file_name}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => onInvoicePreview(inv.id)}>
                      Предпросмотр
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
