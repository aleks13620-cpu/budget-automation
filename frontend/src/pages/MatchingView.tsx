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

interface Props {
  projectId: number;
  onBack: () => void;
}

export function MatchingView({ projectId, onBack }: Props) {
  const [items, setItems] = useState<MatchRow[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, matched: 0, confirmed: 0, unmatched: 0 });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

  useEffect(() => { loadMatching(); }, [projectId]);

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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Сопоставление позиций</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={onBack}>Назад</button>
          <button className="btn btn-primary" onClick={handleRun} disabled={running}>
            {running ? 'Сопоставление...' : 'Запустить сопоставление'}
          </button>
        </div>
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

      {items.length === 0 ? (
        <p className="muted">Нет данных для сопоставления. Загрузите спецификацию и счета, затем запустите сопоставление.</p>
      ) : (
        <MatchTable items={items} onRefresh={loadMatching} />
      )}
    </div>
  );
}
