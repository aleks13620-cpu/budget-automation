import { useState } from 'react';
import { api } from '../api';

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

interface Props {
  items: MatchRow[];
  onRefresh: () => void;
}

const MATCH_TYPE_LABELS: Record<string, string> = {
  exact_article: 'Артикул',
  learned_rule: 'Правило',
  name_similarity: 'Название',
  name_characteristics: 'Название+хар.',
};

export function MatchTable({ items, onRefresh }: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loading, setLoading] = useState<number | null>(null);

  const handleConfirm = async (matchId: number) => {
    setLoading(matchId);
    try {
      await api.put(`/matching/${matchId}/confirm`);
      onRefresh();
    } catch {
      // ignore
    } finally {
      setLoading(null);
    }
  };

  const handleReject = async (matchId: number) => {
    setLoading(matchId);
    try {
      await api.delete(`/matching/${matchId}`);
      onRefresh();
    } catch {
      // ignore
    } finally {
      setLoading(null);
    }
  };

  const toggleExpand = (specId: number) => {
    setExpandedId(prev => prev === specId ? null : specId);
  };

  const getRowClass = (row: MatchRow): string => {
    if (row.matches.some(m => m.isConfirmed)) return 'match-row-confirmed';
    if (row.matches.length > 0) return 'match-row-candidate';
    return 'match-row-unmatched';
  };

  const getBestMatch = (row: MatchRow): MatchItem | null => {
    return row.matches.find(m => m.isSelected) || row.matches[0] || null;
  };

  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: '30%' }}>Спецификация</th>
          <th style={{ width: '25%' }}>Лучший матч</th>
          <th>Поставщик</th>
          <th>Цена</th>
          <th style={{ width: '80px' }}>Точность</th>
          <th style={{ width: '150px' }}>Действия</th>
        </tr>
      </thead>
      <tbody>
        {items.map(row => {
          const best = getBestMatch(row);
          const isExpanded = expandedId === row.specItem.id;
          const hasMultiple = row.matches.length > 1;

          return (
            <tr key={row.specItem.id} className={getRowClass(row)}>
              <td colSpan={6} style={{ padding: 0 }}>
                {/* Main row */}
                <div style={{ display: 'flex', alignItems: 'center', padding: '0.5rem 0.75rem' }}>
                  <div style={{ flex: '0 0 30%', paddingRight: '0.75rem' }}>
                    <div>{row.specItem.name}</div>
                    {row.specItem.section && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>{row.specItem.section}</div>
                    )}
                  </div>
                  <div style={{ flex: '0 0 25%', paddingRight: '0.75rem' }}>
                    {best ? (
                      <>
                        <div>{best.invoiceName}</div>
                        {best.article && <div className="muted" style={{ fontSize: '0.75rem' }}>Арт: {best.article}</div>}
                      </>
                    ) : (
                      <span className="muted">Нет совпадений</span>
                    )}
                  </div>
                  <div style={{ flex: 1, paddingRight: '0.75rem' }}>
                    {best?.supplierName || '—'}
                  </div>
                  <div style={{ flex: 1, paddingRight: '0.75rem' }}>
                    {best?.price != null ? best.price.toLocaleString('ru-RU') : '—'}
                  </div>
                  <div style={{ flex: '0 0 80px', paddingRight: '0.75rem' }}>
                    {best && (
                      <span className="confidence-badge" title={MATCH_TYPE_LABELS[best.matchType] || best.matchType}>
                        {Math.round(best.confidence * 100)}%
                      </span>
                    )}
                  </div>
                  <div style={{ flex: '0 0 150px', display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                    {best && !best.isConfirmed && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleConfirm(best.id)}
                        disabled={loading === best.id}
                      >
                        OK
                      </button>
                    )}
                    {best && !best.isConfirmed && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleReject(best.id)}
                        disabled={loading === best.id}
                      >
                        X
                      </button>
                    )}
                    {best?.isConfirmed && (
                      <span className="muted" style={{ fontSize: '0.75rem' }}>Подтверждено</span>
                    )}
                    {hasMultiple && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => toggleExpand(row.specItem.id)}
                      >
                        {isExpanded ? '▲' : '▼'} {row.matches.length}
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded candidates */}
                {isExpanded && (
                  <div className="match-candidates">
                    {row.matches.map(m => (
                      <div key={m.id} className={`match-candidate-row ${m.isConfirmed ? 'confirmed' : ''}`}>
                        <div style={{ flex: '0 0 30%' }}></div>
                        <div style={{ flex: '0 0 25%', paddingRight: '0.75rem' }}>
                          {m.invoiceName}
                          {m.article && <span className="muted" style={{ fontSize: '0.75rem' }}> (Арт: {m.article})</span>}
                        </div>
                        <div style={{ flex: 1 }}>{m.supplierName || '—'}</div>
                        <div style={{ flex: 1 }}>{m.price != null ? m.price.toLocaleString('ru-RU') : '—'}</div>
                        <div style={{ flex: '0 0 80px' }}>
                          <span className="confidence-badge" title={MATCH_TYPE_LABELS[m.matchType] || m.matchType}>
                            {Math.round(m.confidence * 100)}%
                          </span>
                        </div>
                        <div style={{ flex: '0 0 150px', display: 'flex', gap: '0.25rem' }}>
                          {!m.isConfirmed && (
                            <>
                              <button className="btn btn-primary btn-sm" onClick={() => handleConfirm(m.id)} disabled={loading === m.id}>OK</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => handleReject(m.id)} disabled={loading === m.id}>X</button>
                            </>
                          )}
                          {m.isConfirmed && <span className="muted" style={{ fontSize: '0.75rem' }}>Подтверждено</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
