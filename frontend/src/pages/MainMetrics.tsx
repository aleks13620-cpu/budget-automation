import { useEffect, useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';

/**
 * Главные показатели проектов — минимальная версия (5 карточек на проект).
 * Бриф: docs/plans/active/worker_brief_2026-06-14_metrics_dashboard_v1.md.
 *
 * Что показывает: один ряд на «живой» проект, в нём 5 квадратов:
 *   1. «Что видит оператор» — какая доля строк сметы получает кандидата.
 *   2. «Сколько раз система угадывает с первого раза» — плашка «честное число будет позже»
 *      (пока эндпоинт скрывает соперников у подтверждённых матчей; правка отдельным брифом).
 *   3. «Сколько работы делает Память» — доля строк, сведённых выученным правилом без платного ИИ.
 *   4. «Сколько раз система уверенно ошиблась» — плашка «нужен сбор данных от оператора».
 *   5. «Сколько кликов сделал оператор» — плашка «нужен сбор событий».
 *
 * Зачем: §0 брифа — постоянный видимый контроль главной метрики плана
 * (Точность @1 на матчимом ≥ 80% на выборке живых проектов). Сейчас карточки
 * 1 и 3 показывают живые цифры, остальные — честные плашки, чтобы НЕ создать
 * иллюзию полноты замеров до того, как замеры реально будут.
 *
 * Сознательно НЕ делаем (см. §5 брифа): ленту событий, ИИ-комментатор,
 * телеграм-сводку, графики, иконки, анимацию. Это всё отдельные итерации
 * после доказательства, что таблица сама по себе помогает решениям.
 */

interface MetricRow {
  project_id: number;
  project_name: string;
  spec_total: number;
  with_any_candidate: number;
  without_candidate: number;
  memory_top1: number;
  llm_top1: number;
  name_sim_top1: number;
  manual_top1: number;
  exact_article_top1: number;
  name_characteristics_top1: number;
  operator_confirmed: number;
  accuracy_at_1_status: 'tautology' | 'honest' | 'n/a';
  accuracy_at_1_value: number | null;
}

interface Props {
  onBack: () => void;
}

// Card colour: green (target hit), amber (in progress), red (far from target),
// gray (placeholder card with no live number yet). Centralised so all cards
// follow the same colour rule and the legend at the top of the page can show
// it clearly.
type Tone = 'green' | 'amber' | 'red' | 'gray';
const toneStyles: Record<Tone, { bg: string; border: string; text: string }> = {
  green: { bg: '#dcfce7', border: '#16a34a', text: '#14532d' },
  amber: { bg: '#fef3c7', border: '#f59e0b', text: '#78350f' },
  red:   { bg: '#fee2e2', border: '#dc2626', text: '#7f1d1d' },
  gray:  { bg: '#f3f4f6', border: '#9ca3af', text: '#374151' },
};

function pctTone(pct: number): Tone {
  if (pct >= 80) return 'green';
  if (pct >= 50) return 'amber';
  return 'red';
}

function MetricCard({
  title, big, sub, hint, tone,
}: {
  title: string;
  big: ReactNode;
  sub?: ReactNode;
  hint: string;
  tone: Tone;
}) {
  const s = toneStyles[tone];
  return (
    <div
      title={hint}
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 8,
        padding: '0.75rem',
        minWidth: 140,
        width: 160,
        height: 130,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        cursor: 'help',
      }}
    >
      <div style={{ fontSize: '0.72rem', color: s.text, fontWeight: 600, lineHeight: 1.2 }}>
        {title}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: s.text, textAlign: 'center' }}>
        {big}
      </div>
      <div style={{ fontSize: '0.7rem', color: s.text, opacity: 0.85, textAlign: 'center', minHeight: 16 }}>
        {sub}
      </div>
    </div>
  );
}

const HINTS = {
  coverage: 'Сколько строк сметы получают хоть какой-то вариант от системы. ' +
            'Если мало — оператор открывает проект и видит сплошную пустоту. ' +
            'Чем выше — тем меньше работы вручную. Цель: 90% и выше.',
  accuracy: 'Сейчас сервер для подтверждённых строк отдаёт только подтверждение, ' +
            'скрывая других кандидатов. Поэтому замер всегда даёт 100% — это враньё. ' +
            'Чиним отдельной правкой. Цель: средняя по проектам ≥ 80%.',
  memory:   'Доля строк, для которых система предложила правильный аналог из своей ' +
            'записной книжки, без обращения к платному ИИ. Чем выше — тем дешевле и ' +
            'быстрее работа. На зрелых проектах должна расти.',
  falsepos: 'Сколько случаев, когда система выдала уверенный аналог, а оператор пометил ' +
            'его как неверный. Сейчас в системе нет такого события — нужна отдельная ' +
            'задача на его сбор. Карточка пустая.',
  clicks:   'Сколько действий оператор сделал на проект, чтобы довести его до готового. ' +
            'Сейчас в системе нет журнала кликов — нужна отдельная задача на сбор. ' +
            'Карточка пустая.',
} as const;

function renderRow(row: MetricRow): ReactNode {
  const covPct = row.spec_total > 0 ? Math.round((row.with_any_candidate / row.spec_total) * 100) : 0;
  const memPct = row.with_any_candidate > 0
    ? Math.round((row.memory_top1 / row.with_any_candidate) * 100)
    : 0;

  return (
    <div
      key={row.project_id}
      style={{ borderTop: '1px solid #e5e7eb', padding: '0.9rem 0' }}
    >
      <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: '0.55rem' }}>
        {row.project_name}{' '}
        <span style={{ fontSize: '0.78rem', color: '#6b7280', fontWeight: 400 }}>
          (id {row.project_id}, всего строк: {row.spec_total})
        </span>
      </div>

      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <MetricCard
          title="Что видит оператор"
          big={`${covPct}%`}
          sub={`${row.with_any_candidate} из ${row.spec_total}`}
          hint={HINTS.coverage}
          tone={pctTone(covPct)}
        />

        <MetricCard
          title="Угадывает с первого раза"
          big={<span style={{ fontSize: '0.85rem', fontWeight: 600 }}>честное число<br/>будет позже</span>}
          sub="нужна правка ответа сервера"
          hint={HINTS.accuracy}
          tone="gray"
        />

        <MetricCard
          title="Сколько делает Память"
          big={`${memPct}%`}
          sub={`${row.memory_top1} из ${row.with_any_candidate}`}
          hint={HINTS.memory}
          // У Памяти своя цель «40%+ на зрелом, новые растут с 0», поэтому
          // вилки шире, чем у Покрытия (80%/50%): 40%+ зелёный, 15-39% жёлтый,
          // <15% красный. См. project_global_metrics_dashboard.md Б2.
          tone={memPct >= 40 ? 'green' : memPct >= 15 ? 'amber' : 'red'}
        />

        <MetricCard
          title="Уверенно ошиблась"
          big={<span style={{ fontSize: '0.85rem', fontWeight: 600 }}>нужен сбор<br/>данных</span>}
          sub="событие пока не пишется"
          hint={HINTS.falsepos}
          tone="gray"
        />

        <MetricCard
          title="Кликов оператора"
          big={<span style={{ fontSize: '0.85rem', fontWeight: 600 }}>нужен сбор<br/>событий</span>}
          sub="журнал пока не пишется"
          hint={HINTS.clicks}
          tone="gray"
        />
      </div>

      {/* Прозрачные мелкие цифры, чтобы можно было сверить с прямым API.
          Показываем все типы матчей с > 0 — короче, не засоряем нулями. */}
      <Top1Breakdown row={row} />
    </div>
  );
}

/**
 * Сноска под карточками — разбивка top-1 по типу матча.
 * Показывает только те типы, где > 0 (короче, не засоряет нулями).
 * Контроль: сумма всех «top1»-полей + «Без варианта» должна равняться `spec_total`.
 * Если не сходится — есть тип, которого мы не учли (warning в консоль).
 */
function Top1Breakdown({ row }: { row: MetricRow }) {
  // Все типы top-1 + «без варианта». Порядок — от самого ценного (подтверждение
  // оператора и Память) к самым «дешёвым» догадкам (ИИ, имя, характеристики).
  const items: Array<{ label: string; value: number }> = [
    { label: 'Подтверждено оператором', value: row.operator_confirmed },
    { label: 'Память (Memory)', value: row.memory_top1 },
    { label: 'Подтверждение в прошлом (manual)', value: row.manual_top1 },
    { label: 'Точное совпадение артикула', value: row.exact_article_top1 },
    { label: 'ИИ (Gemini)', value: row.llm_top1 },
    { label: 'По сходству имён', value: row.name_sim_top1 },
    { label: 'По имени и характеристикам', value: row.name_characteristics_top1 },
    { label: 'Без варианта', value: row.without_candidate },
  ];

  // Контроль (warning в консоль, страница не падает): сумма всех top-1 типов +
  // «без варианта» должна равняться spec_total. Если меньше — есть match_type,
  // которого мы не учли (например new tier ниже по тексту), и мы недосчитываем.
  // «Подтверждено оператором» в эту сумму НЕ входит — это срез по статусу, а
  // не по типу матча (он перекрывается с top1-типами).
  const top1Sum =
    row.memory_top1
    + row.manual_top1
    + row.exact_article_top1
    + row.llm_top1
    + row.name_sim_top1
    + row.name_characteristics_top1
    + row.without_candidate;
  if (top1Sum !== row.spec_total) {
    // eslint-disable-next-line no-console
    console.warn(
      `[MainMetrics] Проект ${row.project_id} «${row.project_name}»: сумма top-1 типов + без варианта = ${top1Sum}, но spec_total = ${row.spec_total}. Не хватает ${row.spec_total - top1Sum} — есть match_type, которого мы не учли в разбивке.`
    );
  }

  const shown = items.filter(it => it.value > 0);
  return (
    <div style={{ fontSize: '0.72rem', color: '#6b7280', marginTop: '0.55rem' }}>
      {shown.map((it, idx) => (
        <span key={it.label}>
          {it.label}: <b>{it.value}</b>
          {idx < shown.length - 1 && ' · '}
        </span>
      ))}
    </div>
  );
}

export function MainMetrics({ onBack }: Props) {
  const [rows, setRows] = useState<MetricRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    api.get('/metrics/dashboard')
      .then(({ data }) => { if (!stale) setRows(Array.isArray(data) ? data : []); })
      .catch(() => { if (!stale) setError('Не удалось загрузить главные показатели'); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [reloadKey]);

  const avgCoverage = useMemo(() => {
    if (rows.length === 0) return null;
    const s = rows.reduce((acc, r) => acc + (r.spec_total > 0 ? r.with_any_candidate / r.spec_total : 0), 0);
    return Math.round((s / rows.length) * 100);
  }, [rows]);

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '1rem',
      }}>
        <h2 style={{ margin: 0 }}>Главные показатели проектов</h2>
        <div>
          <button
            className="btn btn-secondary"
            onClick={() => setReloadKey(k => k + 1)}
            disabled={loading}
            style={{ marginRight: '0.5rem' }}
          >
            Обновить
          </button>
          <button className="btn btn-secondary" onClick={onBack}>Назад</button>
        </div>
      </div>

      {/* Краткое пояснение, чтобы оператор/владелец понимал, что видит */}
      <div style={{
        background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8,
        padding: '0.7rem 0.9rem', marginBottom: '1rem', fontSize: '0.85rem', color: '#374151',
      }}>
        <div style={{ marginBottom: '0.3rem' }}>
          Главная метрика плана — средняя «угадывает с первого раза» по выборке живых
          проектов <b>не ниже 80%</b>. Сейчас этот замер невозможен честно: ответ сервера
          для подтверждённых строк скрывает других кандидатов. Поэтому центральная карточка
          у каждого проекта — серая плашка «честное число будет позже».
        </div>
        <div>
          Зелёный квадрат — хорошо (80%+), жёлтый — в работе (50-79%), красный — мало (&lt;50%),
          серый — пока не замеряется. Наведите мышкой на квадрат, чтобы прочитать подсказку.
          {avgCoverage != null && (
            <span> Средняя по показанным проектам: <b>{avgCoverage}%</b> покрытия.</span>
          )}
        </div>
      </div>

      {error && <p className="error-msg">{error}</p>}

      {loading
        ? <p className="loading">Загрузка</p>
        : rows.length === 0
          ? <p className="muted">Нет живых проектов для показа.</p>
          : <div>{rows.map(renderRow)}</div>}
    </div>
  );
}
