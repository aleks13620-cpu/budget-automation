import { useState, useEffect } from 'react';
import { api } from '../api';

interface SpecItemInfo {
  id: number;
  name: string;
  characteristics: string | null;
  unit: string | null;
  quantity: number | null;
  section: string | null;
}

interface InvoiceSearchResult {
  id: number;
  name: string;
  article: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  supplier_name: string | null;
  score: number;
}

interface Props {
  projectId: number;
  specItem: SpecItemInfo;
  onClose: () => void;
  onMatched: () => void;
}

export function ManualMatchFromSpec({ projectId, specItem, onClose, onMatched }: Props) {
  const [query, setQuery] = useState(specItem.name.slice(0, 40));
  const [results, setResults] = useState<InvoiceSearchResult[]>([]);
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
      const { data } = await api.get(`/projects/${projectId}/invoice-items/search`, {
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

  const handleMatch = async (invoiceItemId: number) => {
    setMatching(invoiceItemId);
    setError(null);
    try {
      await api.post(`/projects/${projectId}/manual-match`, {
        specItemId: specItem.id,
        invoiceItemId,
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
          <h3 style={{ margin: 0 }}>Поиск в счетах</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>X</button>
        </div>

        <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '4px', marginBottom: '1rem' }}>
          <div style={{ fontWeight: 600 }}>Позиция спецификации:</div>
          <div>{specItem.name}</div>
          {specItem.characteristics && <div className="muted">{specItem.characteristics}</div>}
          <div className="muted">
            {specItem.section || '—'} | {specItem.unit || '—'} | Кол-во: {specItem.quantity ?? '—'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Поиск по счетам..."
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
                <th style={{ width: '100px' }}>Поставщик</th>
                <th style={{ width: '60px' }}>Ед.</th>
                <th style={{ width: '70px' }}>Цена</th>
                <th style={{ width: '60px' }}>Сходство</th>
                <th style={{ width: '80px' }}></th>
              </tr>
            </thead>
            <tbody>
              {results.map(item => (
                <tr key={item.id}>
                  <td>
                    {item.name}
                    {item.article && <div className="muted" style={{ fontSize: '0.75rem' }}>Арт: {item.article}</div>}
                  </td>
                  <td>{item.supplier_name || '—'}</td>
                  <td>{item.unit || '—'}</td>
                  <td>{item.price != null ? item.price.toLocaleString('ru-RU') : '—'}</td>
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
