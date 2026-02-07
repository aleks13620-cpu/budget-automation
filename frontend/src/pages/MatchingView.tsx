import { useState, useEffect } from 'react';
import { api } from '../api';
import { MatchTable } from '../components/MatchTable';

interface MatchItem {
  id: number;
  invoiceItemId: number;
  invoiceName: string;
  article: string | null;
  supplierName: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
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

type FilterStatus = 'all' | 'confirmed' | 'pending' | 'unmatched';

export function MatchingView({ projectId, onBack }: Props) {
  const [items, setItems] = useState<MatchRow[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, matched: 0, confirmed: 0, unmatched: 0 });
  const [sections, setSections] = useState<SectionSummary[]>([]);
  const [grandTotal, setGrandTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');

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

  useEffect(() => { loadMatching(); loadSummary(); }, [projectId]);

  const handleRefresh = () => {
    loadMatching();
    loadSummary();
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

  if (loading) return <p className="loading">Загрузка...</p>;

  // Filter items based on status
  const filteredItems = items.filter(row => {
    const hasConfirmed = row.matches.some(m => m.isConfirmed);
    const hasMatches = row.matches.length > 0;

    if (filterStatus === 'confirmed') return hasConfirmed;
    if (filterStatus === 'pending') return hasMatches && !hasConfirmed;
    if (filterStatus === 'unmatched') return !hasMatches;
    return true; // 'all'
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Сопоставление позиций</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={onBack}>Назад</button>
          <button className="btn btn-primary" onClick={handleRun} disabled={running}>
            {running ? 'Сопоставление...' : 'Запустить сопоставление'}
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

      {message && (
        <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>
          {message.text}
        </p>
      )}

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
                <tr key={sec.name}>
                  <td>{sec.name}</td>
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

      {items.length === 0 ? (
        <p className="muted">Нет данных для сопоставления. Загрузите спецификацию и счета, затем запустите сопоставление.</p>
      ) : filteredItems.length === 0 ? (
        <p className="muted">По выбранному фильтру позиций не найдено.</p>
      ) : (
        <MatchTable items={filteredItems} onRefresh={handleRefresh} />
      )}
    </div>
  );
}
