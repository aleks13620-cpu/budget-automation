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
  effectivePrice: number | null;
  amount: number | null;
  confidence: number;
  matchType: string;
  matchReason: string;
  isConfirmed: boolean;
  isSelected: boolean;
  isAnalog: boolean;
}

interface SpecItem {
  id: number;
  name: string;
  characteristics: string | null;
  equipment_code: string | null;
  unit: string | null;
  quantity: number | null;
  section: string | null;
  parentItemId?: number | null;
  fullName?: string | null;
}

interface MatchRow {
  specItem: SpecItem;
  matches: MatchItem[];
}

interface SectionGroup {
  section: string;
  rows: MatchRow[];
}

interface Props {
  groupedItems: SectionGroup[];
  onRefresh: () => void;
  onManualMatch?: (specItem: SpecItem) => void;
  projectId?: number;
}

const MATCH_TYPE_LABELS: Record<string, string> = {
  exact_article: 'Артикул',
  learned_rule: 'Правило',
  name_similarity: 'Название',
  name_characteristics: 'Название+хар.',
};

// Quick-tags for one-click operator feedback (carry-task #17).
// Each tag is sent to POST /api/projects/:id/feedback/tag.
const QUICK_TAGS: Array<{ id: string; icon: string; label: string }> = [
  { id: 'price_wrong', icon: '💰', label: 'Цена не та' },
  { id: 'wrong_marking', icon: '🔖', label: 'Не та маркировка' },
  { id: 'needs_alternatives', icon: '🔀', label: 'Нужны альтернативы' },
  { id: 'duplicate', icon: '📑', label: 'Дубль' },
  { id: 'not_purchased', icon: '🚫', label: 'Не покупали' },
  { id: 'analog_brand', icon: '≈', label: 'Аналог другого бренда' },
  { id: 'parser_missed', icon: '🐛', label: 'Парсер пропустил' },
];

const ALT_CONFIDENCE_THRESHOLD = 0.5;
const ALT_MAX = 2; // show 2 alternatives below the best (top-3 total visible)

export function MatchTable({ groupedItems, onRefresh, onManualMatch, projectId }: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedMatchIds, setSelectedMatchIds] = useState<Set<number>>(new Set());
  // Local visual state: which (specItemId, tagId) pairs have been clicked.
  // Reset on page reload — backend persists the actual feedback row.
  const [appliedTags, setAppliedTags] = useState<Set<string>>(new Set());
  const [tagLoading, setTagLoading] = useState<string | null>(null);

  const handleTag = async (specItemId: number, invoiceItemId: number | null, supplierId: number | null, tag: string) => {
    if (projectId == null) return;
    const key = `${specItemId}_${tag}`;
    setTagLoading(key);
    setActionError(null);
    try {
      await api.post(`/projects/${projectId}/feedback/tag`, {
        spec_item_id: specItemId,
        invoice_item_id: invoiceItemId,
        supplier_id: supplierId,
        tag,
      });
      setAppliedTags(prev => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    } catch {
      setActionError('Ошибка при сохранении тега');
    } finally {
      setTagLoading(null);
    }
  };

  const handleAction = async (matchId: number, action: () => Promise<void>) => {
    setLoading(matchId);
    setActionError(null);
    try {
      await action();
      onRefresh();
    } catch {
      setActionError('Ошибка при выполнении действия');
    } finally {
      setLoading(null);
    }
  };

  const handleConfirm = (matchId: number) =>
    handleAction(matchId, () => api.put(`/matching/${matchId}/confirm`));

  const handleReject = (matchId: number) =>
    handleAction(matchId, () => api.delete(`/matching/${matchId}`));

  const handleConfirmAnalog = (matchId: number) =>
    handleAction(matchId, () => api.post(`/matching/${matchId}/confirm-analog`));

  const handleSelect = (matchId: number) =>
    handleAction(matchId, () => api.put(`/matching/select/${matchId}`));

  const handleUnconfirm = (matchId: number) =>
    handleAction(matchId, () => api.put(`/matching/${matchId}/unconfirm`));

  const toggleSelected = (matchId: number) => {
    setSelectedMatchIds(prev => {
      const next = new Set(prev);
      if (next.has(matchId)) next.delete(matchId);
      else next.add(matchId);
      return next;
    });
  };

  const clearSelected = () => setSelectedMatchIds(new Set());

  const handleBulkAction = async (kind: 'confirm' | 'confirm-analog' | 'reject') => {
    if (selectedMatchIds.size === 0) return;
    setActionError(null);
    setBulkLoading(true);
    try {
      await api.post(`/matching/bulk/${kind}`, { matchIds: Array.from(selectedMatchIds) });
      clearSelected();
      onRefresh();
    } catch {
      setActionError('Ошибка при выполнении массового действия');
    } finally {
      setBulkLoading(false);
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
    <>
    {actionError && <p className="error-msg">{actionError}</p>}
    {selectedMatchIds.size > 0 && (
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span className="muted">Выбрано: {selectedMatchIds.size}</span>
        <button className="btn btn-primary btn-sm" onClick={() => handleBulkAction('confirm')} disabled={bulkLoading}>✓ Подтвердить</button>
        <button className="btn btn-secondary btn-sm" onClick={() => handleBulkAction('confirm-analog')} disabled={bulkLoading}>≈ Как аналог</button>
        <button className="btn btn-secondary btn-sm" onClick={() => handleBulkAction('reject')} disabled={bulkLoading}>✕ Отклонить</button>
        <button className="btn btn-secondary btn-sm" onClick={clearSelected} disabled={bulkLoading}>Снять выбор</button>
      </div>
    )}
    <table>
      <thead>
        <tr>
          <th style={{ width: '36px' }}></th>
          <th style={{ width: '25%' }}>Спецификация</th>
          <th style={{ width: '80px' }}>Кол-во</th>
          <th style={{ width: '22%' }}>Лучший матч</th>
          <th>Поставщик</th>
          <th style={{ width: '70px' }}>Цена</th>
          <th style={{ width: '70px' }}>Сумма</th>
          <th style={{ width: '80px' }}>Точность</th>
          <th style={{ width: '150px' }}>Действия</th>
        </tr>
      </thead>
      {groupedItems.map(group => (
        <tbody key={group.section}>
          {groupedItems.length > 1 && (
            <tr className="section-header-row">
              <td colSpan={9} style={{ background: '#f0f4f8', fontWeight: 700, padding: '0.6rem 0.75rem', fontSize: '0.95rem', borderTop: '2px solid #cbd5e1' }}>
                {group.section} ({group.rows.length})
              </td>
            </tr>
          )}
          {group.rows.map(row => {
            const best = getBestMatch(row);
            const isExpanded = expandedId === row.specItem.id;
            const hasMatches = row.matches.length > 0;

            return (
              <tr key={row.specItem.id} className={getRowClass(row)}>
                <td colSpan={9} style={{ padding: 0 }}>
                  {/* Main row */}
                  <div style={{ display: 'flex', alignItems: 'center', padding: '0.5rem 0.75rem' }}>
                    <div style={{ flex: '0 0 36px', paddingRight: '0.5rem' }}>
                      {best && !best.isConfirmed && (
                        <input
                          type="checkbox"
                          checked={selectedMatchIds.has(best.id)}
                          onChange={() => toggleSelected(best.id)}
                          title="Выбрать для массового действия"
                        />
                      )}
                    </div>
                    <div style={{ flex: '0 0 25%', paddingRight: '0.75rem', paddingLeft: row.specItem.parentItemId ? '1.5rem' : undefined }}>
                      <div>{row.specItem.fullName || row.specItem.name}</div>
                      {row.specItem.equipment_code && (
                        <div className="muted" style={{ fontSize: '0.75rem', color: '#2563eb' }}>Код: {row.specItem.equipment_code}</div>
                      )}
                      {!row.specItem.fullName && row.specItem.characteristics && (
                        <div className="muted" style={{ fontSize: '0.75rem' }}>{row.specItem.characteristics}</div>
                      )}
                    </div>
                    <div style={{ flex: '0 0 80px', paddingRight: '0.75rem' }}>
                      {row.specItem.quantity != null ? (
                        <span>{row.specItem.quantity} {row.specItem.unit || ''}</span>
                      ) : '—'}
                    </div>
                    <div style={{ flex: '0 0 22%', paddingRight: '0.75rem' }}>
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
                      {best?.effectivePrice != null ? best.effectivePrice.toLocaleString('ru-RU') : (best?.price != null ? best.price.toLocaleString('ru-RU') : '—')}
                      {best?.effectivePrice != null && best.effectivePrice !== best.price && (
                        <span className="muted" style={{ fontSize: '0.65rem', marginLeft: '2px' }}>с НДС</span>
                      )}
                    </div>
                    <div style={{ flex: 1, paddingRight: '0.75rem' }}>
                      {best?.amount != null ? best.amount.toLocaleString('ru-RU') : '—'}
                    </div>
                    <div style={{ flex: '0 0 190px', paddingRight: '0.75rem' }}>
                      {best && (
                        <>
                          <span className="confidence-badge" title={MATCH_TYPE_LABELS[best.matchType] || best.matchType}>
                            {best.matchType === 'learned_rule' && <span title="Запомнено системой">🧠 </span>}
                            {Math.round(best.confidence * 100)}%
                          </span>
                          <span style={{ fontSize: '0.75rem', color: '#888', marginLeft: 4 }}>
                            {best.matchReason}
                          </span>
                        </>
                      )}
                    </div>
                    <div style={{ flex: '0 0 150px', display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                      {best && !best.isConfirmed && (
                        <>
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleConfirm(best.id)}
                            disabled={loading === best.id}
                            title="Точное совпадение"
                          >
                            ✓
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleConfirmAnalog(best.id)}
                            disabled={loading === best.id}
                            title="Аналог"
                          >
                            ≈
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleReject(best.id)}
                            disabled={loading === best.id}
                            title="Отклонить"
                          >
                            ✕
                          </button>
                        </>
                      )}
                      {onManualMatch && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => onManualMatch(row.specItem)}
                          title="Сопоставить вручную"
                        >
                          {best ? '...' : 'Сопоставить'}
                        </button>
                      )}
                      {best?.isConfirmed && (
                        <>
                          <span className="muted" style={{ fontSize: '0.75rem' }}>Подтверждено</span>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleUnconfirm(best.id)}
                            disabled={loading === best.id}
                            title="Сбросить подтверждение"
                          >
                            ⟲
                          </button>
                        </>
                      )}
                      {hasMatches && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => toggleExpand(row.specItem.id)}
                        >
                          {isExpanded ? '▲' : '▼'} {row.matches.length}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* #14 Top-N alternatives strip (top-2 below the best, shown by default if 2+ viable cands exist) */}
                  {(() => {
                    if (!best) return null;
                    const others = row.matches
                      .filter(m => m.id !== best.id && m.confidence >= ALT_CONFIDENCE_THRESHOLD)
                      .slice(0, ALT_MAX);
                    if (others.length === 0) return null;
                    return (
                      <div style={{ borderTop: '1px dashed #d1d5db', background: '#fafbfc', padding: '0.4rem 0.75rem 0.4rem 2.75rem' }}>
                        <div style={{ fontSize: '0.7rem', color: '#6b7280', marginBottom: '0.3rem' }}>Альтернативы:</div>
                        {others.map(alt => (
                          <div key={alt.id} style={{ display: 'flex', alignItems: 'center', padding: '0.2rem 0', fontSize: '0.85rem', gap: '0.5rem' }}>
                            <span style={{ flex: '0 0 25%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alt.invoiceName}</span>
                            <span style={{ flex: '0 0 20%', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alt.supplierName || '—'}</span>
                            <span style={{ flex: '0 0 70px', color: '#6b7280' }}>
                              {(alt.effectivePrice ?? alt.price) != null ? (alt.effectivePrice ?? alt.price)!.toLocaleString('ru-RU') : '—'}
                            </span>
                            <span style={{ flex: '0 0 60px', fontSize: '0.75rem' }}>
                              <span className="confidence-badge">{Math.round(alt.confidence * 100)}%</span>
                            </span>
                            <div style={{ display: 'flex', gap: '0.2rem' }}>
                              {!alt.isConfirmed && (
                                <>
                                  <button className="btn btn-primary btn-sm" onClick={() => handleConfirm(alt.id)} disabled={loading === alt.id} title="Выбрать эту альтернативу">✓</button>
                                  <button className="btn btn-secondary btn-sm" onClick={() => handleConfirmAnalog(alt.id)} disabled={loading === alt.id} title="Аналог">≈</button>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* #17 Quick-tags strip (one-click operator feedback) */}
                  {projectId != null && (
                    <div style={{ borderTop: '1px solid #f1f5f9', background: '#fbfdff', padding: '0.35rem 0.75rem 0.35rem 2.75rem', display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Замечание (1 клик):</span>
                      {QUICK_TAGS.map(t => {
                        const tagKey = `${row.specItem.id}_${t.id}`;
                        const isApplied = appliedTags.has(tagKey);
                        const isLoading = tagLoading === tagKey;
                        return (
                          <button
                            key={t.id}
                            className="btn btn-sm"
                            style={{
                              padding: '0.15rem 0.5rem',
                              fontSize: '0.75rem',
                              background: isApplied ? '#dcfce7' : '#fff',
                              border: `1px solid ${isApplied ? '#16a34a' : '#cbd5e1'}`,
                              color: isApplied ? '#166534' : '#475569',
                              opacity: isLoading ? 0.5 : 1,
                              cursor: isLoading ? 'wait' : 'pointer',
                            }}
                            onClick={() => handleTag(
                              row.specItem.id,
                              best?.invoiceItemId ?? null,
                              null,
                              t.id,
                            )}
                            disabled={isLoading || isApplied}
                            title={t.label}
                          >
                            {t.icon} {t.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Expanded candidates */}
                  {isExpanded && (
                    <div className="match-candidates">
                      {row.matches.map(m => (
                        <div key={m.id} className={`match-candidate-row ${m.isConfirmed ? 'confirmed' : ''} ${m.isSelected ? 'selected' : ''}`}>
                          <div style={{ flex: '0 0 36px', paddingRight: '0.5rem' }}>
                            {!m.isConfirmed && (
                              <input
                                type="checkbox"
                                checked={selectedMatchIds.has(m.id)}
                                onChange={() => toggleSelected(m.id)}
                                title="Выбрать для массового действия"
                              />
                            )}
                          </div>
                          <div style={{ flex: '0 0 25%' }}></div>
                          <div style={{ flex: '0 0 80px', paddingRight: '0.75rem', fontSize: '0.75rem', color: '#888' }}>
                            {m.quantity != null ? `${m.quantity} ${m.unit || ''}` : ''}
                          </div>
                          <div style={{ flex: '0 0 22%', paddingRight: '0.75rem' }}>
                            {m.invoiceName}
                            {m.article && <span className="muted" style={{ fontSize: '0.75rem' }}> (Арт: {m.article})</span>}
                          </div>
                          <div style={{ flex: 1 }}>{m.supplierName || '—'}</div>
                          <div style={{ flex: 1 }}>
                            {(m.effectivePrice ?? m.price) != null ? (m.effectivePrice ?? m.price)!.toLocaleString('ru-RU') : '—'}
                            {m.effectivePrice != null && m.effectivePrice !== m.price && (
                              <span className="muted" style={{ fontSize: '0.65rem', marginLeft: '2px' }}>с НДС</span>
                            )}
                          </div>
                          <div style={{ flex: 1 }}>{m.amount != null ? m.amount.toLocaleString('ru-RU') : '—'}</div>
                          <div style={{ flex: '0 0 190px' }}>
                            <span className="confidence-badge" title={MATCH_TYPE_LABELS[m.matchType] || m.matchType}>
                              {m.matchType === 'learned_rule' && <span title="Запомнено системой">🧠 </span>}
                              {Math.round(m.confidence * 100)}%
                            </span>
                            <span style={{ fontSize: '0.75rem', color: '#888', marginLeft: 4 }}>
                              {m.matchReason}
                            </span>
                          </div>
                          <div style={{ flex: '0 0 150px', display: 'flex', gap: '0.25rem' }}>
                            {!m.isSelected && (
                              <button className="btn btn-secondary btn-sm" onClick={() => handleSelect(m.id)} disabled={loading === m.id} title="Выбрать эту цену">&#9679;</button>
                            )}
                            {m.isSelected && <span style={{ fontSize: '0.7rem', color: '#16a34a', fontWeight: 600 }}>&#10003; выбран</span>}
                            {!m.isConfirmed && (
                              <>
                                <button className="btn btn-primary btn-sm" onClick={() => handleConfirm(m.id)} disabled={loading === m.id} title="Точное совпадение">✓</button>
                                <button className="btn btn-secondary btn-sm" onClick={() => handleConfirmAnalog(m.id)} disabled={loading === m.id} title="Аналог">≈</button>
                                <button className="btn btn-secondary btn-sm" onClick={() => handleReject(m.id)} disabled={loading === m.id} title="Отклонить">✕</button>
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
      ))}
    </table>
    </>
  );
}
