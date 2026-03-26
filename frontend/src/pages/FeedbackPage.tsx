import { useState, useEffect } from 'react';
import { api } from '../api';

interface FeedbackItem {
  id: number;
  type: string;
  spec_name: string | null;
  invoice_name: string;
  comment: string | null;
  status: string;
  created_at: string;
}

interface Props {
  projectId: number;
  onBack: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  confirm: '✅ Подтверждён',
  reject: '❌ Отклонён',
  manual_select: '✋ Вручную',
  error_report: '⚠ Ошибка',
};

type TabFilter = 'all' | 'errors' | 'new_errors';

export function FeedbackPage({ projectId, onBack }: Props) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabFilter>('all');
  const [resolving, setResolving] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    api.get(`/projects/${projectId}/feedback`)
      .then(({ data }) => {
        setItems(data.items || []);
        setCounts(data.counts || {});
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [projectId]);

  const handleResolve = async (id: number) => {
    setResolving(id);
    try {
      await api.patch(`/feedback/${id}/resolve`);
      setItems(prev => prev.map(i => i.id === id ? { ...i, status: 'resolved' } : i));
    } finally {
      setResolving(null);
    }
  };

  const handleExport = () => {
    window.open(`/api/feedback/export`, '_blank');
  };

  const filtered = items.filter(i => {
    if (tab === 'errors') return i.type === 'error_report';
    if (tab === 'new_errors') return i.type === 'error_report' && i.status !== 'resolved';
    return true;
  });

  const newErrorsCount = items.filter(i => i.type === 'error_report' && i.status !== 'resolved').length;

  if (loading) return <p className="loading">Загрузка...</p>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Обратная связь оператора</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={handleExport}>⬇ Экспорт Excel</button>
          <button className="btn btn-secondary" onClick={onBack}>Назад</button>
        </div>
      </div>

      {/* Summary counts */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {Object.entries(counts).map(([type, cnt]) => (
          <div key={type} style={{ padding: '0.5rem 1rem', background: '#f3f4f6', borderRadius: '6px', fontSize: '0.85rem' }}>
            <span style={{ fontWeight: 600 }}>{TYPE_LABELS[type] ?? type}</span>
            <span style={{ marginLeft: '0.5rem', color: '#6b7280' }}>{cnt}</span>
          </div>
        ))}
        {Object.keys(counts).length === 0 && <p className="muted">Сигналов пока нет</p>}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1rem', borderBottom: '1px solid #e5e7eb', paddingBottom: '0.5rem' }}>
        {([
          { key: 'all', label: `Все (${items.length})` },
          { key: 'errors', label: `Замечания (${items.filter(i => i.type === 'error_report').length})` },
          { key: 'new_errors', label: `Новые ⚠ (${newErrorsCount})`, highlight: newErrorsCount > 0 },
        ] as { key: TabFilter; label: string; highlight?: boolean }[]).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '0.35rem 0.75rem',
              borderRadius: '4px',
              border: tab === t.key ? '2px solid #3b82f6' : '1px solid #d1d5db',
              background: tab === t.key ? '#eff6ff' : '#fff',
              fontWeight: tab === t.key ? 600 : 400,
              fontSize: '0.85rem',
              cursor: 'pointer',
              color: t.highlight && tab !== t.key ? '#d97706' : undefined,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="muted">Нет записей в этой категории.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: '130px' }}>Действие</th>
              <th>Спецификация</th>
              <th>Счёт / Замечание</th>
              <th style={{ width: '130px' }}>Дата</th>
              {(tab === 'errors' || tab === 'new_errors') && <th style={{ width: '110px' }}>Статус</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map(item => (
              <tr key={item.id} style={{ background: item.type === 'error_report' && item.status !== 'resolved' ? '#fffbeb' : undefined }}>
                <td>
                  <span style={{
                    fontSize: '0.8rem', fontWeight: 600,
                    color: item.type === 'confirm' ? '#16a34a' : item.type === 'reject' ? '#dc2626' : item.type === 'error_report' ? '#d97706' : '#6b7280',
                  }}>
                    {TYPE_LABELS[item.type] ?? item.type}
                  </span>
                </td>
                <td style={{ fontSize: '0.85rem' }}>{item.spec_name || '—'}</td>
                <td style={{ fontSize: '0.85rem' }}>{item.comment || item.invoice_name || '—'}</td>
                <td style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
                  {new Date(item.created_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                </td>
                {(tab === 'errors' || tab === 'new_errors') && (
                  <td>
                    {item.type === 'error_report' && (
                      item.status === 'resolved'
                        ? <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>✓ Разобрано</span>
                        : <button
                            className="btn btn-secondary btn-sm"
                            style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                            disabled={resolving === item.id}
                            onClick={() => handleResolve(item.id)}
                          >
                            {resolving === item.id ? '...' : '✓ Разобрано'}
                          </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
