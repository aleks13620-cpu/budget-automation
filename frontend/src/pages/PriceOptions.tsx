import { useState, useEffect, useCallback, useRef } from 'react';
import { api, apiUrlWithToken } from '../api';

// Ф21.3 — «Цены по позициям». Экран читает готовый бэкенд-контракт Ф21.1
// (backend/src/routes/priceOptions.ts): GET отдаёт все варианты цены по каждой позиции
// спецификации, PUT фиксирует выбор Ивана. Своей логики выбора здесь нет — только показ
// и точечный PUT с перечиткой GET (без оптимистичных трюков, по макету).

type PriceType = 'own' | 'base' | 'public';

interface PriceOption {
  option_id: number;
  supplier_label: string;
  domain: string | null;
  source: string;
  price_type: PriceType;
  base_price: number;
  discount_pct: number;
  prelim_price: number;
  snapshot_date: string;
  url: string;
  is_own_supplier: boolean;
  /** Выбранный ранее вариант, чья строка выпала из последнего среза — не спрятан, только помечен. */
  stale: boolean;
}

interface PriceOptionItem {
  spec_item_id: number;
  /** Все specification_items.id, схлопнутые в эту позицию (точные дубли) — на экране не
   *  используется напрямую, выбор на дубли применяет бэкенд по PUT одной позиции. */
  member_ids: number[];
  name: string;
  mark: string | null;
  qty: number | null;
  searched: boolean;
  reason_not_searched: string | null;
  selected_option_id: number | null;
  auto_option_id: number | null;
  auto_note: string | null;
  invoice_price: number | null;
  invoice_supplier: string | null;
  other_selected_label: string | null;
  invoice_restorable: boolean;
  skipped: boolean;
  options: PriceOption[];
}

interface PriceOptionsData {
  summary: {
    total: number; searched: number; with_price: number; own_price: number;
    selected: number; last_search_at: string | null;
  };
  items: PriceOptionItem[];
  not_searched_items: { spec_item_id: number; name: string }[];
}

interface Props {
  projectId: number;
  projectName: string;
  onBack: () => void;
}

const LEGEND: Record<PriceType, { label: string; color: string; bg: string }> = {
  own: { label: 'ваша цена', color: '#166534', bg: '#dcfce7' },
  base: { label: 'базовый прайс', color: '#92400e', bg: '#fef3c7' },
  public: { label: 'цена для всех', color: '#374151', bg: '#e5e7eb' },
};

function fmtPrice(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}

// ДД.ММ.ГГГГ — и для snapshot_date ('2026-09-12'), и для last_search_at (полный ISO с 'Z').
// UTC-геттеры: снимок хранится датой без времени, локальная зона не должна сдвигать день.
function fmtDate(iso: string | null): string {
  if (!iso) return 'поиска ещё не было';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

export function PriceOptions({ projectId, projectName, onBack }: Props) {
  const [data, setData] = useState<PriceOptionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [searchStatus, setSearchStatus] = useState<string>('idle');
  const [searchNote, setSearchNote] = useState('');
  const [searchPosting, setSearchPosting] = useState(false);
  const [savingItem, setSavingItem] = useState<number | null>(null);
  const [showNotSearched, setShowNotSearched] = useState(false);
  const pollRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/projects/${projectId}/price-options`);
      setData(data);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err.response?.data?.error || 'Не удалось загрузить варианты цены');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchSearchStatus = useCallback(async (): Promise<string> => {
    try {
      const { data } = await api.get(`/projects/${projectId}/price-search/status`);
      const status = String(data.status || 'idle');
      setSearchStatus(status);
      setSearchNote(String(data.message || '').split(/\r?\n/)[0].slice(0, 140));
      return status;
    } catch {
      return 'unknown';
    }
  }, [projectId]);

  const pollSearch = useCallback(async () => {
    if (pollRunning.current) return;
    pollRunning.current = true;
    try {
      for (let i = 0; i < 180; i++) {
        await new Promise(r => setTimeout(r, 15000));
        const status = await fetchSearchStatus();
        if (status === 'unknown') continue;
        if (status !== 'queued' && status !== 'running') { await load(); return; }
      }
    } finally {
      pollRunning.current = false;
    }
  }, [fetchSearchStatus, load]);

  useEffect(() => {
    setLoading(true);
    load();
    fetchSearchStatus().then(status => {
      if (status === 'queued' || status === 'running') pollSearch();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Скидка Арты правится на странице проекта (SupplierSites) в той же SPA — при возврате сюда
  // страница монтируется заново, но человек может и не закрывать вкладку, а переключиться и
  // вернуться в то же окно, поэтому перечитываем ещё и по фокусу/видимости.
  useEffect(() => {
    const onFocus = () => load();
    const onVisibility = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const handleFindPrices = async () => {
    setSearchPosting(true);
    setMessage(null);
    try {
      // тот же вызов, что кнопка «Найти цены в интернете» на странице проекта (POST .../price-search)
      await api.post(`/projects/${projectId}/price-search`, { searchInternet: true });
      setSearchStatus('queued');
      setSearchNote('');
      pollSearch();
    } catch (err: any) {
      if (err.response?.status === 409) {
        setSearchStatus('running');
        pollSearch();
      } else {
        setSearchStatus('error');
        setSearchNote(err.response?.data?.error || 'не удалось поставить заявку');
      }
    } finally {
      setSearchPosting(false);
    }
  };

  const applyChoice = async (specItemId: number, body: { option_id: number | null } | { skip: true }) => {
    setSavingItem(specItemId);
    setMessage(null);
    try {
      await api.put(`/projects/${projectId}/price-options/${specItemId}`, body);
      await load();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Не удалось сохранить выбор' });
    } finally {
      setSavingItem(null);
    }
  };

  if (loading) return <p className="loading">Загрузка...</p>;

  if (loadError) {
    return (
      <div className="section">
        <h2>Цены по позициям · {projectName}</h2>
        <p className="error-msg">{loadError}</p>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>Назад</button>
      </div>
    );
  }

  if (!data) return null;

  const { summary } = data;
  const rows = data.items.filter(i => i.searched || i.options.length > 0);
  const searchButtonLabel = searchPosting
    ? 'Отправка...'
    : searchStatus === 'queued' ? 'В очереди...'
    : searchStatus === 'running' ? 'Идёт поиск...'
    : 'Найти цены у моих поставщиков';
  const searchStatusText =
    searchStatus === 'queued' ? 'Заявка принята. Поиск начнётся в течение нескольких минут — страницу можно закрыть.'
    : searchStatus === 'running' ? 'Идём по позициям, ищем цены. Обычно 15–30 минут. Страницу можно закрыть.'
    : searchStatus === 'error' ? `Поиск не завершился: ${searchNote}.`
    : '';

  return (
    <div>
      <div className="section" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginBottom: '0.25rem' }}>
          Цены по позициям · {projectName} · последний поиск {fmtDate(summary.last_search_at)}
        </h2>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', margin: '0.5rem 0' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleFindPrices}
            disabled={searchPosting || searchStatus === 'queued' || searchStatus === 'running'}
          >
            {searchButtonLabel}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => window.open(apiUrlWithToken(`/api/projects/${projectId}/export`), '_blank')}
          >
            Скачать с выбранными ценами
          </button>
        </div>
        {searchStatusText && <p className="muted" style={{ margin: '0.25rem 0' }}>{searchStatusText}</p>}
        {message && (
          <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>{message.text}</p>
        )}

        <div className="matching-summary" style={{ marginTop: '0.75rem' }}>
          <div className="summary-card">
            <div className="summary-value">{summary.searched} / {summary.total}</div>
            <div className="summary-label">Искали</div>
          </div>
          <div className="summary-card summary-confirmed">
            <div className="summary-value">{summary.with_price}</div>
            <div className="summary-label">Цена есть</div>
          </div>
          <div className="summary-card" style={{ background: '#dcfce7' }}>
            <div className="summary-value">{summary.own_price}</div>
            <div className="summary-label">Ваша цена</div>
          </div>
          <div className="summary-card summary-matched">
            <div className="summary-value">{summary.selected}</div>
            <div className="summary-label">Выбрано</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', margin: '0.75rem 0 0', flexWrap: 'wrap' }}>
          {(Object.keys(LEGEND) as PriceType[]).map(k => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: LEGEND[k].bg, border: `1px solid ${LEGEND[k].color}` }} />
              {LEGEND[k].label}
            </span>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="muted">По этому проекту искать пока нечего — нет позиций с маркой/артикулом или поиск ещё не запускался.</p>
      ) : (
        <div className="section">
          {rows.map(item => {
            const checkedId =
              item.selected_option_id != null ? `opt-${item.selected_option_id}`
              : item.skipped ? 'skip'
              : item.auto_option_id != null ? `opt-${item.auto_option_id}`
              : null;
            return (
              <div key={item.spec_item_id} style={{ borderBottom: '1px solid #e5e7eb', padding: '0.75rem 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{item.name}</span>
                    {item.mark && <span className="muted"> · {item.mark}</span>}
                    {item.qty != null && <span className="muted"> · {item.qty} шт.</span>}
                  </div>
                  {item.selected_option_id != null && (
                    <span
                      style={{ fontSize: '0.8rem', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => applyChoice(item.spec_item_id, { option_id: null })}
                    >
                      {item.invoice_restorable ? 'вернуть цену из счёта' : 'сбросить выбор'}
                    </span>
                  )}
                </div>

                {item.auto_note && (
                  <p className="muted" style={{ fontSize: '0.75rem', margin: '0.15rem 0' }}>{item.auto_note}</p>
                )}

                {!item.searched && (
                  <p className="muted" style={{ fontSize: '0.8rem', margin: '0.25rem 0' }}>{item.reason_not_searched}</p>
                )}

                {item.selected_option_id == null && !item.skipped && item.invoice_price != null && (
                  <p style={{ fontSize: '0.8rem', margin: '0.25rem 0', background: '#eff6ff', padding: '0.3rem 0.5rem', borderRadius: '4px' }}>
                    Сейчас в выгрузке — цена из счёта: {fmtPrice(item.invoice_price)}{item.invoice_supplier ? ` (${item.invoice_supplier})` : ''}
                  </p>
                )}

                {item.other_selected_label && (
                  <p style={{ fontSize: '0.8rem', margin: '0.25rem 0', background: '#eff6ff', padding: '0.3rem 0.5rem', borderRadius: '4px' }}>
                    {item.other_selected_label}
                  </p>
                )}

                {item.options.length === 0 ? (
                  item.searched && <p className="muted" style={{ fontSize: '0.8rem', margin: '0.25rem 0' }}>Цена не найдена.</p>
                ) : (
                  <table style={{ fontSize: '0.85rem', marginTop: '0.4rem' }}>
                    <thead>
                      <tr>
                        <th style={{ width: '24px' }}></th>
                        <th>Поставщик</th>
                        <th>Тип</th>
                        <th>Цена поставщика</th>
                        <th>Скидка Арты, %</th>
                        <th>Предварительно</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.options.map(opt => {
                        const legend = LEGEND[opt.price_type];
                        const optKey = `opt-${opt.option_id}`;
                        const isAuto = item.selected_option_id == null && !item.skipped && item.auto_option_id === opt.option_id;
                        return (
                          <tr key={opt.option_id}>
                            <td>
                              <input
                                type="radio"
                                name={`item-${item.spec_item_id}`}
                                aria-label={`${opt.supplier_label}, ${fmtPrice(opt.prelim_price)}`}
                                checked={checkedId === optKey}
                                disabled={savingItem === item.spec_item_id}
                                onChange={() => applyChoice(item.spec_item_id, { option_id: opt.option_id })}
                              />
                            </td>
                            <td>
                              {opt.url ? (
                                <a href={opt.url} target="_blank" rel="noreferrer">{opt.supplier_label}</a>
                              ) : opt.supplier_label}
                              {!opt.is_own_supplier && (
                                <span className="muted" style={{ marginLeft: '0.4rem', fontSize: '0.75rem' }}>не ваш поставщик</span>
                              )}
                              {isAuto && (
                                <span className="muted" style={{ marginLeft: '0.4rem', fontSize: '0.7rem' }}>подставится сама</span>
                              )}
                              {opt.stale && (
                                <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: '#b45309' }}>
                                  из прошлого поиска {fmtDate(opt.snapshot_date)}
                                </span>
                              )}
                            </td>
                            <td>
                              <span style={{ padding: '0.1rem 0.4rem', borderRadius: '4px', background: legend.bg, color: legend.color, fontSize: '0.75rem', fontWeight: 600 }}>
                                {legend.label}
                              </span>
                              <div className="muted" style={{ fontSize: '0.7rem' }}>{fmtDate(opt.snapshot_date)}</div>
                            </td>
                            <td>{fmtPrice(opt.base_price)}</td>
                            <td>{opt.discount_pct ? `${opt.discount_pct}%` : '—'}</td>
                            <td style={{ fontWeight: 600 }}>{fmtPrice(opt.prelim_price)}</td>
                          </tr>
                        );
                      })}
                      <tr>
                        <td>
                          <input
                            type="radio"
                            name={`item-${item.spec_item_id}`}
                            aria-label="Не брать цену"
                            checked={checkedId === 'skip'}
                            disabled={savingItem === item.spec_item_id}
                            onChange={() => applyChoice(item.spec_item_id, { skip: true })}
                          />
                        </td>
                        <td colSpan={5} className="muted">Не брать цену</td>
                      </tr>
                    </tbody>
                  </table>
                )}

                {checkedId === null && item.options.length > 0 && item.invoice_price == null && (
                  <p className="muted" style={{ fontSize: '0.75rem', margin: '0.25rem 0 0' }}>цена не выбрана</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {data.not_searched_items.length > 0 && (
        <div className="section">
          <p className="muted">
            Описаны словами, по ним поиск не шёл: {data.not_searched_items.length} поз.{' '}
            <button type="button" style={{ color: '#2563eb', cursor: 'pointer', textDecoration: 'underline', background: 'none', border: 'none', padding: 0, font: 'inherit' }} onClick={() => setShowNotSearched(v => !v)}>
              {showNotSearched ? 'скрыть список' : 'показать список'}
            </button>
          </p>
          {showNotSearched && (
            <ul style={{ fontSize: '0.85rem', margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
              {data.not_searched_items.map(it => <li key={it.spec_item_id}>{it.name}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
