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
  score: number | null;
  invoice_file_name: string | null;
}

interface Supplier {
  id: number;
  name: string;
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
  const [searchMode, setSearchMode] = useState<'similarity' | 'like'>('similarity');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplier, setSelectedSupplier] = useState<number | null>(null);
  const [supplierFilter, setSupplierFilter] = useState('');
  const [showSupplierDropdown, setShowSupplierDropdown] = useState(false);

  useEffect(() => {
    api.get(`/projects/${projectId}/suppliers`)
      .then(({ data }) => setSuppliers(data.suppliers || []))
      .catch(() => {});
  }, [projectId]);

  const doSearch = async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const { data } = await api.get(`/projects/${projectId}/invoice-items/search`, {
        params: {
          q: q.trim(),
          mode: searchMode,
          ...(selectedSupplier ? { supplier_id: selectedSupplier } : {}),
        },
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

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Поиск по счетам..."
            style={{ flex: 1, minWidth: '150px', padding: '0.5rem', width: 'auto' }}
          />
          <div style={{ position: 'relative', minWidth: '180px' }}>
            <input
              type="text"
              value={supplierFilter}
              onChange={e => { setSupplierFilter(e.target.value); setShowSupplierDropdown(true); }}
              onFocus={() => setShowSupplierDropdown(true)}
              onBlur={() => setTimeout(() => setShowSupplierDropdown(false), 150)}
              placeholder="Поставщик..."
              style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
            />
            {selectedSupplier && (
              <button
                onClick={() => { setSelectedSupplier(null); setSupplierFilter(''); }}
                style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#666', fontSize: '1rem' }}
              >×</button>
            )}
            {showSupplierDropdown && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ced4da', borderRadius: '0 0 4px 4px', maxHeight: '200px', overflowY: 'auto', zIndex: 100, boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
                <div
                  onMouseDown={() => { setSelectedSupplier(null); setSupplierFilter(''); setShowSupplierDropdown(false); }}
                  style={{ padding: '6px 10px', cursor: 'pointer', color: '#666', borderBottom: '1px solid #eee' }}
                >Все поставщики</div>
                {suppliers
                  .filter(s => s.name.toLowerCase().includes(supplierFilter.toLowerCase()))
                  .map(s => (
                    <div
                      key={s.id}
                      onMouseDown={() => { setSelectedSupplier(s.id); setSupplierFilter(s.name); setShowSupplierDropdown(false); }}
                      style={{ padding: '6px 10px', cursor: 'pointer', background: selectedSupplier === s.id ? '#e8f0fe' : undefined }}
                    >{s.name}</div>
                  ))
                }
                {suppliers.filter(s => s.name.toLowerCase().includes(supplierFilter.toLowerCase())).length === 0 && (
                  <div style={{ padding: '6px 10px', color: '#999' }}>Не найдено</div>
                )}
              </div>
            )}
          </div>
          <button
            className={`btn btn-sm ${searchMode === 'like' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSearchMode(prev => prev === 'similarity' ? 'like' : 'similarity')}
            title="Переключить режим поиска"
          >
            {searchMode === 'similarity' ? 'Похожие' : 'Точный'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSearch} disabled={searching}>
            {searching ? '...' : 'Найти'}
          </button>
        </div>

        {error && <p className="error-msg">{error}</p>}

        {results.length === 0 && !searching ? (
          <p className="muted">Нет результатов. Попробуйте другой запрос или переключите режим поиска.</p>
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
                    {item.invoice_file_name && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        Счёт: {item.invoice_file_name}
                      </div>
                    )}
                  </td>
                  <td>{item.supplier_name || '—'}</td>
                  <td>{item.unit || '—'}</td>
                  <td>{item.price != null ? item.price.toLocaleString('ru-RU') : '—'}</td>
                  <td>{item.score != null ? `${Math.round(item.score * 100)}%` : '—'}</td>
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
