import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

interface Specification {
  id: number;
  section: string;
  file_name: string | null;
  item_count: number;
  created_at: string;
}

interface Invoice {
  id: number;
  supplier_id: number | null;
  invoice_number: string | null;
  supplier_name: string | null;
  invoice_date: string | null;
  total_amount: number | null;
  item_count: number;
  file_name: string;
  status: string;
  vat_rate: number | null;
  prices_include_vat: number | null;
  created_at: string;
}

const VAT_OPTIONS = [0, 5, 7, 10, 20, 22];

interface Props {
  projectId: number;
  onBack: () => void;
  onInvoicePreview: (invoiceId: number) => void;
  onMatching: () => void;
}

export function ProjectDetail({ projectId, onInvoicePreview, onMatching }: Props) {
  const [specifications, setSpecifications] = useState<Specification[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadingSection, setUploadingSection] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [vatEditing, setVatEditing] = useState<number | null>(null);
  const invoiceFileRef = useRef<HTMLInputElement>(null);
  const specFileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const handleSaveVat = async (supplierId: number, vatRate: number, pricesIncludeVat: boolean) => {
    try {
      await api.put(`/suppliers/${supplierId}/vat`, { vat_rate: vatRate, prices_include_vat: pricesIncludeVat });
      setVatEditing(null);
      await loadData();
    } catch {
      setMessage({ type: 'error', text: 'Ошибка сохранения НДС' });
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [specRes, invRes] = await Promise.all([
        api.get(`/projects/${projectId}/specifications`),
        api.get(`/projects/${projectId}/invoices`),
      ]);
      setSpecifications(specRes.data.specifications || []);
      setSections(specRes.data.sections || []);
      setInvoices(invRes.data.invoices || []);
    } catch {
      setMessage({ type: 'error', text: 'Не удалось загрузить данные проекта' });
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
      if (data.needsMapping) {
        setMessage({ type: 'error', text: `Счёт сохранён, но не удалось определить колонки (${data.errors?.length || 0} ошибок). Откройте "Предпросмотр" и настройте колонки вручную.` });
      } else {
        setMessage({ type: 'success', text: `Импортировано ${data.imported} позиций` });
      }
      if (invoiceFileRef.current) invoiceFileRef.current.value = '';
      await loadData();
    } catch (err: any) {
      const details = err.response?.data?.details;
      const errorMsg = err.response?.data?.error || 'Ошибка загрузки';
      setMessage({ type: 'error', text: details ? `${errorMsg}: ${typeof details === 'string' ? details : JSON.stringify(details)}` : errorMsg });
    } finally {
      setUploading(false);
    }
  };

  const handleUploadSpec = async (section: string) => {
    const input = specFileRefs.current[section];
    const file = input?.files?.[0];
    if (!file) return;
    setUploadingSection(section);
    setMessage(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('section', section);
    try {
      const { data } = await api.post(`/projects/${projectId}/specifications`, formData);
      setMessage({ type: 'success', text: `${section}: импортировано ${data.imported} позиций` });
      if (input) input.value = '';
      await loadData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка загрузки' });
    } finally {
      setUploadingSection(null);
    }
  };

  const handleDeleteSpec = async (specId: number, section: string) => {
    if (!confirm(`Удалить спецификацию «${section}»?`)) return;
    setMessage(null);
    try {
      await api.delete(`/specifications/${specId}`);
      setMessage({ type: 'success', text: `Раздел «${section}» удалён` });
      await loadData();
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при удалении' });
    }
  };

  if (loading) return <p className="loading">Загрузка...</p>;

  // Map section -> specification for quick lookup
  const specBySection: Record<string, Specification> = {};
  for (const spec of specifications) {
    specBySection[spec.section] = spec;
  }

  const totalSpecItems = specifications.reduce((sum, s) => sum + s.item_count, 0);

  return (
    <div>
      {message && (
        <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>
          {message.text}
        </p>
      )}

      {/* Specification section */}
      <div className="section">
        <h2>Спецификации по разделам</h2>
        <table>
          <thead>
            <tr>
              <th>Раздел</th>
              <th>Файл</th>
              <th>Позиций</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sections.map(section => {
              const spec = specBySection[section];
              return (
                <tr key={section}>
                  <td style={{ fontWeight: 500 }}>{section}</td>
                  {spec ? (
                    <>
                      <td>{spec.file_name || '—'}</td>
                      <td>{spec.item_count}</td>
                      <td>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleDeleteSpec(spec.id, section)}
                        >
                          Удалить
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td colSpan={2}>
                        <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          <input
                            type="file"
                            accept=".xlsx,.xls"
                            ref={el => { specFileRefs.current[section] = el; }}
                            style={{ maxWidth: '220px', fontSize: '0.8rem' }}
                          />
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleUploadSpec(section)}
                            disabled={uploadingSection === section}
                          >
                            {uploadingSection === section ? 'Загрузка...' : 'Загрузить'}
                          </button>
                        </span>
                      </td>
                      <td></td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {totalSpecItems > 0 && (
          <p className="muted" style={{ marginTop: '0.5rem' }}>
            Всего позиций: {totalSpecItems} в {specifications.length} разделах
          </p>
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
                <th>НДС</th>
                <th>Дата</th>
                <th>Сумма</th>
                <th>Позиций</th>
                <th>Файл</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td>{inv.invoice_number || '—'}</td>
                  <td>{inv.supplier_name || '—'}</td>
                  <td>
                    {inv.supplier_id && vatEditing === inv.supplier_id ? (
                      <span style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                        <select
                          defaultValue={inv.vat_rate ?? 20}
                          id={`vat-rate-${inv.supplier_id}`}
                          style={{ width: '60px' }}
                        >
                          {VAT_OPTIONS.map(r => <option key={r} value={r}>{r}%</option>)}
                        </select>
                        <label style={{ fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                          <input
                            type="checkbox"
                            defaultChecked={inv.prices_include_vat === 1}
                            id={`vat-incl-${inv.supplier_id}`}
                          /> с НДС
                        </label>
                        <button className="btn btn-primary btn-sm" onClick={() => {
                          const rate = parseInt((document.getElementById(`vat-rate-${inv.supplier_id}`) as HTMLSelectElement).value);
                          const incl = (document.getElementById(`vat-incl-${inv.supplier_id}`) as HTMLInputElement).checked;
                          handleSaveVat(inv.supplier_id!, rate, incl);
                        }}>OK</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setVatEditing(null)}>X</button>
                      </span>
                    ) : (
                      <span
                        style={{ cursor: inv.supplier_id ? 'pointer' : 'default', textDecoration: inv.supplier_id ? 'underline dotted' : 'none' }}
                        onClick={() => inv.supplier_id && setVatEditing(inv.supplier_id)}
                        title={inv.supplier_id ? 'Нажмите для изменения' : ''}
                      >
                        {inv.vat_rate != null ? `${inv.vat_rate}%` : '—'}
                        {inv.prices_include_vat === 0 && inv.vat_rate ? ' (без)' : ''}
                      </span>
                    )}
                  </td>
                  <td>{inv.invoice_date || '—'}</td>
                  <td>{inv.total_amount != null ? inv.total_amount.toLocaleString('ru-RU') : '—'}</td>
                  <td>{inv.item_count}</td>
                  <td>{inv.file_name}</td>
                  <td>
                    {inv.status === 'needs_mapping' ? (
                      <span style={{ color: '#d97706', fontWeight: 600 }}>Требует настройки</span>
                    ) : (
                      <span style={{ color: '#16a34a' }}>Готов</span>
                    )}
                  </td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => onInvoicePreview(inv.id)}>
                      {inv.status === 'needs_mapping' ? 'Настроить' : 'Предпросмотр'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Matching section */}
      {specifications.length > 0 && invoices.length > 0 && (
        <div className="section">
          <h2>Сопоставление</h2>
          <button className="btn btn-primary" onClick={onMatching}>
            Сопоставить позиции
          </button>
        </div>
      )}
    </div>
  );
}
