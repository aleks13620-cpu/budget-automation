import { useState, useEffect } from 'react';
import { api } from '../api';
import { MatchTable } from '../components/MatchTable';
import { ManualMatchFromSpec } from '../components/ManualMatchFromSpec';
import { ManualMatchModal } from '../components/ManualMatchModal';

interface MatchItem {
  id: number;
  invoiceItemId: number;
  invoiceName: string;
  article: string | null;
  supplierName: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  effectivePrice: number | null;
  amount: number | null;
  confidence: number;
  matchType: string;
  isConfirmed: boolean;
  isSelected: boolean;
  isAnalog: boolean;
}

interface SpecItem {
  id: number;
  name: string;
  characteristics: string | null;
  equipment_code: string | null;
  unit: string | null;
  quantity: number | null;
  section: string | null;
  parentItemId?: number | null;
  fullName?: string | null;
}

interface MatchRow {
  specItem: SpecItem;
  matches: MatchItem[];
}

interface Summary {
  total: number;
  matched: number;
  confirmed: number;
  unmatched: number;
  tierBreakdown?: Record<string, number>;
}

interface SectionSummary {
  name: string;
  itemCount: number;
  matchedCount: number;
  subtotal: number;
  originalSubtotal: number;
  analogSubtotal: number;
}

interface Props {
  projectId: number;
  onBack: () => void;
}

interface UnmatchedInvoiceItem {
  id: number;
  name: string;
  article: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  supplier_name: string | null;
}

type FilterStatus = 'all' | 'confirmed' | 'pending' | 'unmatched';

export function MatchingView({ projectId, onBack }: Props) {
  const [items, setItems] = useState<MatchRow[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, matched: 0, confirmed: 0, unmatched: 0 });
  const [sections, setSections] = useState<SectionSummary[]>([]);
  const [grandTotal, setGrandTotal] = useState(0);
  const [originalGrandTotal, setOriginalGrandTotal] = useState(0);
  const [analogGrandTotal, setAnalogGrandTotal] = useState(0);
  const [exportMode, setExportMode] = useState<'best' | 'original' | 'analog'>('best');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runningIncremental, setRunningIncremental] = useState(false);
  const [validatingGigaChat, setValidatingGigaChat] = useState(false);
  const [errorReportOpen, setErrorReportOpen] = useState(false);
  const [errorReportText, setErrorReportText] = useState('');
  const [submittingReport, setSubmittingReport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');

  // Manual matching state
  const [manualMatchSpec, setManualMatchSpec] = useState<SpecItem | null>(null);
  const [unmatchedInvoiceItems, setUnmatchedInvoiceItems] = useState<UnmatchedInvoiceItem[]>([]);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [selectedInvoiceItem, setSelectedInvoiceItem] = useState<UnmatchedInvoiceItem | null>(null);
  const [unmatchedSearch, setUnmatchedSearch] = useState('');
  const [unmatchedSupplierFilter, setUnmatchedSupplierFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sectionFilter, setSectionFilter] = useState<string>('all');

  const loadMatching = async (withLoader = false) => {
    if (withLoader) setLoading(true);
    try {
      const { data } = await api.get(`/projects/${projectId}/matching`);
      setItems(data.items || []);
      setSummary(data.summary || { total: 0, matched: 0, confirmed: 0, unmatched: 0 });
    } catch {
      // ignore
    } finally {
      if (withLoader) setLoading(false);
    }
  };

  const loadSummary = async () => {
    try {
      const { data } = await api.get(`/projects/${projectId}/summary`);
      setSections(data.sections || []);
      setGrandTotal(data.grandTotal || 0);
      setOriginalGrandTotal(data.originalGrandTotal || 0);
      setAnalogGrandTotal(data.analogGrandTotal || 0);
    } catch {
      // ignore
    }
  };

  const loadUnmatchedInvoices = async () => {
    try {
      const { data } = await api.get(`/projects/${projectId}/unmatched-invoice-items`);
      setUnmatchedInvoiceItems(data.items || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const loadInitial = async () => {
      setLoading(true);
      await Promise.all([loadMatching(false), loadSummary()]);
      setLoading(false);
    };
    loadInitial();
  }, [projectId]);

  const handleRefresh = () => {
    loadMatching(false);
    loadSummary();
    if (showUnmatched) loadUnmatchedInvoices();
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const response = await api.get(`/projects/${projectId}/export?mode=${exportMode}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      const disposition = response.headers['content-disposition'];
      let fileName = 'specification.xlsx';
      if (disposition) {
        const match = disposition.match(/filename\*=UTF-8''(.+)/);
        if (match) fileName = decodeURIComponent(match[1]);
      }
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при экспорте' });
    } finally {
      setExporting(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/projects/${projectId}/matching/run`);
      setMessage({
        type: 'success',
        text: `Сопоставление завершено: ${data.matched} из ${data.total} позиций найдены`,
      });
      await loadMatching();
      await loadSummary();
    } catch (err: any) {
      setMessage({
        type: 'error',
        text: err.response?.data?.error || 'Ошибка при сопоставлении',
      });
    } finally {
      setRunning(false);
    }
  };

  const handleRunIncremental = async () => {
    setRunningIncremental(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/projects/${projectId}/matching/run?mode=incremental`);
      setMessage({
        type: 'success',
        text: `Обновление завершено: ${data.matched} из ${data.total} позиций найдены (подтверждённые сохранены)`,
      });
      await loadMatching();
      await loadSummary();
    } catch (err: any) {
      setMessage({
        type: 'error',
        text: err.response?.data?.error || 'Ошибка при обновлении сопоставления',
      });
    } finally {
      setRunningIncremental(false);
    }
  };

  const handleSubmitErrorReport = async () => {
    if (!errorReportText.trim()) return;
    setSubmittingReport(true);
    try {
      await api.post(`/projects/${projectId}/feedback`, { comment: errorReportText.trim() });
      setMessage({ type: 'success', text: 'Замечание сохранено. Спасибо!' });
      setErrorReportText('');
      setErrorReportOpen(false);
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при отправке замечания' });
    } finally {
      setSubmittingReport(false);
    }
  };

  const handleValidateGigaChat = async () => {
    setValidatingGigaChat(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/projects/${projectId}/matching/validate-gigachat`);
      setMessage({
        type: 'success',
        text: data.message ?? `GigaChat проверил ${data.validated} пар: подтверждено ${data.boosted}, удалено ${data.removed}`,
      });
      if (data.validated > 0) { await loadMatching(); await loadSummary(); }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка GigaChat валидации' });
    } finally {
      setValidatingGigaChat(false);
    }
  };

  if (loading) return <p className="loading">Загрузка...</p>;

  // Filter items based on status + search + section
  const filteredItems = items.filter(row => {
    const hasConfirmed = row.matches.some(m => m.isConfirmed);
    const hasMatches = row.matches.length > 0;

    if (filterStatus === 'confirmed' && !hasConfirmed) return false;
    if (filterStatus === 'pending' && !(hasMatches && !hasConfirmed)) return false;
    if (filterStatus === 'unmatched' && hasMatches) return false;

    if (sectionFilter !== 'all' && row.specItem.section !== sectionFilter) return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const nameMatch = row.specItem.name.toLowerCase().includes(q);
      const charMatch = row.specItem.characteristics?.toLowerCase().includes(q);
      const codeMatch = row.specItem.equipment_code?.toLowerCase().includes(q);
      const invoiceMatch = row.matches.some(m => m.invoiceName.toLowerCase().includes(q) || m.article?.toLowerCase().includes(q));
      if (!nameMatch && !charMatch && !codeMatch && !invoiceMatch) return false;
    }

    return true;
  });

  // Group filtered items by section
  const availableSections = [...new Set(items.map(r => r.specItem.section || 'Без раздела'))].sort();
  const groupedItems: { section: string; rows: typeof filteredItems }[] = [];
  const sectionMap = new Map<string, typeof filteredItems>();
  for (const row of filteredItems) {
    const sec = row.specItem.section || 'Без раздела';
    if (!sectionMap.has(sec)) sectionMap.set(sec, []);
    sectionMap.get(sec)!.push(row);
  }
  for (const [sec, rows] of sectionMap) {
    groupedItems.push({ section: sec, rows });
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Сопоставление позиций</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={onBack}>Назад</button>
          <button className="btn btn-primary" onClick={handleRun} disabled={running || runningIncremental}>
            {running ? 'Сопоставление...' : 'Запустить сопоставление'}
          </button>
          <button className="btn btn-secondary" onClick={handleRunIncremental} disabled={running || runningIncremental}>
            {runningIncremental ? 'Обновление...' : 'Обновить (сохранить подтверждённые)'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleValidateGigaChat}
            disabled={validatingGigaChat || running}
            title="Проверить сомнительные матчи (confidence 25–40%) через GigaChat"
          >
            {validatingGigaChat ? 'GigaChat...' : '🤖 Проверить (GigaChat)'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setErrorReportOpen(true)}
            title="Сообщить об ошибке или недостатке системы"
          >
            ⚠ Замечание
          </button>
          <select
            value={exportMode}
            onChange={e => setExportMode(e.target.value as 'best' | 'original' | 'analog')}
            style={{ padding: '0.35rem 0.5rem' }}
            title="Режим экспорта"
          >
            <option value="best">Лучший</option>
            <option value="original">Оригинал</option>
            <option value="analog">Аналог</option>
          </select>
          <button className="btn btn-secondary" onClick={handleExport} disabled={exporting || items.length === 0}>
            {exporting ? 'Экспорт...' : 'Экспорт в Excel'}
          </button>
        </div>
      </div>

      {message && (
        <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>
          {message.text}
        </p>
      )}

      {/* Filters */}
      <div className="matching-filters">
        <button
          type="button"
          className={`btn ${filterStatus === 'all' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          title="Показать все позиции спецификации"
          onClick={() => setFilterStatus('all')}
        >
          📋 Все ({items.length})
        </button>
        <button
          type="button"
          className={`btn ${filterStatus === 'confirmed' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          title="Уже согласованные с поставщиком матчи"
          onClick={() => setFilterStatus('confirmed')}
        >
          ✅ Подтверждённые ({summary.confirmed})
        </button>
        <button
          type="button"
          className={`btn ${filterStatus === 'pending' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          title="Есть кандидаты от системы, но без подтверждения — проверьте в первую очередь после автосопоставления"
          onClick={() => setFilterStatus('pending')}
        >
          ⚠️ Требуют проверки ({summary.matched - summary.confirmed})
        </button>
        <button
          type="button"
          className={`btn ${filterStatus === 'unmatched' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          title="Нет предложенных матчей — начните с этого фильтра, если мало автосопоставлений"
          onClick={() => setFilterStatus('unmatched')}
        >
          ❌ Не найдены ({summary.unmatched})
        </button>
      </div>

      {/* Summary */}
      <div className="matching-summary">
        <div className="summary-card">
          <div className="summary-value">{summary.total}</div>
          <div className="summary-label">Всего</div>
        </div>
        <div className="summary-card summary-matched">
          <div className="summary-value">{summary.matched}</div>
          <div className="summary-label">Сопоставлено</div>
        </div>
        <div className="summary-card summary-confirmed">
          <div className="summary-value">{summary.confirmed}</div>
          <div className="summary-label">Подтверждено</div>
        </div>
        <div className="summary-card summary-unmatched">
          <div className="summary-value">{summary.unmatched}</div>
          <div className="summary-label">Без матча</div>
        </div>
      </div>

      {/* Coverage progress bar + tier breakdown */}
      {summary.total > 0 && (
        <div style={{ margin: '0.75rem 0', padding: '0.75rem 1rem', background: '#f8f9fa', borderRadius: '6px', fontSize: '0.85rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
            <span style={{ fontWeight: 600 }}>Покрытие спецификации</span>
            <span style={{ color: '#6b7280' }}>
              {summary.confirmed} / {summary.total} подтверждено ({Math.round(summary.confirmed / summary.total * 100)}%)
            </span>
          </div>
          <div style={{ height: '8px', background: '#e5e7eb', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: '4px',
              background: summary.confirmed / summary.total >= 0.8 ? '#16a34a' : summary.confirmed / summary.total >= 0.5 ? '#d97706' : '#3b82f6',
              width: `${Math.round(summary.confirmed / summary.total * 100)}%`,
              transition: 'width 0.3s',
            }} />
          </div>
          {summary.tierBreakdown && Object.keys(summary.tierBreakdown).length > 0 && (
            <div style={{ display: 'flex', gap: '1.25rem', marginTop: '0.5rem', color: '#6b7280' }}>
              <span>Тиры:</span>
              {summary.tierBreakdown.exact_article ? <span>Артикул: <b>{summary.tierBreakdown.exact_article}</b></span> : null}
              {summary.tierBreakdown.learned_rule ? <span>Правила: <b>{summary.tierBreakdown.learned_rule}</b></span> : null}
              {summary.tierBreakdown.name_similarity ? <span>Схожесть: <b>{summary.tierBreakdown.name_similarity}</b></span> : null}
              {summary.tierBreakdown.name_characteristics ? <span>Хар-ки: <b>{summary.tierBreakdown.name_characteristics}</b></span> : null}
              {summary.tierBreakdown.manual ? <span>Вручную: <b>{summary.tierBreakdown.manual}</b></span> : null}
            </div>
          )}
        </div>
      )}

      {/* Section totals */}
      {sections.length > 0 && (
        <div className="section-summary">
          <h3>Итоги по разделам</h3>
          <table>
            <thead>
              <tr>
                <th>Раздел</th>
                <th style={{ width: '80px' }}>Позиций</th>
                <th style={{ width: '80px' }}>С ценой</th>
                <th style={{ width: '140px' }}>Ориг.</th>
                <th style={{ width: '140px' }}>Аналог</th>
                <th style={{ width: '140px' }}>Итого</th>
              </tr>
            </thead>
            <tbody>
              {sections.map(sec => (
                <tr key={sec.name} style={{ cursor: 'pointer' }} onClick={() => setSectionFilter(prev => prev === sec.name ? 'all' : sec.name)}>
                  <td>{sec.name}{sectionFilter === sec.name && ' ✓'}</td>
                  <td>{sec.itemCount}</td>
                  <td>{sec.matchedCount}</td>
                  <td>{sec.originalSubtotal > 0 ? sec.originalSubtotal.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) : '—'}</td>
                  <td style={{ color: sec.analogSubtotal > 0 ? '#b35c00' : undefined }}>
                    {sec.analogSubtotal > 0 ? sec.analogSubtotal.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) : '—'}
                  </td>
                  <td style={{ fontWeight: 600 }}>{sec.subtotal.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
              <tr className="grand-total-row">
                <td colSpan={3} style={{ fontWeight: 700, textAlign: 'right' }}>ОБЩИЙ ИТОГ:</td>
                <td style={{ fontWeight: 700 }}>{originalGrandTotal.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}</td>
                <td style={{ fontWeight: 700, color: analogGrandTotal > 0 ? '#b35c00' : undefined }}>
                  {analogGrandTotal > 0 ? analogGrandTotal.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) : '—'}
                </td>
                <td style={{ fontWeight: 700 }}>{grandTotal.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Search + section filter */}
      {items.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input
            type="text"
            placeholder="Поиск по наименованию..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ flex: 1, padding: '0.4rem 0.6rem', width: 'auto' }}
          />
          <select
            value={sectionFilter}
            onChange={e => setSectionFilter(e.target.value)}
            style={{ padding: '0.4rem 0.6rem' }}
          >
            <option value="all">Все разделы ({filteredItems.length})</option>
            {availableSections.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {(searchQuery || sectionFilter !== 'all') && (
            <button className="btn btn-secondary btn-sm" onClick={() => { setSearchQuery(''); setSectionFilter('all'); }}>
              Сбросить
            </button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <p className="muted">Нет данных для сопоставления. Загрузите спецификацию и счета, затем запустите сопоставление.</p>
      ) : filteredItems.length === 0 ? (
        <p className="muted">По выбранному фильтру позиций не найдено.</p>
      ) : (
        <MatchTable groupedItems={groupedItems} onRefresh={handleRefresh} onManualMatch={setManualMatchSpec} />
      )}

      {/* Unmatched invoice items section */}
      <div style={{ marginTop: '2rem' }}>
        <button
          className="btn btn-secondary"
          onClick={() => {
            if (!showUnmatched) loadUnmatchedInvoices();
            setShowUnmatched(!showUnmatched);
          }}
        >
          {showUnmatched ? 'Скрыть несопоставленные счета' : 'Несопоставленные счета'}
        </button>

        {showUnmatched && (() => {
          const suppliers = [...new Set(unmatchedInvoiceItems.map(i => i.supplier_name || '—'))].sort();
          const filtered = unmatchedInvoiceItems.filter(item => {
            const matchesSearch = !unmatchedSearch ||
              item.name.toLowerCase().includes(unmatchedSearch.toLowerCase()) ||
              (item.article && item.article.toLowerCase().includes(unmatchedSearch.toLowerCase()));
            const matchesSupplier = unmatchedSupplierFilter === 'all' ||
              (item.supplier_name || '—') === unmatchedSupplierFilter;
            return matchesSearch && matchesSupplier;
          });

          return (
            <div style={{ marginTop: '1rem' }}>
              <h3>Позиции счетов без сопоставления ({unmatchedInvoiceItems.length})</h3>
              {unmatchedInvoiceItems.length === 0 ? (
                <p className="muted">Все позиции счетов сопоставлены.</p>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <input
                      type="text"
                      placeholder="Поиск по названию..."
                      value={unmatchedSearch}
                      onChange={e => setUnmatchedSearch(e.target.value)}
                      style={{ flex: 1, padding: '0.4rem 0.6rem', width: 'auto' }}
                    />
                    <select
                      value={unmatchedSupplierFilter}
                      onChange={e => setUnmatchedSupplierFilter(e.target.value)}
                      style={{ padding: '0.4rem 0.6rem' }}
                    >
                      <option value="all">Все поставщики ({unmatchedInvoiceItems.length})</option>
                      {suppliers.map(s => (
                        <option key={s} value={s}>
                          {s} ({unmatchedInvoiceItems.filter(i => (i.supplier_name || '—') === s).length})
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                    Показано: {filtered.length} из {unmatchedInvoiceItems.length}
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>Наименование</th>
                        <th style={{ width: '120px' }}>Поставщик</th>
                        <th style={{ width: '60px' }}>Ед.</th>
                        <th style={{ width: '70px' }}>Цена</th>
                        <th style={{ width: '90px' }}>Сумма</th>
                        <th style={{ width: '100px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(item => (
                        <tr key={item.id}>
                          <td>
                            {item.name}
                            {item.article && <div className="muted" style={{ fontSize: '0.75rem' }}>Арт: {item.article}</div>}
                          </td>
                          <td>{item.supplier_name || '—'}</td>
                          <td>{item.unit || '—'}</td>
                          <td>{item.price != null ? item.price.toLocaleString('ru-RU') : '—'}</td>
                          <td>{item.amount != null ? item.amount.toLocaleString('ru-RU') : '—'}</td>
                          <td>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => setSelectedInvoiceItem(item)}
                            >
                              Сопоставить
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          );
        })()}
      </div>

      {/* Modal: spec item -> search invoice items */}
      {manualMatchSpec && (
        <ManualMatchFromSpec
          projectId={projectId}
          specItem={manualMatchSpec}
          onClose={() => setManualMatchSpec(null)}
          onMatched={() => {
            setManualMatchSpec(null);
            handleRefresh();
          }}
        />
      )}

      {/* Modal: invoice item -> search spec items */}
      {selectedInvoiceItem && (
        <ManualMatchModal
          projectId={projectId}
          invoiceItem={{
            id: selectedInvoiceItem.id,
            name: selectedInvoiceItem.name,
            article: selectedInvoiceItem.article,
            unit: selectedInvoiceItem.unit,
            quantity: selectedInvoiceItem.quantity,
            price: selectedInvoiceItem.price,
            supplierName: selectedInvoiceItem.supplier_name,
          }}
          onClose={() => setSelectedInvoiceItem(null)}
          onMatched={() => {
            setSelectedInvoiceItem(null);
            handleRefresh();
          }}
        />
      )}
      {/* Modal: error report */}
      {errorReportOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: '8px', padding: '1.5rem', width: '480px', maxWidth: '90vw' }}>
            <h3 style={{ margin: '0 0 0.75rem' }}>⚠ Замечание к системе</h3>
            <p style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '0.75rem' }}>
              Опишите ошибку, недостаток или пожелание. Замечание сохранится в журнале обучения.
            </p>
            <textarea
              value={errorReportText}
              onChange={e => setErrorReportText(e.target.value)}
              placeholder="Например: система предлагает задвижки к трубам, это неверно..."
              style={{ width: '100%', minHeight: '100px', padding: '0.5rem', borderRadius: '4px', border: '1px solid #d1d5db', fontSize: '0.9rem', boxSizing: 'border-box' }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
              <button className="btn btn-secondary" onClick={() => { setErrorReportOpen(false); setErrorReportText(''); }}>
                Отмена
              </button>
              <button className="btn btn-primary" onClick={handleSubmitErrorReport} disabled={submittingReport || !errorReportText.trim()}>
                {submittingReport ? 'Отправка...' : 'Отправить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
