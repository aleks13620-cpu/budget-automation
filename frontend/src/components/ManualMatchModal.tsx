import { useState, useEffect } from 'react';
import { api } from '../api';

interface InvoiceItemInfo {
  id: number;
  name: string;
  article: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  supplierName: string | null;
}

interface SpecSearchResult {
  id: number;
  name: string;
  characteristics: string | null;
  unit: string | null;
  quantity: number | null;
  section: string | null;
  score: number;
}

interface Props {
  projectId: number;
  invoiceItem: InvoiceItemInfo;
  onClose: () => void;
  onMatched: () => void;
}

export function ManualMatchModal({ projectId, invoiceItem, onClose, onMatched }: Props) {
  const [query, setQuery] = useState(invoiceItem.name.slice(0, 40));
  const [results, setResults] = useState<SpecSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [matching, setMatching] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doSearch = async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const { data } = await api.get(`/projects/${projectId}/spec-items/search`, {
        params: { q: q.trim() },
      });
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    doSearch(query);
  }, []);

  const handleSearch = () => {
    doSearch(query);
  };

  const handleMatch = async (specItemId: number) => {
    setMatching(specItemId);
    setError(null);
    try {
      await api.post(`/projects/${projectId}/manual-match`, {
        specItemId,
        invoiceItemId: invoiceItem.id,
      });
      onMatched();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка при сопоставлении');
    } finally {
      setMatching(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>Ручное сопоставление</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>X</button>
        </div>

        <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '4px', marginBottom: '1rem' }}>
          <div style={{ fontWeight: 600 }}>Позиция из счёта:</div>
          <div>{invoiceItem.name}</div>
          {invoiceItem.article && <div className="muted">Арт: {invoiceItem.article}</div>}
          <div className="muted">
            {invoiceItem.supplierName || '—'} | {invoiceItem.price != null ? `${invoiceItem.price.toLocaleString('ru-RU')} р.` : '—'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Поиск по спецификации..."
            style={{ flex: 1, padding: '0.5rem' }}
          />
          <button className="btn btn-primary btn-sm" onClick={handleSearch} disabled={searching}>
            {searching ? '...' : 'Найти'}
          </button>
        </div>

        {error && <p className="error-msg">{error}</p>}

        {results.length === 0 && !searching ? (
          <p className="muted">Нет результатов. Попробуйте другой запрос.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Наименование</th>
                <th style={{ width: '80px' }}>Раздел</th>
                <th style={{ width: '60px' }}>Ед.</th>
                <th style={{ width: '60px' }}>Кол-во</th>
                <th style={{ width: '60px' }}>Сходство</th>
                <th style={{ width: '80px' }}></th>
              </tr>
            </thead>
            <tbody>
              {results.map(item => (
                <tr key={item.id}>
                  <td>
                    {item.name}
                    {item.characteristics && <div className="muted" style={{ fontSize: '0.75rem' }}>{item.characteristics}</div>}
                  </td>
                  <td>{item.section || '—'}</td>
                  <td>{item.unit || '—'}</td>
                  <td>{item.quantity ?? '—'}</td>
                  <td>{Math.round(item.score * 100)}%</td>
                  <td>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleMatch(item.id)}
                      disabled={matching === item.id}
                    >
                      {matching === item.id ? '...' : 'Связать'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
