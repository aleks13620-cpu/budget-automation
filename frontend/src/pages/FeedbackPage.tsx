import { useState, useEffect } from 'react';
import { api } from '../api';

interface FeedbackItem {
  id: number;
  type: string;
  spec_name: string | null;
  invoice_name: string;
  comment: string | null;
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

export function FeedbackPage({ projectId, onBack }: Props) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/projects/${projectId}/feedback`)
      .then(({ data }) => {
        setItems(data.items || []);
        setCounts(data.counts || {});
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <p className="loading">Загрузка...</p>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Обратная связь оператора</h2>
        <button className="btn btn-secondary" onClick={onBack}>Назад</button>
      </div>

      {/* Summary counts */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        {Object.entries(counts).map(([type, cnt]) => (
          <div key={type} style={{ padding: '0.5rem 1rem', background: '#f3f4f6', borderRadius: '6px', fontSize: '0.85rem' }}>
            <span style={{ fontWeight: 600 }}>{TYPE_LABELS[type] ?? type}</span>
            <span style={{ marginLeft: '0.5rem', color: '#6b7280' }}>{cnt}</span>
          </div>
        ))}
        {Object.keys(counts).length === 0 && (
          <p className="muted">Сигналов пока нет</p>
        )}
      </div>

      {items.length === 0 ? (
        <p className="muted">Нет записанных действий оператора для этого проекта.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: '140px' }}>Действие</th>
              <th>Спецификация</th>
              <th>Счёт / Замечание</th>
              <th style={{ width: '140px' }}>Дата</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id}>
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
