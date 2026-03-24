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
  meta?: { sheetNames: string[]; detectedHeaderRow: number; totalRows: number };
}

interface InvoiceInfo {
  id: number;
  supplier_id: number | null;
  supplier_name: string | null;
  file_name: string;
  parsing_category: string | null;
  parsing_category_reason: string | null;
  status: string;
  discount_detected: number | null;
  discount_applied: number;
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

function CategoryBPanel({ invoice, preview, invoiceId, onBack, onReload }: {
  invoice: InvoiceInfo;
  preview: PreviewData;
  invoiceId: number;
  onBack: () => void;
  onReload: () => Promise<void>;
}) {
  const [sepMethod, setSepMethod] = useState<SeparatorMethod>('spaces');
  const [customSep, setCustomSep] = useState(';');
  const [splitRows, setSplitRows] = useState<string[][] | null>(null);
  const [splitMapping, setSplitMapping] = useState<ColumnMapping>({
    article: null, name: null, unit: null, quantity: null, quantity_packages: null, price: null, amount: null,
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
          quantity_packages: (data.detectedMapping as any).quantity_packages ?? null,
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
        await api.put(`/invoices/${invoiceId}/status`, { status: 'verified' });
        await onReload(); // перезагрузить invoice → выйти из CategoryB в CategoryA
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

interface ManualItem {
  name: string;
  article: string;
  unit: string;
  quantity: string;
  price: string;
}

const EMPTY_ITEM: ManualItem = { name: '', article: '', unit: 'шт', quantity: '', price: '' };

function CategoryCPanel({ invoice, preview, invoiceId, onBack }: {
  invoice: InvoiceInfo;
  preview: PreviewData;
  invoiceId: number;
  onBack: () => void;
}) {
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [items, setItems] = useState<ManualItem[]>([{ ...EMPTY_ITEM }]);
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const handleRequestExcel = async () => {
    setRequesting(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/invoices/${invoiceId}/request-excel`);
      const emailMsg = data.supplierEmail
        ? `Email поставщика: ${data.supplierEmail}`
        : 'Email поставщика не указан — свяжитесь напрямую.';
      setMessage({ type: 'success', text: `Статус изменён на «Ожидание Excel». ${emailMsg}` });
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при запросе Excel' });
    } finally {
      setRequesting(false);
    }
  };

  const handleSkip = async () => {
    if (!confirm('Пропустить этот счёт? Его позиции не будут учтены в сопоставлении.')) return;
    setSkipping(true);
    setMessage(null);
    try {
      await api.post(`/invoices/${invoiceId}/skip`);
      setMessage({ type: 'success', text: 'Счёт пропущен.' });
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при пропуске счёта' });
    } finally {
      setSkipping(false);
    }
  };

  const updateItem = (idx: number, field: keyof ManualItem, value: string) => {
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, [field]: value } : item));
  };

  const addItem = () => setItems(prev => [...prev, { ...EMPTY_ITEM }]);

  const removeItem = (idx: number) => {
    if (items.length <= 1) return;
    setItems(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSaveManual = async () => {
    const valid = items.filter(it => it.name.trim());
    if (valid.length === 0) {
      setMessage({ type: 'error', text: 'Заполните хотя бы одну позицию (наименование обязательно)' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const payload = valid.map(it => ({
        name: it.name.trim(),
        article: it.article.trim() || null,
        unit: it.unit.trim() || null,
        quantity: it.quantity ? parseFloat(it.quantity.replace(',', '.')) : null,
        price: it.price ? parseFloat(it.price.replace(',', '.')) : null,
      }));
      const { data } = await api.post(`/invoices/${invoiceId}/manual-items`, { items: payload });
      setMessage({ type: 'success', text: `Сохранено: ${data.imported} позиций` });
      setShowManual(false);
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при сохранении позиций' });
    } finally {
      setSaving(false);
    }
  };

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

      {message && (
        <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>
          {message.text}
        </p>
      )}

      <h3>Действия</h3>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <button className="btn btn-primary" onClick={handleRequestExcel} disabled={requesting}>
          {requesting ? 'Запрос...' : 'Запросить Excel'}
        </button>
        <button className="btn btn-primary" onClick={() => setShowManual(!showManual)}>
          {showManual ? 'Скрыть форму' : 'Ввести вручную'}
        </button>
        <button className="btn btn-secondary" onClick={handleSkip} disabled={skipping}>
          {skipping ? 'Пропуск...' : 'Пропустить'}
        </button>
        <button className="btn btn-secondary" onClick={onBack}>Назад</button>
      </div>

      {/* Manual entry form */}
      {showManual && (
        <div style={{ border: '1px solid #dee2e6', borderRadius: 4, padding: '1rem', marginBottom: '1rem' }}>
          <h3>Ручной ввод позиций</h3>
          <table style={{ width: '100%', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Наименование *</th>
                <th style={{ width: 100 }}>Артикул</th>
                <th style={{ width: 60 }}>Ед.</th>
                <th style={{ width: 80 }}>Кол-во</th>
                <th style={{ width: 90 }}>Цена</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={idx}>
                  <td style={{ color: '#999' }}>{idx + 1}</td>
                  <td>
                    <input type="text" value={item.name} onChange={e => updateItem(idx, 'name', e.target.value)}
                      style={{ width: '100%', padding: '4px' }} placeholder="Наименование" />
                  </td>
                  <td>
                    <input type="text" value={item.article} onChange={e => updateItem(idx, 'article', e.target.value)}
                      style={{ width: '100%', padding: '4px' }} placeholder="—" />
                  </td>
                  <td>
                    <input type="text" value={item.unit} onChange={e => updateItem(idx, 'unit', e.target.value)}
                      style={{ width: '100%', padding: '4px' }} />
                  </td>
                  <td>
                    <input type="text" value={item.quantity} onChange={e => updateItem(idx, 'quantity', e.target.value)}
                      style={{ width: '100%', padding: '4px' }} placeholder="0" />
                  </td>
                  <td>
                    <input type="text" value={item.price} onChange={e => updateItem(idx, 'price', e.target.value)}
                      style={{ width: '100%', padding: '4px' }} placeholder="0.00" />
                  </td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => removeItem(idx)}
                      disabled={items.length <= 1} style={{ padding: '2px 6px' }}>x</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="btn btn-secondary btn-sm" onClick={addItem}>+ Добавить позицию</button>
            <button className="btn btn-primary btn-sm" onClick={handleSaveManual} disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить позиции'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function InvoicePreview({ invoiceId, onBack }: Props) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [invoice, setInvoice] = useState<InvoiceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [mapping, setMapping] = useState<ColumnMapping>({
    article: null, name: null, unit: null, quantity: null, quantity_packages: null, price: null, amount: null,
  });
  const [headerRow, setHeaderRow] = useState(0);
  const [saving, setSaving] = useState(false);
  const [reparsing, setReparsing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [unitReviewItems, setUnitReviewItems] = useState<any[]>([]);
  const [unitTriggers, setUnitTriggers] = useState<{ keyword: string; to_unit: string }[]>([]);
  const [unitModal, setUnitModal] = useState<{ item: any; suggestedUnit: string } | null>(null);
  const [unitFactor, setUnitFactor] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [calculatingPrices, setCalculatingPrices] = useState(false);
  const [netPriceDiscount, setNetPriceDiscount] = useState('');
  const [showNetPriceForm, setShowNetPriceForm] = useState(false);
  const [applyingNetPrice, setApplyingNetPrice] = useState(false);
  const [showReparseConfirm, setShowReparseConfirm] = useState(false);
  const [showPriceFormulaModal, setShowPriceFormulaModal] = useState(false);
  const [priceFormulaNumerator, setPriceFormulaNumerator] = useState('amount');
  const [priceFormulaDenominator, setPriceFormulaDenominator] = useState('quantity');
  const [savedPriceFormula, setSavedPriceFormula] = useState<{ numerator: string; denominator: string } | null>(null);
  const [applyingFormula, setApplyingFormula] = useState(false);

  const loadPreview = async (inv?: InvoiceInfo, sheet?: number) => {
    const currentInvoice = inv || invoice;
    const currentSheet = sheet ?? sheetIndex;
    const isExcelFile = currentInvoice && /\.(xlsx?|xls)$/i.test(currentInvoice.file_name);

    const previewUrl = isExcelFile
      ? `/invoices/${invoiceId}/preview-excel?sheet=${currentSheet}&maxRows=200`
      : `/invoices/${invoiceId}/preview`;

    const previewRes = await api.get(previewUrl);
    const data: PreviewData = previewRes.data;
    setPreview(data);

    if (data.meta?.sheetNames) {
      setSheetNames(data.meta.sheetNames);
    }

    return data;
  };

  const applyMapping = (data: PreviewData) => {
    const source = data.supplierConfig || data.detectedMapping;
    if (source) {
      setMapping({
        article: source.article,
        name: source.name,
        unit: source.unit,
        quantity: source.quantity,
        quantity_packages: (source as any).quantity_packages ?? null,
        price: source.price,
        amount: source.amount,
      });
      setHeaderRow(source.headerRow);
    }
  };

  const loadUnitReview = async () => {
    try {
      const [itemsRes, triggersRes] = await Promise.all([
        api.get(`/invoices/${invoiceId}/unit-review-items`),
        api.get('/unit-conversion-triggers'),
      ]);
      setUnitReviewItems(itemsRes.data);
      setUnitTriggers(triggersRes.data);
    } catch { /* non-critical */ }
  };

  const reloadInvoice = async () => {
    setLoading(true);
    try {
      const invoiceRes = await api.get(`/invoices/${invoiceId}`);
      const inv: InvoiceInfo = invoiceRes.data.invoice;
      setInvoice(inv);
      if (invoiceRes.data.priceCalcFormula) setSavedPriceFormula(invoiceRes.data.priceCalcFormula);
      const data = await loadPreview(inv, 0);
      applyMapping(data);
      await loadUnitReview();
    } catch {
      setMessage({ type: 'error', text: 'Ошибка загрузки предпросмотра' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reloadInvoice();
  }, [invoiceId]);

  const handleSheetChange = async (newSheet: number) => {
    setSheetIndex(newSheet);
    setLoading(true);
    try {
      const data = await loadPreview(undefined, newSheet);
      applyMapping(data);
    } catch {
      setMessage({ type: 'error', text: 'Ошибка загрузки листа' });
    } finally {
      setLoading(false);
    }
  };

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

  const handleReparseConfirmed = async () => {
    setShowReparseConfirm(false);
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

      if (data.imported > 0) {
        await api.put(`/invoices/${invoiceId}/status`, { status: 'verified' });
      }

      const invoiceRes = await api.get(`/invoices/${invoiceId}`);
      setInvoice(invoiceRes.data.invoice);
      await loadPreview(invoiceRes.data.invoice);
      await loadUnitReview();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при пересборке' });
    } finally {
      setReparsing(false);
    }
  };

  const handleUnitConvert = async (skip: boolean) => {
    if (!unitModal) return;
    if (skip) { setUnitModal(null); setUnitFactor(''); return; }
    const factor = parseFloat(unitFactor.replace(',', '.'));
    if (!factor || factor <= 0) { alert('Введите корректный коэффициент'); return; }
    try {
      await api.put(`/invoice-items/${unitModal.item.id}/apply-unit-conversion`, {
        new_unit: unitModal.suggestedUnit,
        factor,
      });
      setUnitModal(null);
      setUnitFactor('');
      await loadUnitReview();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Ошибка при конвертации');
    }
  };

  const handleApplyDiscount = async (apply: boolean) => {
    if (!invoice) return;
    if (!apply) {
      // Dismiss banner by marking applied without actual recalc
      setInvoice(prev => prev ? { ...prev, discount_detected: null } : prev);
      return;
    }
    try {
      await api.post(`/invoices/${invoiceId}/apply-discount`, {
        discount_percent: invoice.discount_detected,
      });
      setInvoice(prev => prev ? { ...prev, discount_applied: 1 } : prev);
      setMessage({ type: 'success', text: `Скидка ${invoice.discount_detected}% применена — цены пересчитаны` });
      await loadPreview();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при применении скидки' });
    }
  };

  const handleOpenHistory = async () => {
    try {
      const { data } = await api.get(`/invoices/${invoiceId}/history`);
      setHistoryData(data.history || []);
      setHistoryOpen(true);
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при загрузке истории' });
    }
  };

  const handleRollback = async (version: number) => {
    if (!confirm(`Откатить к версии ${version}?`)) return;
    try {
      const { data } = await api.post(`/invoices/${invoiceId}/rollback`, { version });
      setMessage({ type: 'success', text: `Восстановлено ${data.restored} позиций из версии ${version}` });
      setHistoryOpen(false);
      await loadPreview();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при откате' });
    }
  };

  const FIELD_LABELS: Record<string, string> = {
    amount: 'Сумма', quantity: 'Количество', quantity_packages: 'Количество (упак.)', price: 'Цена',
  };

  const handleApplyPriceFormula = async (saveForSupplier: boolean) => {
    setApplyingFormula(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/invoices/${invoiceId}/calculate-price-formula`, {
        numerator: priceFormulaNumerator,
        denominator: priceFormulaDenominator,
        saveForSupplier,
      });
      if (saveForSupplier) setSavedPriceFormula({ numerator: priceFormulaNumerator, denominator: priceFormulaDenominator });
      setShowPriceFormulaModal(false);
      setMessage({ type: 'success', text: `Цена пересчитана для ${data.updated} позиций (${FIELD_LABELS[data.numerator]} ÷ ${FIELD_LABELS[data.denominator]})` });
      await loadPreview();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при расчёте цены' });
    } finally {
      setApplyingFormula(false);
    }
  };

  const handleCalculatePrices = async () => {
    setCalculatingPrices(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/invoices/${invoiceId}/calculate-prices`);
      setMessage({ type: 'success', text: `Цены рассчитаны для ${data.updated} позиций` });
      await loadPreview();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при расчёте цен' });
    } finally {
      setCalculatingPrices(false);
    }
  };

  const handleApplyNetPriceMode = async () => {
    const pct = parseFloat(netPriceDiscount.replace(',', '.'));
    if (!pct || pct <= 0 || pct >= 100) {
      setMessage({ type: 'error', text: 'Введите корректный процент скидки (1-99)' });
      return;
    }
    setApplyingNetPrice(true);
    try {
      const { data } = await api.post(`/invoices/${invoiceId}/apply-net-price-mode`, { discount_percent: pct });
      setMessage({ type: 'success', text: `Цены пересчитаны (×${data.factor.toFixed(4)}), обновлено: ${data.updated} позиций` });
      setShowNetPriceForm(false);
      await loadPreview();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при пересчёте' });
    } finally {
      setApplyingNetPrice(false);
    }
  };

  if (loading) return <p className="loading">Загрузка предпросмотра...</p>;
  if (!preview || !invoice) return <p className="error-msg">Не удалось загрузить данные</p>;

  const category = preview.parsingCategory || invoice.parsing_category;

  // --- Category C: unreadable PDF ---
  if (category === 'C') {
    return (
      <CategoryCPanel
        invoice={invoice}
        preview={preview}
        invoiceId={invoiceId}
        onBack={onBack}
      />
    );
  }

  // --- Category B: text readable but no column structure ---
  // For Excel files, skip separator panel — show normal preview with ColumnMapper instead
  const isExcel = /\.(xlsx?|xls)$/i.test(invoice.file_name);
  if (category === 'B' && !isExcel) {
    return (
      <CategoryBPanel
        invoice={invoice}
        preview={preview}
        invoiceId={invoiceId}
        onBack={onBack}
        onReload={reloadInvoice}
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

      {invoice.discount_detected != null && !invoice.discount_applied && (
        <div style={{
          background: '#fef9c3', border: '1px solid #ca8a04', borderRadius: '6px',
          padding: '0.75rem 1rem', marginBottom: '1rem',
          display: 'flex', alignItems: 'center', gap: '1rem',
        }}>
          <span>⚠️ В счёте обнаружена скидка <strong>{invoice.discount_detected}%</strong>. Применить ко всем позициям?</span>
          <button className="btn btn-primary btn-sm" onClick={() => handleApplyDiscount(true)}>Да, применить</button>
          <button className="btn btn-secondary btn-sm" onClick={() => handleApplyDiscount(false)}>Нет</button>
        </div>
      )}

      {savedPriceFormula && (
        <div style={{
          background: '#fef9c3', border: '1px solid #ca8a04', borderRadius: '6px',
          padding: '0.75rem 1rem', marginBottom: '1rem',
          display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
        }}>
          <span>💡 Для этого поставщика обычно пересчитывается цена: <strong>{savedPriceFormula.numerator === 'amount' ? 'Сумма' : savedPriceFormula.numerator} ÷ {savedPriceFormula.denominator === 'quantity' ? 'Количество' : savedPriceFormula.denominator}</strong>. Применить?</span>
          <button className="btn btn-primary btn-sm" onClick={() => {
            setPriceFormulaNumerator(savedPriceFormula.numerator);
            setPriceFormulaDenominator(savedPriceFormula.denominator);
            handleApplyPriceFormula(false);
          }}>Применить</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setSavedPriceFormula(null)}>Не сейчас</button>
        </div>
      )}

      {unitReviewItems.length > 0 && (
        <div style={{ background: '#fef9c3', border: '1px solid #ca8a04', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
          <strong>⚠️ Позиции требуют проверки единиц ({unitReviewItems.length})</strong>
          <table style={{ marginTop: '0.5rem', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', fontSize: '0.8rem' }}>Наименование</th>
                <th style={{ textAlign: 'left', fontSize: '0.8rem' }}>Ед.</th>
                <th style={{ textAlign: 'right', fontSize: '0.8rem' }}>Цена</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {unitReviewItems.map((item: any) => {
                const trigger = unitTriggers.find(t => item.name.toLowerCase().includes(t.keyword.toLowerCase()));
                const suggestedUnit = trigger?.to_unit || '';
                return (
                  <tr key={item.id}>
                    <td style={{ fontSize: '0.85rem' }}>{item.name}</td>
                    <td style={{ fontSize: '0.85rem' }}>{item.unit || '—'}</td>
                    <td style={{ fontSize: '0.85rem', textAlign: 'right' }}>{item.price != null ? item.price.toLocaleString('ru-RU') : '—'}</td>
                    <td>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => { setUnitModal({ item, suggestedUnit }); setUnitFactor(''); }}
                      >
                        Пересчитать{suggestedUnit ? ` в ${suggestedUnit}` : ''}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Unit conversion modal */}
      {unitModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: '1.5rem', width: 360, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 0.5rem' }}>Пересчёт единицы</h3>
            <p style={{ margin: '0 0 0.25rem', fontSize: '0.9rem' }}><strong>{unitModal.item.name}</strong></p>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#666' }}>
              Текущая ед.: <strong>{unitModal.item.unit || '—'}</strong> → Новая: <strong>{unitModal.suggestedUnit || '?'}</strong>
            </p>
            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>
              Коэффициент (1 {unitModal.item.unit} = ? {unitModal.suggestedUnit})
            </label>
            <input
              className="input"
              type="number"
              step="any"
              min="0"
              value={unitFactor}
              onChange={e => setUnitFactor(e.target.value)}
              placeholder="например, 6"
              style={{ marginTop: '0.25rem', marginBottom: '1rem' }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary" onClick={() => handleUnitConvert(false)}>Применить</button>
              <button className="btn btn-secondary" onClick={() => handleUnitConvert(true)}>Пропустить</button>
            </div>
          </div>
        </div>
      )}

      {isExcel && sheetNames.length > 1 && (
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ marginRight: '0.5rem', fontWeight: 'bold' }}>Лист:</label>
          <select value={sheetIndex} onChange={e => handleSheetChange(parseInt(e.target.value, 10))}>
            {sheetNames.map((name, idx) => (
              <option key={idx} value={idx}>{name}</option>
            ))}
          </select>
        </div>
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

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Сохранение...' : 'Сохранить настройки'}
        </button>
        <button className="btn btn-primary" onClick={() => setShowReparseConfirm(true)} disabled={reparsing}>
          {reparsing ? 'Пересборка...' : 'Пересобрать счёт'}
        </button>
        <button className="btn btn-secondary" onClick={() => setShowPriceFormulaModal(true)}>
          Рассчитать цену за единицу
        </button>
        <button className="btn btn-secondary" onClick={handleOpenHistory}>
          История версий
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowNetPriceForm(!showNetPriceForm)}>
          Цена без скидки → нетто
        </button>
        {showNetPriceForm && (
          <span style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="% скидки"
              value={netPriceDiscount}
              onChange={e => setNetPriceDiscount(e.target.value)}
              style={{ width: '70px', padding: '2px 6px', fontSize: '0.85rem' }}
            />
            <button className="btn btn-primary btn-sm" onClick={handleApplyNetPriceMode} disabled={applyingNetPrice}>
              {applyingNetPrice ? '...' : 'Применить'}
            </button>
          </span>
        )}
        <button className="btn btn-secondary" onClick={onBack}>Назад</button>
      </div>

      {showPriceFormulaModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: '1.5rem', width: 420, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 1rem' }}>Рассчитать цену за единицу</h3>
            <p style={{ color: '#555', margin: '0 0 1rem', fontSize: '0.9rem' }}>Цена = Числитель ÷ Делитель</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>Числитель (что делим)</span>
                <select value={priceFormulaNumerator} onChange={e => setPriceFormulaNumerator(e.target.value)} style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #ced4da' }}>
                  {[['amount','Сумма'],['quantity','Количество'],['quantity_packages','Количество (упак.)'],['price','Цена']].map(([v,l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>Делитель (на что делим)</span>
                <select value={priceFormulaDenominator} onChange={e => setPriceFormulaDenominator(e.target.value)} style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #ced4da' }}>
                  {[['quantity','Количество'],['quantity_packages','Количество (упак.)'],['amount','Сумма'],['price','Цена']].map(([v,l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => setShowPriceFormulaModal(false)}>Отмена</button>
              <button className="btn btn-secondary" onClick={() => handleApplyPriceFormula(false)} disabled={applyingFormula}>
                {applyingFormula ? 'Расчёт...' : 'Применить'}
              </button>
              <button className="btn btn-primary" onClick={() => handleApplyPriceFormula(true)} disabled={applyingFormula}>
                {applyingFormula ? 'Расчёт...' : 'Применить и запомнить поставщика'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReparseConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: '1.5rem', width: 380, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 0.75rem' }}>Пересобрать счёт?</h3>
            <p style={{ margin: '0 0 1.25rem', color: '#555' }}>Текущие позиции будут заменены. Предыдущая версия сохранится в истории.</p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowReparseConfirm(false)}>Отмена</button>
              <button className="btn btn-primary" onClick={handleReparseConfirmed}>Пересобрать</button>
            </div>
          </div>
        </div>
      )}

      {historyOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: '1.5rem', width: 480, maxHeight: '80vh', overflow: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 1rem' }}>История версий</h3>
            {historyData.length === 0 ? (
              <p className="muted">История пуста</p>
            ) : (
              <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Версия</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Действие</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Позиций</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Дата</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {historyData.map((h: any) => (
                    <tr key={h.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                      <td style={{ padding: '4px 8px' }}>v{h.version}</td>
                      <td style={{ padding: '4px 8px' }}>{h.action}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>{h.item_count}</td>
                      <td style={{ padding: '4px 8px', fontSize: '0.75rem', color: '#666' }}>{new Date(h.created_at).toLocaleString('ru-RU')}</td>
                      <td style={{ padding: '4px 8px' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => handleRollback(h.version)}>
                          Откатить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ marginTop: '1rem' }}>
              <button className="btn btn-secondary" onClick={() => setHistoryOpen(false)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {(() => {
        const FIELD_LABELS: Record<string, string> = {
          article: 'Артикул', name: 'Наименование', unit: 'Ед. изм.',
          quantity: 'Количество', price: 'Цена', amount: 'Сумма',
        };
        const entries = Object.entries(mapping).filter(([, v]) => v !== null) as [string, number][];
        if (entries.length === 0) return null;
        const exampleRow = preview.rows[headerRow + 1];
        return (
          <div style={{ background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: 4, padding: '0.5rem 0.75rem', marginBottom: '1rem', fontSize: '0.85rem' }}>
            <strong>Активное сопоставление</strong> (строка заголовка: {headerRow + 1})
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.25rem' }}>
              {entries.map(([field, colIdx]) => {
                const example = exampleRow?.[colIdx] || '';
                const exampleStr = example ? ` · пр: ${String(example).substring(0, 30)}` : '';
                return (
                  <span key={field} style={{ background: '#e0e7ff', padding: '2px 6px', borderRadius: 3 }}>
                    {FIELD_LABELS[field] || field} &larr; кол.{colIdx + 1}{headerCols[colIdx] ? ` (${headerCols[colIdx]})` : ''}{exampleStr}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      <h3>Данные файла ({preview.totalRows} строк)</h3>
      {(() => {
        const maxCols = Math.max(...preview.rows.map(r => r.length), 0);
        const COL_FIELD_LABELS: Record<string, string> = {
          article: 'Артикул', name: 'Наименование', unit: 'Ед. изм.',
          quantity: 'Кол-во', price: 'Цена', amount: 'Сумма',
        };
        // Reverse mapping: column index → field label
        const colToField: Record<number, string> = {};
        for (const [field, colIdx] of Object.entries(mapping)) {
          if (colIdx !== null && colIdx !== undefined) {
            colToField[colIdx as number] = COL_FIELD_LABELS[field] || field;
          }
        }
        return (
          <div className="preview-table-wrap" style={{ maxHeight: '600px', overflowY: 'auto' }}>
            <table style={{ tableLayout: 'fixed', minWidth: '100%' }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: '#f1f5f9', zIndex: 1 }}>
                  <th style={{ color: '#999', fontSize: '0.7rem', width: '2rem', minWidth: '2rem' }}>#</th>
                  {Array.from({ length: maxCols }, (_, colIdx) => {
                    const isMapped = Object.values(mapping).includes(colIdx);
                    const headerText = headerCols[colIdx];
                    const fieldLabel = colToField[colIdx];
                    return (
                      <th key={colIdx} style={{
                        fontSize: '0.7rem',
                        background: isMapped ? '#e0e7ff' : '#f1f5f9',
                        whiteSpace: 'nowrap',
                        padding: '4px 6px',
                        minWidth: '80px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {fieldLabel && (
                          <div style={{
                            background: '#4f46e5', color: '#fff',
                            borderRadius: 3, padding: '1px 5px',
                            fontSize: '0.65rem', fontWeight: 700,
                            marginBottom: '2px', display: 'inline-block',
                          }}>
                            {fieldLabel}
                          </div>
                        )}
                        <div style={{ fontWeight: 700 }}>кол.{colIdx + 1}</div>
                        <div style={{ fontWeight: 400, color: '#666' }}>{headerText || '(без названия)'}</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, rowIdx) => (
                  <tr key={rowIdx} className={rowIdx === headerRow ? 'highlight' : ''}>
                    <td style={{ color: '#999', fontSize: '0.75rem', width: '2rem', minWidth: '2rem' }}>{rowIdx + 1}</td>
                    {row.map((cell, colIdx) => {
                      const isMapped = Object.values(mapping).includes(colIdx);
                      return (
                        <td
                          key={colIdx}
                          style={isMapped ? { background: '#e0e7ff', minWidth: '80px', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' } : { minWidth: '80px', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' }}
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
        );
      })()}
    </div>
  );
}
