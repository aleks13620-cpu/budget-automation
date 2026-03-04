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
}

interface SpecItem {
  id: number;
  name: string;
  characteristics: string | null;
  equipment_code: string | null;
  unit: string | null;
  quantity: number | null;
  section: string | null;
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
}

interface SectionSummary {
  name: string;
  itemCount: number;
  matchedCount: number;
  subtotal: number;
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
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runningIncremental, setRunningIncremental] = useState(false);
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

  const loadMatching = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/projects/${projectId}/matching`);
      setItems(data.items || []);
      setSummary(data.summary || { total: 0, matched: 0, confirmed: 0, unmatched: 0 });
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const loadSummary = async () => {
    try {
      const { data } = await api.get(`/projects/${projectId}/summary`);
      setSections(data.sections || []);
      setGrandTotal(data.grandTotal || 0);
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

  useEffect(() => { loadMatching(); loadSummary(); }, [projectId]);

  const handleRefresh = () => {
    loadMatching();
    loadSummary();
    if (showUnmatched) loadUnmatchedInvoices();
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const response = await api.get(`/projects/${projectId}/export`, { responseType: 'blob' });
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
      const invoiceMatch = row.matches.some(m => m.invoiceName.toLowerCase().includes(q) || m.article?.toLowerCase().includes(q));
      if (!nameMatch && !charMatch && !invoiceMatch) return false;
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
          className={`btn ${filterStatus === 'all' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          onClick={() => setFilterStatus('all')}
        >
          📋 Все ({items.length})
        </button>
        <button
          className={`btn ${filterStatus === 'confirmed' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          onClick={() => setFilterStatus('confirmed')}
        >
          ✅ Подтверждённые ({summary.confirmed})
        </button>
        <button
          className={`btn ${filterStatus === 'pending' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
          onClick={() => setFilterStatus('pending')}
        >
          ⚠️ Требуют проверки ({summary.matched - summary.confirmed})
        </button>
        <button
          className={`btn ${filterStatus === 'unmatched' ? 'btn-primary' : 'btn-secondary'} btn-sm`}
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

      {/* Section totals */}
      {sections.length > 0 && (
        <div className="section-summary">
          <h3>Итоги по разделам</h3>
          <table>
            <thead>
              <tr>
                <th>Раздел</th>
                <th style={{ width: '80px' }}>Позиций</th>
                <th style={{ width: '100px' }}>С ценой</th>
                <th style={{ width: '140px' }}>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {sections.map(sec => (
                <tr key={sec.name} style={{ cursor: 'pointer' }} onClick={() => setSectionFilter(prev => prev === sec.name ? 'all' : sec.name)}>
                  <td>{sec.name}{sectionFilter === sec.name && ' ✓'}</td>
                  <td>{sec.itemCount}</td>
                  <td>{sec.matchedCount}</td>
                  <td style={{ fontWeight: 600 }}>{sec.subtotal.toLocaleString('ru-RU', { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
              <tr className="grand-total-row">
                <td colSpan={3} style={{ fontWeight: 700, textAlign: 'right' }}>ОБЩИЙ ИТОГ:</td>
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
    </div>
  );
}
