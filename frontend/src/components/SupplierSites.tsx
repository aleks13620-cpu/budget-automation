import { useEffect, useState } from 'react';
import { api } from '../api';

interface SupplierSite {
  id: number;
  name: string;
  domain: string | null;
  price_source: string;
  source_key: string | null;
  search_enabled: 0 | 1;
  discount_pct: number;
  note: string | null;
  sort_order: number;
}

// Ф10: подписи по контракту бэкенда (routes/supplierSites.ts) — держим в одном месте, чтобы
// не разошлись с тем, что реально показывает БД.
const SOURCE_LABELS: Record<string, string> = {
  api: 'API поставщика (цена Арты)',
  open_price: 'Открытый прайс (базовая цена)',
  site_discount: 'Цена сайта минус скидка договора',
  price_file: 'Прайс файлом',
  search: 'Общий поиск в интернете',
};

function errorText(e: unknown, fallback: string): string {
  const err = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return err || fallback;
}

function SiteRow({ site, onChange }: { site: SupplierSite; onChange: (updated: SupplierSite) => void }) {
  const [discountInput, setDiscountInput] = useState(String(site.discount_pct));
  const [discountError, setDiscountError] = useState('');
  const [checkError, setCheckError] = useState('');

  const saveDiscount = async () => {
    const val = Number(discountInput);
    if (!Number.isFinite(val) || val < 0 || val > 90) {
      setDiscountError('Число от 0 до 90');
      setDiscountInput(String(site.discount_pct));
      return;
    }
    if (val === site.discount_pct) return;
    setDiscountError('');
    try {
      const { data } = await api.put(`/supplier-sites/${site.id}`, { discount_pct: val });
      onChange(data);
    } catch (e) {
      setDiscountError(errorText(e, 'Не сохранилось'));
      setDiscountInput(String(site.discount_pct));
    }
  };

  const toggleSearch = async (checked: boolean) => {
    setCheckError('');
    try {
      const { data } = await api.put(`/supplier-sites/${site.id}`, { search_enabled: checked });
      onChange(data);
    } catch (e) {
      setCheckError(errorText(e, 'Не сохранилось'));
      // site не менялся — контролируемый checkbox сам откатится на старое значение
    }
  };

  const isApi = site.price_source === 'api';
  const label = SOURCE_LABELS[site.price_source] || site.price_source;

  return (
    <tr>
      <td>
        {site.name}
        {site.domain && <div className="muted" style={{ fontSize: '0.75rem' }}>{site.domain}</div>}
      </td>
      <td>
        {label}
        {site.note && <div className="muted" style={{ fontSize: '0.75rem' }}>{site.note}</div>}
      </td>
      <td>
        {site.source_key != null ? (
          <>
            <input
              type="checkbox"
              checked={!!site.search_enabled}
              onChange={e => toggleSearch(e.target.checked)}
            />
            {checkError && <div style={{ color: '#dc2626', fontSize: '0.75rem' }}>{checkError}</div>}
          </>
        ) : (
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {site.price_source === 'price_file' ? 'ждём файл' : 'через общий поиск'}
          </span>
        )}
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={90}
          step={0.5}
          value={discountInput}
          disabled={isApi}
          title={isApi ? 'цена уже персональная' : undefined}
          onChange={e => setDiscountInput(e.target.value)}
          onBlur={saveDiscount}
          onKeyDown={e => { if (e.key === 'Enter') saveDiscount(); }}
          style={{ width: '70px' }}
        />
        {discountError && <div style={{ color: '#dc2626', fontSize: '0.75rem' }}>{discountError}</div>}
      </td>
    </tr>
  );
}

export function SupplierSites() {
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<SupplierSite[] | null>(null);
  const [loading, setLoading] = useState(false);

  const [newName, setNewName] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [newSource, setNewSource] = useState('search');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  useEffect(() => {
    if (open && sites === null && !loading) {
      setLoading(true);
      api.get('/supplier-sites')
        .then(({ data }) => setSites(data))
        .finally(() => setLoading(false));
    }
  }, [open, sites, loading]);

  const handleAdd = async () => {
    if (!newName.trim()) {
      setAddError('Укажите имя поставщика');
      return;
    }
    setAdding(true);
    setAddError('');
    try {
      const { data } = await api.post('/supplier-sites', {
        name: newName.trim(),
        domain: newDomain.trim() || undefined,
        price_source: newSource,
      });
      setSites(prev => [...(prev || []), data]);
      setNewName('');
      setNewDomain('');
      setNewSource('search');
    } catch (e) {
      setAddError(errorText(e, 'Не удалось добавить'));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <p
        className="muted"
        style={{ margin: 0, cursor: 'pointer', fontWeight: 600 }}
        onClick={() => setOpen(o => !o)}
      >
        {open ? '▾' : '▸'} Поставщики Арты{sites ? ` (${sites.length})` : ''}
      </p>
      {open && (
        <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: '#f8f9fa', borderRadius: '6px' }}>
          {loading && <p className="muted">Загрузка...</p>}
          {sites && (
            <>
              <table style={{ fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th>Поставщик</th>
                    <th>Откуда цена</th>
                    <th>Искать</th>
                    <th>Скидка, %</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map(site => (
                    <SiteRow
                      key={site.id}
                      site={site}
                      onChange={updated => setSites(prev => prev!.map(s => (s.id === updated.id ? updated : s)))}
                    />
                  ))}
                </tbody>
              </table>

              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span>+ Добавить поставщика:</span>
                <input
                  type="text"
                  placeholder="Имя"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  style={{ maxWidth: '160px' }}
                />
                <input
                  type="text"
                  placeholder="Домен (необязательно)"
                  value={newDomain}
                  onChange={e => setNewDomain(e.target.value)}
                  style={{ maxWidth: '180px' }}
                />
                <select value={newSource} onChange={e => setNewSource(e.target.value)}>
                  {Object.entries(SOURCE_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
                <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={adding}>
                  {adding ? 'Добавление...' : 'Добавить'}
                </button>
              </div>
              {addError && <p style={{ color: '#dc2626', fontSize: '0.85rem', margin: '0.3rem 0 0' }}>{addError}</p>}

              <p className="muted" style={{ margin: '0.6rem 0 0', fontSize: '0.8rem' }}>
                Скидка и галочка применяются к следующему поиску цен.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
