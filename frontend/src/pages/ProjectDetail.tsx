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
  vat_amount: number | null;
  needs_amount_review: number | null;
  created_at: string;
}

const VAT_OPTIONS = [0, 5, 7, 10, 20, 22];

interface Props {
  projectId: number;
  onBack: () => void;
  onInvoicePreview: (invoiceId: number) => void;
  onMatching: () => void;
  onSpecEditor: (specId: number) => void;
}

export function ProjectDetail({ projectId, onInvoicePreview, onMatching, onSpecEditor }: Props) {
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
  const [deliveryTotal, setDeliveryTotal] = useState<number | null>(null);
  const [bulkInvUploading, setBulkInvUploading] = useState(false);
  const [bulkInvResults, setBulkInvResults] = useState<{
    fileName: string; invoiceId: number | null; supplierName: string | null;
    imported: number; parsingCategory: string | null; status: string; error?: string;
  }[] | null>(null);
  const [priceLists, setPriceLists] = useState<{ id: number; file_name: string; status: string; item_count: number; supplier_name: string | null }[]>([]);
  const [uploadingPriceList, setUploadingPriceList] = useState(false);
  const [invoiceItemsView, setInvoiceItemsView] = useState<number | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<any[]>([]);
  const [invoiceItemsMeta, setInvoiceItemsMeta] = useState<any | null>(null);
  const [invoiceItemsLoading, setInvoiceItemsLoading] = useState(false);
  const [importingMatches, setImportingMatches] = useState(false);
  const [importMatchesResult, setImportMatchesResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [matchingStats, setMatchingStats] = useState<{ total: number; confirmed: number } | null>(null);
  const importMatchesRef = useRef<HTMLInputElement>(null);
  const invoiceFileRef = useRef<HTMLInputElement>(null);
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const bulkInvFileRef = useRef<HTMLInputElement>(null);
  const priceListFileRef = useRef<HTMLInputElement>(null);
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
      const [specRes, invRes, delivRes, plRes, statsRes] = await Promise.all([
        api.get(`/projects/${projectId}/specifications`),
        api.get(`/projects/${projectId}/invoices`),
        api.get(`/projects/${projectId}/delivery-total`).catch(() => ({ data: { total: 0 } })),
        api.get(`/projects/${projectId}/price-lists`).catch(() => ({ data: [] })),
        api.get(`/projects/${projectId}/matching/stats`).catch(() => ({ data: null })),
      ]);
      setSpecifications(specRes.data.specifications || []);
      setSections(specRes.data.sections || []);
      setInvoices(invRes.data.invoices || []);
      setDeliveryTotal(delivRes.data.total > 0 ? delivRes.data.total : null);
      setPriceLists(plRes.data || []);
      if (statsRes.data && statsRes.data.total > 0) setMatchingStats(statsRes.data);
      else setMatchingStats(null);
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

  const handleViewInvoiceItems = async (invoiceId: number) => {
    if (invoiceItemsView === invoiceId) {
      setInvoiceItemsView(null);
      return;
    }
    setInvoiceItemsView(invoiceId);
    setInvoiceItemsLoading(true);
    try {
      const { data } = await api.get(`/invoices/${invoiceId}`);
      setInvoiceItemsMeta(data.invoice || null);
      setInvoiceItems(data.items || []);
    } catch {
      setMessage({ type: 'error', text: 'Ошибка загрузки позиций счёта' });
    } finally {
      setInvoiceItemsLoading(false);
    }
  };

  const handleUploadPriceList = async () => {
    const file = priceListFileRef.current?.files?.[0];
    if (!file) return;
    setUploadingPriceList(true);
    setMessage(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post(`/projects/${projectId}/price-lists`, fd);
      setMessage({ type: 'success', text: `Прайс загружен: ${data.imported} позиций` });
      if (priceListFileRef.current) priceListFileRef.current.value = '';
      await loadData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при загрузке прайса' });
    } finally {
      setUploadingPriceList(false);
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

  const handleVerifyInvoice = async (inv: Invoice) => {
    if (!confirm(`Подтвердить счёт «${inv.file_name}»?\nСтатус изменится на «Проверен».`)) return;
    try {
      await api.put(`/invoices/${inv.id}/status`, { status: 'verified' });
      setMessage({ type: 'success', text: `Счёт «${inv.file_name}» подтверждён` });
      await loadData();
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при подтверждении счёта' });
    }
  };

  if (loading) return <p className="loading">Загрузка...</p>;

  const handleImportMatches = async () => {
    const file = importMatchesRef.current?.files?.[0];
    if (!file) return;
    setImportingMatches(true);
    setImportMatchesResult(null);
    setMessage(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const { data } = await api.post(`/projects/${projectId}/import-matches`, formData);
      setImportMatchesResult({ imported: data.imported, skipped: data.skipped });
      setMessage({ type: 'success', text: `Импортировано ${data.imported} правил сопоставления` });
      if (importMatchesRef.current) importMatchesRef.current.value = '';
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при импорте' });
    } finally {
      setImportingMatches(false);
    }
  };

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
                            onClick={() => onSpecEditor(spec.id)}
                          >
                            Редактировать
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
              {invoices.map(inv => {
                const isVerified = inv.status === 'verified' || inv.parsing_category === 'A';
                const needsSetup = inv.status === 'needs_mapping' || inv.parsing_category === 'C';
                return (
                <>
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
                  <td>
                    {inv.total_amount != null ? inv.total_amount.toLocaleString('ru-RU') : '—'}
                    {inv.vat_amount != null && (
                      <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                        НДС: {inv.vat_amount.toLocaleString('ru-RU')}
                      </div>
                    )}
                  </td>
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
                    {inv.needs_amount_review === 1 && (
                      <div style={{ fontSize: '0.75rem', color: '#b45309', marginTop: '0.2rem' }} title="Сумма позиций расходится с итогом документа более чем на 15%">
                        ⚠ Сумма под сомнением
                      </div>
                    )}
                  </td>
                  <td style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleViewInvoiceItems(inv.id)}
                    >
                      {invoiceItemsView === inv.id ? 'Скрыть' : 'Позиции'}
                    </button>
                    {!isVerified && (
                      <>
                        <button className="btn btn-secondary btn-sm" onClick={() => onInvoicePreview(inv.id)}>
                          {needsSetup ? 'Настроить' : 'Предпросмотр'}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ color: '#7c3aed' }}
                          title="Переразобрать через GigaChat AI"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm(`Переразобрать «${inv.file_name}» через GigaChat?\nТекущие позиции будут заменены.`)) return;
                            try {
                              setMessage({ type: 'success', text: `Отправляю в GigaChat...` });
                              const { data } = await api.post(`/invoices/${inv.id}/reparse-gigachat`, {});
                              setMessage({ type: 'success', text: `GigaChat: найдено ${data.items} позиций` });
                              await loadData();
                            } catch (err: any) {
                              const details = err.response?.data?.details || err.response?.data?.error || err.message || 'Неизвестная ошибка';
                              setMessage({ type: 'error', text: `Ошибка GigaChat: ${details}` });
                            }
                          }}
                        >
                          GigaChat
                        </button>
                        {!needsSetup && inv.status !== 'awaiting_excel' && inv.status !== 'skipped' && inv.item_count > 0 && (
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ color: '#16a34a', fontWeight: 600 }}
                            title="Подтвердить — позиции проверены, всё верно"
                            onClick={(e) => { e.stopPropagation(); handleVerifyInvoice(inv); }}
                          >
                            ✓ Подтвердить
                          </button>
                        )}
                      </>
                    )}
                    {isVerified && (
                      <button
                        className="btn btn-secondary btn-sm"
                        title="Изменить позиции вручную"
                        onClick={() => onInvoicePreview(inv.id)}
                      >
                        Редактировать
                      </button>
                    )}
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
                {invoiceItemsView === inv.id && (
                  <tr key={`items-${inv.id}`}>
                    <td colSpan={9} style={{ padding: '0.5rem 1rem', background: '#f0f4ff' }}>
                      {invoiceItemsLoading ? (
                        <p className="muted">Загрузка позиций...</p>
                      ) : (
                        <>
                          {invoiceItemsMeta && (
                            <div style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: '#374151' }}>
                              {invoiceItemsMeta.supplier_name && <span style={{ marginRight: '1rem' }}>Поставщик: <strong>{invoiceItemsMeta.supplier_name}</strong></span>}
                              {invoiceItemsMeta.invoice_number && <span style={{ marginRight: '1rem' }}>№ {invoiceItemsMeta.invoice_number}</span>}
                              {invoiceItemsMeta.invoice_date && <span style={{ marginRight: '1rem' }}>от {invoiceItemsMeta.invoice_date}</span>}
                              {invoiceItemsMeta.total_amount != null && <span>Итого: <strong>{invoiceItemsMeta.total_amount.toLocaleString('ru-RU')} ₽</strong></span>}
                              {invoiceItemsMeta.vat_amount != null && <span style={{ marginLeft: '1rem', color: '#6b7280' }}>в т.ч. НДС: <strong>{invoiceItemsMeta.vat_amount.toLocaleString('ru-RU')} ₽</strong></span>}
                            </div>
                          )}
                          {inv.needs_amount_review === 1 && invoiceItemsMeta?.total_amount != null && (
                            <div style={{ marginBottom: '0.5rem', padding: '0.4rem 0.75rem', background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: '4px', fontSize: '0.8rem', color: '#92400e' }}>
                              ⚠ <strong>Сумма под сомнением:</strong>{' '}
                              расчётная сумма позиций ({invoiceItems.reduce((s: number, it: any) => s + (it.price ?? 0) * (it.quantity ?? 0), 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽)
                              {' '}расходится с итогом документа ({invoiceItemsMeta.total_amount.toLocaleString('ru-RU')} ₽) более чем на 15%.
                              Рекомендуется проверить позиции вручную.
                            </div>
                          )}
                          <div style={{ maxHeight: '400px', overflow: 'auto', marginBottom: '0.5rem' }}>
                            <table style={{ fontSize: '0.8rem' }}>
                              <thead>
                                <tr>
                                  <th style={{ width: '30px' }}>#</th>
                                  <th style={{ width: '90px' }}>Артикул</th>
                                  <th>Наименование</th>
                                  <th style={{ width: '50px' }}>Ед.</th>
                                  <th style={{ width: '60px' }}>Кол-во</th>
                                  <th style={{ width: '90px' }}>Цена</th>
                                  <th style={{ width: '100px' }}>Сумма</th>
                                </tr>
                              </thead>
                              <tbody>
                                {invoiceItems.map((item: any, idx: number) => (
                                  <tr key={item.id} style={item.is_delivery ? { color: '#9a3412' } : {}}>
                                    <td>{idx + 1}</td>
                                    <td>{item.article || '—'}</td>
                                    <td>{item.name}</td>
                                    <td>{item.unit || '—'}</td>
                                    <td>{item.quantity != null ? item.quantity : '—'}</td>
                                    <td>{item.price != null ? item.price.toLocaleString('ru-RU') : '—'}</td>
                                    <td>{item.amount != null ? item.amount.toLocaleString('ru-RU') : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <button
                              className="btn btn-secondary btn-sm"
                              style={{ color: '#7c3aed' }}
                              title="Если позиции определены неверно — переразобрать счёт через GigaChat"
                              onClick={async () => {
                                if (!confirm(`Переразобрать «${inv.file_name}» через GigaChat?\nТекущие позиции будут заменены.`)) return;
                                try {
                                  setMessage({ type: 'success', text: `Отправляю в GigaChat...` });
                                  const { data } = await api.post(`/invoices/${inv.id}/reparse-gigachat`, {});
                                  setMessage({ type: 'success', text: `GigaChat: найдено ${data.items} позиций` });
                                  setInvoiceItemsView(null);
                                  await loadData();
                                } catch (err: any) {
                                  const details = err.response?.data?.details || err.response?.data?.error || err.message || 'Неизвестная ошибка';
                                  setMessage({ type: 'error', text: `Ошибка GigaChat: ${details}` });
                                }
                              }}
                            >
                              Переразобрать (GigaChat)
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              title="Настроить колонки вручную"
                              onClick={() => { setInvoiceItemsView(null); onInvoicePreview(inv.id); }}
                            >
                              Редактировать вручную
                            </button>
                            {inv.status !== 'verified' && inv.item_count > 0 && (
                              <button
                                className="btn btn-primary btn-sm"
                                style={{ background: '#16a34a', borderColor: '#16a34a' }}
                                title="Позиции проверены — подтвердить счёт"
                                onClick={() => { setInvoiceItemsView(null); handleVerifyInvoice(inv); }}
                              >
                                ✓ Всё верно — подтвердить
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                )}
                </>
              )})}
            </tbody>
          </table>
        )}

        {deliveryTotal != null && (
          <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: '#fff7ed', borderRadius: '4px', border: '1px solid #fed7aa', display: 'inline-block' }}>
            <span style={{ color: '#9a3412', fontWeight: 600 }}>Доставка по проекту: {deliveryTotal.toLocaleString('ru-RU')} ₽</span>
            <span className="muted" style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}>(суммарно по всем счетам)</span>
          </div>
        )}
      </div>

      {/* Price lists section */}
      <div className="section">
        <h2>Прайсы</h2>
        <div className="upload-area" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="file" accept=".pdf,.xlsx,.xls" ref={priceListFileRef} />
          <button className="btn btn-primary btn-sm" onClick={handleUploadPriceList} disabled={uploadingPriceList}>
            {uploadingPriceList ? 'Загрузка...' : 'Загрузить прайс'}
          </button>
        </div>
        {priceLists.length === 0 ? (
          <p className="muted" style={{ marginTop: '0.5rem' }}>Нет загруженных прайсов.</p>
        ) : (
          <table style={{ marginTop: '0.75rem' }}>
            <thead>
              <tr>
                <th>Файл</th>
                <th>Поставщик</th>
                <th>Позиций</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {priceLists.map(pl => (
                <tr key={pl.id}>
                  <td>{pl.file_name}</td>
                  <td>{pl.supplier_name || '—'}</td>
                  <td>{pl.item_count}</td>
                  <td>
                    {pl.status === 'parsed' ? (
                      <span style={{ color: '#16a34a', fontWeight: 600 }}>Загружен</span>
                    ) : (
                      <span style={{ color: '#d97706', fontWeight: 600 }}>Требует настройки</span>
                    )}
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ color: '#dc2626' }}
                      onClick={async () => {
                        if (!confirm(`Удалить прайс «${pl.file_name}»?`)) return;
                        try {
                          await api.delete(`/price-lists/${pl.id}`);
                          await loadData();
                        } catch {
                          setMessage({ type: 'error', text: 'Ошибка при удалении прайса' });
                        }
                      }}
                    >Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Import reference matches section */}
      <div className="section">
        <h2>Обучение системы</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          Загрузите Excel с колонками <b>«Наименование спецификации»</b> и <b>«Наименование в счёте»</b>
          (опционально: <b>«Поставщик»</b>) — система создаст правила сопоставления.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".xlsx,.xls" ref={importMatchesRef} style={{ fontSize: '0.85rem' }} />
          <button className="btn btn-primary btn-sm" onClick={handleImportMatches} disabled={importingMatches}>
            {importingMatches ? 'Импорт...' : 'Импортировать эталонные матчи'}
          </button>
        </div>
        {importMatchesResult && (
          <p className="success-msg" style={{ marginTop: '0.5rem' }}>
            Импортировано: {importMatchesResult.imported} правил, пропущено: {importMatchesResult.skipped}
          </p>
        )}
      </div>

      {/* Matching section */}
      {specifications.length > 0 && invoices.length > 0 && (
        <div className="section">
          <h2>Сопоставление</h2>
          {matchingStats && matchingStats.total > 0 && (
            <div style={{ marginBottom: '0.75rem', padding: '0.75rem', background: '#f8f9fa', borderRadius: '6px', fontSize: '0.85rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                <span style={{ fontWeight: 600 }}>Покрытие спецификации</span>
                <span style={{ color: '#6b7280' }}>
                  {matchingStats.confirmed} / {matchingStats.total} подтверждено
                  ({Math.round(matchingStats.confirmed / matchingStats.total * 100)}%)
                </span>
              </div>
              <div style={{ height: '8px', background: '#e5e7eb', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '4px',
                  background: matchingStats.confirmed / matchingStats.total >= 0.8 ? '#16a34a'
                    : matchingStats.confirmed / matchingStats.total >= 0.5 ? '#d97706' : '#3b82f6',
                  width: `${Math.round(matchingStats.confirmed / matchingStats.total * 100)}%`,
                  transition: 'width 0.3s',
                }} />
              </div>
            </div>
          )}
          <button className="btn btn-primary" onClick={onMatching}>
            Сопоставить позиции
          </button>
        </div>
      )}
    </div>
  );
}
