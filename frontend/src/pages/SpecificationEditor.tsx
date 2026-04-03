import { useState, useEffect } from 'react';
import { api } from '../api';
import { SpecColumnMapper } from '../components/SpecColumnMapper';
import type { SpecColumnMapping } from '../components/SpecColumnMapper';

const DEFAULT_MAPPING: SpecColumnMapping = {
  position_number: null, name: null, characteristics: null, equipment_code: null,
  article: null, product_code: null, marking: null, type_size: null,
  manufacturer: null, unit: null, quantity: null, price: null, amount: null,
};

interface EnrichDiff {
  idx: number;
  position_number: string | null;
  before: Record<string, string | null>;
  after: Record<string, string | null>;
  changed: boolean;
}

interface HistoryEntry {
  id: number;
  version: number;
  action: string;
  created_at: string;
  items_count: number;
}

interface Props {
  specId: number;
  onBack: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  gigachat_enrich: 'GigaChat: обогащение',
  reparse: 'Пересборка',
  initial_upload: 'Загрузка',
};

function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  if (action.startsWith('rollback_to_v')) return `Откат к v${action.replace('rollback_to_v', '')}`;
  return action;
}

export function SpecificationEditor({ specId, onBack }: Props) {
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<SpecColumnMapping>(DEFAULT_MAPPING);
  const [mergeMultiline, setMergeMultiline] = useState(true);
  const [headerRow, setHeaderRow] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reparsing, setReparsing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // GigaChat enrich
  const [enriching, setEnriching] = useState(false);
  const [enrichPreview, setEnrichPreview] = useState<EnrichDiff[] | null>(null);
  const [enrichStats, setEnrichStats] = useState<{ updated: number; total: number; errors: string[] } | null>(null);
  const [applying, setApplying] = useState(false);
  const [saveRules, setSaveRules] = useState(false);

  // History / rollback
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyData, setHistoryData] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  useEffect(() => {
    api.get(`/specifications/${specId}/raw-data`).then(({ data }) => {
      setRows(data.rows || []);
      if (data.config) {
        setHeaderRow(data.config.header_row);
        try {
          const cm = JSON.parse(data.config.column_mapping);
          setMapping({ ...DEFAULT_MAPPING, ...cm });
        } catch {}
        setMergeMultiline(data.config.merge_multiline !== 0);
      } else if (data.detectedMapping) {
        setHeaderRow(data.detectedMapping.headerRow);
        setMapping({ ...DEFAULT_MAPPING, ...data.detectedMapping.columnMapping });
      }
    }).catch(() => {
      // raw_data нет — спецификация загружена до v2.0
    }).finally(() => setLoading(false));
  }, [specId]);

  const handleReparse = async () => {
    if (!confirm('Пересобрать позиции спецификации? Текущие позиции будут заменены новыми.')) return;
    setReparsing(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/specifications/${specId}/reparse`, { headerRow, columnMapping: mapping, mergeMultiline });
      const errs = (data.errors || []) as string[];
      const errCount = errs.length;
      let text = `Импортировано ${data.imported} позиций. Пропусков/ошибок строк: ${errCount}.`;
      if (errCount > 0) {
        const preview = errs.slice(0, 5).join(' | ');
        text += errCount > 5 ? ` Примеры: ${preview} … (ещё ${errCount - 5})` : ` ${preview}`;
      }
      setMessage({ type: 'success', text });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка пересборки' });
    } finally {
      setReparsing(false);
    }
  };

  const handleSaveConfig = async () => {
    try {
      await api.post(`/specifications/${specId}/parser-config`, { headerRow, columnMapping: mapping, mergeMultiline });
      setMessage({ type: 'success', text: 'Конфигурация сохранена' });
    } catch {
      setMessage({ type: 'error', text: 'Ошибка сохранения конфига' });
    }
  };

  // -------------------------------------------------------------------------
  // GigaChat enrich
  // -------------------------------------------------------------------------

  const handleEnrichPreview = async () => {
    setEnriching(true);
    setMessage(null);
    try {
      const { data } = await api.post(`/specifications/${specId}/gigachat-enrich`, { dryRun: true });
      setEnrichPreview(data.diffs);
      setEnrichStats({ updated: data.updated, total: data.diffs.length, errors: data.errors });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при предпросмотре GigaChat' });
    } finally {
      setEnriching(false);
    }
  };

  const handleEnrichApply = async () => {
    setApplying(true);
    try {
      const { data } = await api.post(`/specifications/${specId}/gigachat-enrich`, { dryRun: false, saveRules });
      setEnrichPreview(null);
      setEnrichStats(null);
      setSaveRules(false);
      const rulesMsg = saveRules ? ' Правила сохранены для обучения.' : '';
      setMessage({ type: 'success', text: `GigaChat обновил ${data.updated} позиций из ${data.diffs.length}.${rulesMsg}` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при применении изменений GigaChat' });
    } finally {
      setApplying(false);
    }
  };

  // -------------------------------------------------------------------------
  // History / rollback
  // -------------------------------------------------------------------------

  const handleOpenHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const { data } = await api.get(`/specifications/${specId}/history`);
      setHistoryData(data.history);
    } catch {
      setHistoryData([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleRollback = async (version: number) => {
    if (!confirm(`Откатить спецификацию к версии ${version}? Текущее состояние будет сохранено в историю.`)) return;
    setRollingBack(true);
    try {
      const { data } = await api.post(`/specifications/${specId}/rollback`, { version });
      setHistoryOpen(false);
      setMessage({ type: 'success', text: `Восстановлено ${data.restored} позиций из версии v${version}` });
      // Refresh history after rollback
      const { data: h } = await api.get(`/specifications/${specId}/history`);
      setHistoryData(h.history);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Ошибка при откате' });
    } finally {
      setRollingBack(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  const columnHeaders: string[] = rows.length > 0 && rows[headerRow]
    ? rows[headerRow].map(c => String(c ?? '').trim())
    : [];

  const displayRows = rows.slice(0, 40);

  const mappedCols = new Set(
    Object.values(mapping).filter((v): v is number => v !== null)
  );

  if (loading) return <div className="section"><p className="muted">Загрузка...</p></div>;

  return (
    <div className="section">
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>&larr; Назад</button>
        <h2 style={{ margin: 0 }}>Редактор спецификации #{specId}</h2>
      </div>

      {message && (
        <div style={{
          marginBottom: '1rem',
          padding: '0.75rem 1rem',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          background: message.type === 'success' ? '#d1fae5' : '#fee2e2',
          border: `1px solid ${message.type === 'success' ? '#6ee7b7' : '#fca5a5'}`,
          color: message.type === 'success' ? '#065f46' : '#991b1b',
          fontWeight: 500,
        }}>
          <span style={{ fontSize: '1.1rem' }}>{message.type === 'success' ? '✓' : '✕'}</span>
          {message.text}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 6, padding: '1rem' }}>
          <strong>Редактор недоступен</strong>
          <p style={{ margin: '0.5rem 0 0' }}>
            Эта спецификация была загружена до версии 2.0 — исходный файл Excel не сохранён в базе.
          </p>
          <p style={{ margin: '0.5rem 0 0', color: '#666' }}>
            <strong>Решение:</strong> удалите спецификацию в разделе проекта и загрузите Excel-файл повторно.
          </p>
        </div>
      ) : (
        <>
          {/* Строка заголовка */}
          <div style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
              Строка заголовка:
              <input
                type="number"
                min={0}
                max={rows.length - 1}
                value={headerRow}
                onChange={e => setHeaderRow(Math.max(0, parseInt(e.target.value, 10) || 0))}
                style={{ width: '70px', padding: '3px 6px' }}
              />
            </label>
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              Выделена синим в таблице. Колонки нумеруются с 1.
            </span>
          </div>

          {/* Маппинг колонок — над таблицей */}
          <div style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '0.75rem', marginBottom: '0.75rem', background: '#f8f9fa' }}>
            <h4 style={{ margin: '0 0 0.5rem' }}>Маппинг колонок</h4>
            <SpecColumnMapper
              mapping={mapping}
              onChange={setMapping}
              mergeMultiline={mergeMultiline}
              onMergeMultilineChange={setMergeMultiline}
              columnHeaders={columnHeaders}
            />
          </div>

          {/* Кнопки действий */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <button className="btn btn-primary" onClick={handleReparse} disabled={reparsing}>
              {reparsing ? 'Пересборка...' : 'Пересобрать позиции'}
            </button>
            <button className="btn btn-secondary" onClick={handleSaveConfig}>
              Сохранить конфиг
            </button>
            <button className="btn btn-secondary" onClick={handleEnrichPreview} disabled={enriching}>
              {enriching ? 'Анализ GigaChat...' : 'Улучшить через GigaChat'}
            </button>
            <button className="btn btn-secondary" onClick={handleOpenHistory}>
              История версий
            </button>
          </div>

          {/* Таблица сырых данных */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: '0.75rem', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '100%' }}>
              <thead>
                <tr style={{ background: '#343a40', color: '#fff' }}>
                  <th style={{ padding: '3px 6px', width: '35px', textAlign: 'center' }}>№</th>
                  {(rows[0] || []).map((_, ci) => (
                    <th key={ci} style={{
                      padding: '3px 8px',
                      minWidth: ci === mapping.name ? '280px' : '80px',
                      maxWidth: ci === mapping.name ? '420px' : '180px',
                      background: mappedCols.has(ci) ? '#0d6efd' : '#343a40',
                      textAlign: 'center',
                    }}>
                      {ci + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, ri) => (
                  <tr key={ri} style={{
                    background: ri === headerRow ? '#cfe2ff' : ri % 2 === 0 ? '#fff' : '#f8f9fa',
                    fontWeight: ri === headerRow ? 600 : 'normal',
                  }}>
                    <td style={{ padding: '2px 4px', color: '#999', textAlign: 'center', borderRight: '1px solid #dee2e6' }}>{ri}</td>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{
                        padding: '2px 6px',
                        border: '1px solid #e0e0e0',
                        whiteSpace: ci === mapping.name ? 'normal' : 'nowrap',
                        overflow: 'hidden',
                        textOverflow: ci === mapping.name ? 'unset' : 'ellipsis',
                        maxWidth: ci === mapping.name ? '420px' : '180px',
                        background: mappedCols.has(ci) ? '#e8f0fe' : undefined,
                      }}>
                        {String(cell ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 40 && (
              <p className="muted" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
                Показаны первые 40 строк из {rows.length}
              </p>
            )}
          </div>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Модальное окно: предпросмотр GigaChat                              */}
      {/* ------------------------------------------------------------------ */}
      {enrichPreview && enrichStats && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: '#fff', borderRadius: 8, padding: '1.5rem',
            width: '90%', maxWidth: '900px', maxHeight: '85vh',
            display: 'flex', flexDirection: 'column', gap: '1rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Предпросмотр улучшений GigaChat</h3>
              <span className="muted">
                Изменений: <strong>{enrichStats.updated}</strong> из {enrichStats.total} позиций
              </span>
            </div>

            {enrichStats.errors.length > 0 && (
              <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 4, padding: '0.5rem', fontSize: '0.85rem', color: '#991b1b' }}>
                Ошибки: {enrichStats.errors.join('; ')}
              </div>
            )}

            <div style={{ overflowY: 'auto', flex: 1 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <thead>
                  <tr style={{ background: '#f8f9fa', position: 'sticky', top: 0 }}>
                    <th style={{ padding: '6px 8px', border: '1px solid #dee2e6', width: '50px' }}>№ поз.</th>
                    <th style={{ padding: '6px 8px', border: '1px solid #dee2e6' }}>Поле</th>
                    <th style={{ padding: '6px 8px', border: '1px solid #dee2e6' }}>Было</th>
                    <th style={{ padding: '6px 8px', border: '1px solid #dee2e6' }}>Станет</th>
                  </tr>
                </thead>
                <tbody>
                  {enrichPreview.filter(d => d.changed).length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ padding: '1rem', textAlign: 'center', color: '#666' }}>
                        Нет изменений — все позиции уже нормализованы
                      </td>
                    </tr>
                  ) : (
                    enrichPreview.filter(d => d.changed).flatMap(diff =>
                      Object.keys(diff.after).map(field => (
                        <tr key={`${diff.idx}-${field}`}>
                          <td style={{ padding: '4px 8px', border: '1px solid #e0e0e0', textAlign: 'center', color: '#666' }}>
                            {diff.position_number ?? diff.idx + 1}
                          </td>
                          <td style={{ padding: '4px 8px', border: '1px solid #e0e0e0', color: '#666', fontStyle: 'italic' }}>
                            {field}
                          </td>
                          <td style={{ padding: '4px 8px', border: '1px solid #e0e0e0', color: '#666', maxWidth: '300px', wordBreak: 'break-word' }}>
                            {diff.before[field] ?? '—'}
                          </td>
                          <td style={{ padding: '4px 8px', border: '1px solid #e0e0e0', color: '#1a7f64', fontWeight: 500, maxWidth: '300px', wordBreak: 'break-word' }}>
                            {diff.after[field] ?? '—'}
                          </td>
                        </tr>
                      ))
                    )
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={saveRules}
                  onChange={e => setSaveRules(e.target.checked)}
                />
                Сохранить правила в память для обучения
              </label>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button className="btn btn-secondary" onClick={() => { setEnrichPreview(null); setEnrichStats(null); setSaveRules(false); }}>
                  Отмена
                </button>
                <button className="btn btn-primary" onClick={handleEnrichApply} disabled={applying || enrichStats.updated === 0}>
                  {applying ? 'Применение...' : `Применить изменения (${enrichStats.updated})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Модальное окно: история версий                                      */}
      {/* ------------------------------------------------------------------ */}
      {historyOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: '#fff', borderRadius: 8, padding: '1.5rem',
            width: '600px', maxHeight: '80vh',
            display: 'flex', flexDirection: 'column', gap: '1rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>История версий спецификации</h3>
              <button className="btn btn-secondary btn-sm" onClick={() => setHistoryOpen(false)}>✕</button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1 }}>
              {historyLoading ? (
                <p className="muted">Загрузка...</p>
              ) : historyData.length === 0 ? (
                <p className="muted">История пуста. Версии создаются при обогащении GigaChat и откатах.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: '#f8f9fa' }}>
                      <th style={{ padding: '6px 8px', border: '1px solid #dee2e6', textAlign: 'center' }}>Версия</th>
                      <th style={{ padding: '6px 8px', border: '1px solid #dee2e6' }}>Дата</th>
                      <th style={{ padding: '6px 8px', border: '1px solid #dee2e6' }}>Действие</th>
                      <th style={{ padding: '6px 8px', border: '1px solid #dee2e6', textAlign: 'center' }}>Позиций</th>
                      <th style={{ padding: '6px 8px', border: '1px solid #dee2e6' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyData.map((entry, idx) => (
                      <tr key={entry.id} style={{ background: idx === 0 ? '#f0fdf4' : undefined }}>
                        <td style={{ padding: '6px 8px', border: '1px solid #e0e0e0', textAlign: 'center' }}>
                          v{entry.version}
                          {idx === 0 && <span style={{ marginLeft: '4px', fontSize: '0.7rem', color: '#16a34a' }}>текущая</span>}
                        </td>
                        <td style={{ padding: '6px 8px', border: '1px solid #e0e0e0', color: '#666' }}>
                          {new Date(entry.created_at).toLocaleString('ru-RU')}
                        </td>
                        <td style={{ padding: '6px 8px', border: '1px solid #e0e0e0' }}>
                          {actionLabel(entry.action)}
                        </td>
                        <td style={{ padding: '6px 8px', border: '1px solid #e0e0e0', textAlign: 'center' }}>
                          {entry.items_count}
                        </td>
                        <td style={{ padding: '6px 8px', border: '1px solid #e0e0e0' }}>
                          {idx !== 0 && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleRollback(entry.version)}
                              disabled={rollingBack}
                            >
                              Откатить
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
