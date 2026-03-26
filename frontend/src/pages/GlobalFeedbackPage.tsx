import { useState, useEffect } from 'react';
import { api } from '../api';

interface GlobalItem {
  id: number;
  comment: string | null;
  status: string;
  created_at: string;
  project_id: number;
  project_name: string | null;
  spec_name: string | null;
}

interface Props {
  onBack: () => void;
  onGoToProject: (id: number, name: string) => void;
}

type StatusFilter = 'all' | 'new' | 'resolved';

export function GlobalFeedbackPage({ onBack, onGoToProject }: Props) {
  const [items, setItems] = useState<GlobalItem[]>([]);
  const [total, setTotal] = useState(0);
  const [newCount, setNewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('new');
  const [resolving, setResolving] = useState<number | null>(null);

  const load = (status: StatusFilter) => {
    setLoading(true);
    const q = status !== 'all' ? `?status=${status}` : '';
    api.get(`/feedback/all${q}`)
      .then(({ data }) => {
        setItems(data.items || []);
        setTotal(data.total || 0);
        setNewCount(data.newCount || 0);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const handleResolve = async (id: number) => {
    setResolving(id);
    try {
      await api.patch(`/feedback/${id}/resolve`);
      setItems(prev => prev.map(i => i.id === id ? { ...i, status: 'resolved' } : i));
      setNewCount(prev => Math.max(0, prev - 1));
    } finally {
      setResolving(null);
    }
  };

  const handleExport = () => {
    window.open(`/api/feedback/export`, '_blank');
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>
          Все замечания
          {newCount > 0 && (
            <span style={{ marginLeft: '0.75rem', background: '#d97706', color: '#fff', borderRadius: '12px', padding: '0.15rem 0.6rem', fontSize: '0.8rem', fontWeight: 600 }}>
              {newCount} новых
            </span>
          )}
        </h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={handleExport}>⬇ Экспорт Excel</button>
          <button className="btn btn-secondary" onClick={onBack}>Назад</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1rem', borderBottom: '1px solid #e5e7eb', paddingBottom: '0.5rem' }}>
        {([
          { key: 'new', label: `Новые (${newCount})`, highlight: true },
          { key: 'all', label: `Все (${total})` },
          { key: 'resolved', label: 'Разобранные' },
        ] as { key: StatusFilter; label: string; highlight?: boolean }[]).map(t => (
          <button
            key={t.key}
            onClick={() => setStatusFilter(t.key)}
            style={{
              padding: '0.35rem 0.75rem',
              borderRadius: '4px',
              border: statusFilter === t.key ? '2px solid #3b82f6' : '1px solid #d1d5db',
              background: statusFilter === t.key ? '#eff6ff' : '#fff',
              fontWeight: statusFilter === t.key ? 600 : 400,
              fontSize: '0.85rem',
              cursor: 'pointer',
              color: t.highlight && t.key === 'new' && newCount > 0 && statusFilter !== 'new' ? '#d97706' : undefined,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="loading">Загрузка...</p>
      ) : items.length === 0 ? (
        <p className="muted">Замечаний нет.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: '160px' }}>Проект</th>
              <th>Замечание</th>
              <th>Позиция</th>
              <th style={{ width: '130px' }}>Дата</th>
              <th style={{ width: '110px' }}>Статус</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} style={{ background: item.status !== 'resolved' ? '#fffbeb' : undefined }}>
                <td style={{ fontSize: '0.85rem' }}>
                  {item.project_name ? (
                    <button
                      style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', padding: 0, fontSize: '0.85rem', textAlign: 'left' }}
                      onClick={() => onGoToProject(item.project_id, item.project_name!)}
                    >
                      {item.project_name}
                    </button>
                  ) : '—'}
                </td>
                <td style={{ fontSize: '0.85rem' }}>{item.comment || '—'}</td>
                <td style={{ fontSize: '0.85rem', color: '#6b7280' }}>{item.spec_name || '—'}</td>
                <td style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
                  {new Date(item.created_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                </td>
                <td>
                  {item.status === 'resolved'
                    ? <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>✓ Разобрано</span>
                    : <button
                        className="btn btn-secondary btn-sm"
                        style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                        disabled={resolving === item.id}
                        onClick={() => handleResolve(item.id)}
                      >
                        {resolving === item.id ? '...' : '✓ Разобрано'}
                      </button>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
