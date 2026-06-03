import { useState, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';

interface Project {
  id: number;
  name: string;
}

interface Snapshot {
  id: number;
  createdAt: string;
  kind: string; // 'startup' | 'matching_run' | 'operator_action' | 'daily'
  actionType: string | null;
  total: number;
  matched: number;
  confirmed: number;
  coverage: number;      // %
  confirmedPct: number;  // %
  tierBreakdown: Record<string, number>;
  learnedSynonyms: number;
  learnedRules: number;
}

interface Props {
  onBack: () => void;
  initialProjectId?: number | null;
}

// RU labels for match tiers — same vocabulary as MatchingView. An unknown tier
// falls back to its raw key, so a newly-added match_type still renders (no hardcoded
// closed set that would silently drop a new tier).
const TIER_LABELS: Record<string, string> = {
  exact_article: 'Артикул',
  name_exact: 'Точное имя',
  learned_rule: 'Правила',
  name_similarity: 'Схожесть',
  name_characteristics: 'Хар-ки',
  llm_suggestion: 'GigaChat (LLM)',
  manual: 'Вручную',
};
const tierLabel = (key: string) => TIER_LABELS[key] || key;

// Stable color per known tier; unknown tiers cycle a fallback palette by first-seen order.
const TIER_COLORS: Record<string, string> = {
  learned_rule: '#16a34a',         // green — the "good" growth (system learned the domain)
  llm_suggestion: '#7c3aed',       // purple — GigaChat sampler (carries new domains)
  name_similarity: '#2563eb',      // blue
  name_characteristics: '#0891b2', // cyan
  exact_article: '#d97706',        // amber
  name_exact: '#ca8a04',
  manual: '#6b7280',               // gray
};
const FALLBACK_PALETTE = ['#db2777', '#65a30d', '#9333ea', '#0d9488', '#dc2626', '#475569'];
const tierColor = (key: string, idx: number) =>
  TIER_COLORS[key] || FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length];

const KIND_LABELS: Record<string, string> = {
  startup: 'старт', matching_run: 'прогон', operator_action: 'действие', daily: 'ежедневно',
};
const ACTION_LABELS: Record<string, string> = {
  confirm: 'подтверждение', reject: 'отклонение', analog: 'аналог', group: 'группа',
  unconfirm: 'снятие подтв.', select: 'выбор кандидата', manual: 'ручной матч',
  'gigachat-remove': 'удаление GigaChat',
};

const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
};
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
};

/** Round a value up to a clean axis maximum (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × 10^k). */
function niceCeil(v: number): number {
  if (!isFinite(v) || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const s = steps.find(st => st >= norm - 1e-9) ?? 10;
  return Math.round(s * mag * 1000) / 1000;
}

interface ChartSeries {
  label: string;
  color: string;
  values: number[]; // one value per x position (snapshot), in chronological order
}

/**
 * Lightweight dependency-free SVG line chart. X positions are evenly spaced by snapshot
 * order (one step per snapshot) so every operator action reads as a discrete step that
 * moves the metric; the axis is labelled with the real snapshot dates for time context.
 */
function LineChart({
  series, xDates, yMax: yMaxOverride, yUnit = '', height = 230, markerIndices, pointTitle,
}: {
  series: ChartSeries[];
  xDates: string[];
  yMax?: number;
  yUnit?: string;
  height?: number;
  markerIndices?: number[];     // emphasized points (operator actions) drawn on series[0]
  pointTitle?: (i: number) => string;
}) {
  const W = 1000;
  const H = height;
  const padL = 46, padR = 14, padT = 12, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = xDates.length;

  const dataMax = Math.max(0, ...series.flatMap(s => s.values));
  const yMax = yMaxOverride ?? niceCeil(dataMax);
  const safeYMax = yMax > 0 ? yMax : 1;

  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - (Math.max(0, v) / safeYMax) * plotH;

  // y gridline values = rounded integers placed at their true y, so label matches position.
  const yTicks = Array.from(new Set([0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * safeYMax))));
  // x date ticks: up to 6 evenly spaced indices.
  const tickCount = Math.min(6, n);
  const xTickIdx = n <= 1 ? [0]
    : Array.from(new Set(Array.from({ length: tickCount }, (_, k) =>
        Math.round((k / (tickCount - 1)) * (n - 1)))));
  const showAllPoints = n <= 40;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      {yTicks.map((tv, k) => (
        <g key={`y${k}`}>
          <line x1={padL} y1={y(tv)} x2={W - padR} y2={y(tv)} stroke="#eef0f3" strokeWidth={1} />
          <text x={padL - 6} y={y(tv) + 3} textAnchor="end" fontSize={11} fill="#9ca3af">{tv}{yUnit}</text>
        </g>
      ))}
      <line x1={padL} y1={y(0)} x2={W - padR} y2={y(0)} stroke="#d1d5db" strokeWidth={1} />
      {xTickIdx.map(i => (
        <text key={`x${i}`} x={x(i)} y={H - padB + 16} textAnchor="middle" fontSize={11} fill="#9ca3af">
          {fmtDate(xDates[i])}
        </text>
      ))}
      {series.map((s, si) => (
        <g key={`s${si}`}>
          {n > 1 && (
            <polyline fill="none" stroke={s.color} strokeWidth={2}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}>
              <title>{s.label}</title>
            </polyline>
          )}
          {showAllPoints && s.values.map((v, i) => (
            <circle key={`p${i}`} cx={x(i)} cy={y(v)} r={2.5} fill={s.color}>
              <title>{`${s.label}: ${v}${yUnit}${pointTitle ? ` — ${pointTitle(i)}` : ''}`}</title>
            </circle>
          ))}
        </g>
      ))}
      {markerIndices && series[0] && !showAllPoints && markerIndices.map(i => (
        <circle key={`m${i}`} cx={x(i)} cy={y(series[0].values[i])} r={2.2}
          fill={series[0].color} fillOpacity={0.55}>
          {pointTitle && <title>{pointTitle(i)}</title>}
        </circle>
      ))}
    </svg>
  );
}

function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap', alignItems: 'center' }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: '#374151' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: 'inline-block' }} />
          {it.label}{it.value != null && <b style={{ marginLeft: 2 }}>{it.value}</b>}
        </span>
      ))}
    </div>
  );
}

function ChartCard({ title, subtitle, legend, children }: {
  title: string; subtitle?: string; legend?: ReactNode; children: ReactNode;
}) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.85rem 1rem', marginBottom: '1.25rem', background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{title}</div>
          {subtitle && <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{subtitle}</div>}
        </div>
        {legend}
      </div>
      <div style={{ marginTop: '0.5rem' }}>{children}</div>
    </div>
  );
}

export function MetricsDashboard({ onBack, initialProjectId }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(initialProjectId ?? null);
  const [series, setSeries] = useState<Snapshot[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api.get('/projects')
      .then(({ data }) => {
        const list: Project[] = (data || []).map((p: { id: number; name: string }) => ({ id: p.id, name: p.name }));
        setProjects(list);
        setProjectId(prev => prev ?? (list[0]?.id ?? null));
      })
      .catch(() => setError('Не удалось загрузить список проектов'))
      .finally(() => setLoadingProjects(false));
  }, []);

  useEffect(() => {
    if (projectId == null) return;
    setLoading(true);
    setError(null);
    api.get(`/projects/${projectId}/metrics/history?limit=2000`)
      .then(({ data }) => setSeries(data.series || []))
      .catch(() => setError('Не удалось загрузить историю метрик'))
      .finally(() => setLoading(false));
  }, [projectId, reloadKey]);

  const xDates = useMemo(() => series.map(s => s.createdAt), [series]);
  const latest = series.length ? series[series.length - 1] : null;

  const tierKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const s of series) for (const k of Object.keys(s.tierBreakdown || {})) keys.add(k);
    return [...keys];
  }, [series]);

  const coverageSeries: ChartSeries[] = [
    { label: 'Покрытие', color: '#2563eb', values: series.map(s => s.coverage) },
    { label: 'Подтверждено', color: '#16a34a', values: series.map(s => s.confirmedPct) },
  ];
  const tierSeries: ChartSeries[] = tierKeys.map((k, i) => ({
    label: tierLabel(k), color: tierColor(k, i), values: series.map(s => s.tierBreakdown?.[k] ?? 0),
  }));
  const rulesSeries: ChartSeries[] = [{ label: 'Правила', color: '#2563eb', values: series.map(s => s.learnedRules) }];
  const synSeries: ChartSeries[] = [{ label: 'Синонимы', color: '#7c3aed', values: series.map(s => s.learnedSynonyms) }];

  const actionIndices = useMemo(
    () => series.map((s, i) => (s.kind === 'operator_action' ? i : -1)).filter(i => i >= 0),
    [series],
  );
  const pointTitle = (i: number) => {
    const s = series[i];
    if (!s) return '';
    const k = KIND_LABELS[s.kind] || s.kind;
    const act = s.actionType ? ` (${ACTION_LABELS[s.actionType] || s.actionType})` : '';
    return `${fmtDateTime(s.createdAt)} · ${k}${act} · покрытие ${s.coverage}%, подтв. ${s.confirmed}`;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>📊 Метрики обучения</h2>
        <button className="btn btn-secondary" onClick={onBack}>Назад</button>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div className="field" style={{ minWidth: 240 }}>
          <label>Проект</label>
          <select
            value={projectId ?? ''}
            onChange={e => setProjectId(e.target.value ? Number(e.target.value) : null)}
            disabled={loadingProjects || projects.length === 0}
          >
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <button className="btn btn-secondary" onClick={() => setReloadKey(k => k + 1)} disabled={loading || projectId == null}>
          ↻ Обновить
        </button>
        {series.length > 0 && (
          <span className="muted" style={{ marginBottom: '0.4rem' }}>
            {series.length} снимков · {fmtDate(series[0].createdAt)}–{fmtDate(series[series.length - 1].createdAt)}
          </span>
        )}
      </div>

      {error && <p className="error-msg">{error}</p>}

      {loadingProjects ? (
        <p className="loading">Загрузка проектов</p>
      ) : projects.length === 0 ? (
        <p className="muted">Нет проектов.</p>
      ) : loading ? (
        <p className="loading">Загрузка метрик</p>
      ) : series.length === 0 ? (
        <p className="muted">
          Нет снимков метрик для этого проекта. Снимки появляются при прогоне сопоставления,
          при действиях оператора, а также на старте сервера и раз в день.
        </p>
      ) : (
        <>
          {latest && (
            <div className="matching-summary">
              <div className="summary-card summary-matched">
                <div className="summary-value">{latest.coverage}%</div>
                <div className="summary-label">Покрытие ({latest.matched}/{latest.total})</div>
              </div>
              <div className="summary-card summary-confirmed">
                <div className="summary-value">{latest.confirmed}</div>
                <div className="summary-label">Подтверждено ({latest.confirmedPct}%)</div>
              </div>
              <div className="summary-card">
                <div className="summary-value">{latest.learnedRules}</div>
                <div className="summary-label">Правила (глобально)</div>
              </div>
              <div className="summary-card">
                <div className="summary-value">{latest.learnedSynonyms}</div>
                <div className="summary-label">Синонимы (глобально)</div>
              </div>
            </div>
          )}

          <ChartCard
            title="📈 Покрытие и подтверждение, %"
            subtitle="Доля позиций спецификации с матчем (покрытие) и подтверждённых оператором. Точки действий оператора отмечены."
            legend={<Legend items={[
              { label: 'Покрытие', color: '#2563eb', value: `${latest?.coverage ?? 0}%` },
              { label: 'Подтверждено', color: '#16a34a', value: `${latest?.confirmedPct ?? 0}%` },
            ]} />}
          >
            <LineChart series={coverageSeries} xDates={xDates} yMax={100} yUnit="%"
              markerIndices={actionIndices} pointTitle={pointTitle} />
          </ChartCard>

          <ChartCard
            title="🧩 Состав сопоставления по тирам"
            subtitle="Сколько позиций тянет каждый механизм. Рост «Правила» = система выучила домен; «GigaChat (LLM)» обобщает на новые домены до операторских правил."
            legend={<Legend items={tierSeries.map(s => ({
              label: s.label, color: s.color, value: String(s.values[s.values.length - 1] ?? 0),
            }))} />}
          >
            {tierSeries.length === 0
              ? <p className="muted">Нет данных по тирам.</p>
              : <LineChart series={tierSeries} xDates={xDates} pointTitle={pointTitle} />}
          </ChartCard>

          <ChartCard
            title="🧠 Рост памяти системы (глобально)"
            subtitle="Выученные правила и синонимы — общие для всех проектов, растут по мере обучения оператором."
          >
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <Legend items={[{ label: 'Правила', color: '#2563eb', value: String(latest?.learnedRules ?? 0) }]} />
                <LineChart series={rulesSeries} xDates={xDates} height={180} pointTitle={pointTitle} />
              </div>
              <div style={{ flex: 1, minWidth: 280 }}>
                <Legend items={[{ label: 'Синонимы', color: '#7c3aed', value: String(latest?.learnedSynonyms ?? 0) }]} />
                <LineChart series={synSeries} xDates={xDates} height={180} pointTitle={pointTitle} />
              </div>
            </div>
          </ChartCard>
        </>
      )}
    </div>
  );
}
