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
  parsing_category: string | null;
  parsing_category_reason: string | null;
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
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResults, setBulkResults] = useState<{
    fileName: string; section: string | null; imported: number;
    status: 'ok' | 'conflict' | 'no_section' | 'parse_error'; error?: string;
  }[] | null>(null);
  const [specItemsView, setSpecItemsView] = useState<number | null>(null);
  const [specItems, setSpecItems] = useState<any[]>([]);
  const [specItemsLoading, setSpecItemsLoading] = useState(false);
  const [bulkInvUploading, setBulkInvUploading] = useState(false);
  const [bulkInvResults, setBulkInvResults] = useState<{
    fileName: string; invoiceId: number | null; supplierName: string | null;
    imported: number; parsingCategory: string | null; status: string; error?: string;
  }[] | null>(null);
  const invoiceFileRef = useRef<HTMLInputElement>(null);
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const bulkInvFileRef = useRef<HTMLInputElement>(null);
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

  const handleBulkUpload = async () => {
    const files = bulkFileRef.current?.files;
    if (!files || files.length === 0) return;
    setBulkUploading(true);
    setBulkResults(null);
    setMessage(null);
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }
    try {
      const { data } = await api.post(`/projects/${projectId}/specifications/bulk`, formData);
      setBulkResults(data.results);
      const s = data.summary;
      if (s.ok > 0) {
        setMessage({ type: 'success', text: `Загружено ${s.ok} из ${s.total} файлов (${s.totalImported} позиций)` });
      } else {
        setMessage({ type: 'error', text: `Не удалось импортировать файлы (${s.total} файлов)` });
      }
      if (bulkFileRef.current) bulkFileRef.current.value = '';
      await loadData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка массовой загрузки' });
    } finally {
      setBulkUploading(false);
    }
  };

  const handleViewSpecItems = async (specId: number) => {
    if (specItemsView === specId) {
      setSpecItemsView(null);
      return;
    }
    setSpecItemsView(specId);
    setSpecItemsLoading(true);
    try {
      const { data } = await api.get(`/specifications/${specId}/items`);
      setSpecItems(data.items || []);
    } catch {
      setMessage({ type: 'error', text: 'Ошибка загрузки позиций спецификации' });
    } finally {
      setSpecItemsLoading(false);
    }
  };

  const handleBulkInvoiceUpload = async () => {
    const files = bulkInvFileRef.current?.files;
    if (!files || files.length === 0) return;
    setBulkInvUploading(true);
    setBulkInvResults(null);
    setMessage(null);
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }
    try {
      const { data } = await api.post(`/projects/${projectId}/invoices/bulk`, formData);
      setBulkInvResults(data.results);
      const s = data.summary;
      setMessage({
        type: s.ok > 0 || s.needsMapping > 0 ? 'success' : 'error',
        text: `Загружено: ${s.ok} готовых, ${s.needsMapping} требуют настройки, ${s.errors} ошибок (${s.totalImported} позиций)`,
      });
      if (bulkInvFileRef.current) bulkInvFileRef.current.value = '';
      await loadData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка массовой загрузки' });
    } finally {
      setBulkInvUploading(false);
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

      {/* Bulk upload section */}
      <div className="section">
        <h2>Массовая загрузка спецификаций</h2>
        <p className="muted" style={{ marginBottom: '0.5rem' }}>
          Выберите несколько Excel-файлов (.xlsx/.xls). Раздел определяется автоматически по имени файла или содержимому.
        </p>
        <div className="upload-area" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="file"
            accept=".xlsx,.xls"
            multiple
            ref={bulkFileRef}
            style={{ fontSize: '0.85rem' }}
          />
          <button className="btn btn-primary btn-sm" onClick={handleBulkUpload} disabled={bulkUploading}>
            {bulkUploading ? 'Загрузка...' : 'Загрузить все'}
          </button>
        </div>

        {bulkResults && (
          <div style={{ marginTop: '0.75rem' }}>
            <table style={{ fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th>Файл</th>
                  <th>Раздел</th>
                  <th>Позиций</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {bulkResults.map((r, idx) => (
                  <tr key={idx}>
                    <td>{r.fileName}</td>
                    <td>{r.section || '—'}</td>
                    <td>{r.imported || '—'}</td>
                    <td>
                      {r.status === 'ok' ? (
                        <span style={{ color: '#16a34a', fontWeight: 600 }}>OK</span>
                      ) : r.status === 'conflict' ? (
                        <span style={{ color: '#d97706' }} title={r.error}>{r.error}</span>
                      ) : r.status === 'no_section' ? (
                        <span style={{ color: '#dc2626' }} title={r.error}>{r.error}</span>
                      ) : (
                        <span style={{ color: '#dc2626' }} title={r.error}>{r.error || 'Ошибка'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
            {sections.map(section => {
              const spec = specBySection[section];
              return (
                <tbody key={section}>
                  <tr>
                    <td style={{ fontWeight: 500 }}>{section}</td>
                    {spec ? (
                      <>
                        <td>{spec.file_name || '—'}</td>
                        <td>{spec.item_count}</td>
                        <td style={{ display: 'flex', gap: '0.25rem' }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleViewSpecItems(spec.id)}
                          >
                            {specItemsView === spec.id ? 'Скрыть' : 'Просмотр'}
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ color: '#dc2626' }}
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
                  {spec && specItemsView === spec.id && (
                    <tr>
                      <td colSpan={4} style={{ padding: '0.5rem 1rem', background: '#f8f9fa' }}>
                        {specItemsLoading ? (
                          <p className="muted">Загрузка позиций...</p>
                        ) : (
                          <>
                            <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
                              Импортировано позиций: {specItems.length}
                            </p>
                            <div style={{ maxHeight: '400px', overflow: 'auto' }}>
                              <table style={{ fontSize: '0.8rem' }}>
                                <thead>
                                  <tr>
                                    <th style={{ width: '40px' }}>#</th>
                                    <th>Наименование</th>
                                    <th>Характеристики</th>
                                    <th style={{ width: '60px' }}>Ед.</th>
                                    <th style={{ width: '70px' }}>Кол-во</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {specItems.map((item: any, idx: number) => (
                                    <tr key={item.id}>
                                      <td>{idx + 1}</td>
                                      <td>{item.name}</td>
                                      <td>{item.characteristics || '—'}</td>
                                      <td>{item.unit || '—'}</td>
                                      <td>{item.quantity != null ? item.quantity : '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
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
        <div className="upload-area" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".pdf,.xlsx,.xls" ref={invoiceFileRef} />
          <button className="btn btn-primary btn-sm" onClick={handleUploadInvoice} disabled={uploading}>
            {uploading ? 'Загрузка...' : 'Загрузить счёт'}
          </button>
        </div>

        <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: '#f8f9fa', borderRadius: '6px' }}>
          <h4 style={{ margin: '0 0 0.5rem' }}>Массовая загрузка счетов</h4>
          <p className="muted" style={{ marginBottom: '0.5rem', fontSize: '0.85rem' }}>
            Выберите несколько файлов (PDF, XLSX, XLS). Каждый файл будет обработан отдельно.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              accept=".pdf,.xlsx,.xls"
              multiple
              ref={bulkInvFileRef}
              style={{ fontSize: '0.85rem' }}
            />
            <button className="btn btn-primary btn-sm" onClick={handleBulkInvoiceUpload} disabled={bulkInvUploading}>
              {bulkInvUploading ? 'Загрузка...' : 'Загрузить все'}
            </button>
          </div>

          {bulkInvResults && (
            <div style={{ marginTop: '0.75rem' }}>
              <table style={{ fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th>Файл</th>
                    <th>Поставщик</th>
                    <th>Позиций</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkInvResults.map((r, idx) => (
                    <tr key={idx}>
                      <td>{r.fileName}</td>
                      <td>{r.supplierName || '—'}</td>
                      <td>{r.imported || '—'}</td>
                      <td>
                        {r.status === 'ok' ? (
                          <span style={{ color: '#16a34a', fontWeight: 600 }}>OK ({r.imported})</span>
                        ) : r.status === 'needs_mapping' ? (
                          <span style={{ color: '#d97706', fontWeight: 600 }}>Требует настройки</span>
                        ) : (
                          <span style={{ color: '#dc2626' }} title={r.error}>{r.error || 'Ошибка'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
                    {inv.parsing_category === 'C' ? (
                      <span style={{ color: '#dc2626', fontWeight: 600 }} title={inv.parsing_category_reason || ''}>Не распознан</span>
                    ) : inv.status === 'awaiting_excel' ? (
                      <span style={{ color: '#7c3aed', fontWeight: 600 }}>Ожидание Excel</span>
                    ) : inv.status === 'skipped' ? (
                      <span style={{ color: '#9ca3af', fontWeight: 600 }}>Пропущен</span>
                    ) : inv.status === 'verified' ? (
                      <span style={{ color: '#2563eb', fontWeight: 600 }} title={inv.parsing_category_reason || ''}>Проверен ({inv.item_count})</span>
                    ) : inv.parsing_category === 'B' || inv.status === 'needs_mapping' ? (
                      <span style={{ color: '#d97706', fontWeight: 600 }} title={inv.parsing_category_reason || ''}>Требует настройки</span>
                    ) : (
                      <span style={{ color: '#d97706', fontWeight: 600 }} title="Распознан, но ещё не проверен">Требует проверки ({inv.item_count})</span>
                    )}
                  </td>
                  <td style={{ display: 'flex', gap: '0.25rem' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => onInvoicePreview(inv.id)}>
                      {inv.parsing_category === 'C' ? 'Действия' : inv.status === 'needs_mapping' ? 'Настроить' : 'Предпросмотр'}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ color: '#dc2626' }}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Удалить счёт «${inv.file_name}»?`)) return;
                        try {
                          await api.delete(`/invoices/${inv.id}`);
                          setMessage({ type: 'success', text: `Счёт «${inv.file_name}» удалён` });
                          await loadData();
                        } catch {
                          setMessage({ type: 'error', text: 'Ошибка при удалении счёта' });
                        }
                      }}
                    >
                      Удалить
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
