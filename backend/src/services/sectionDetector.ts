const SECTION_RULES: Record<string, string[]> = {
  'Электрика': [
    'кабель', 'провод', 'автомат', 'щит', 'розетк', 'выключател',
    'светильник', 'лампа', 'узо', 'рубильник', 'электро',
  ],
  'ВК': [
    'труба', 'задвижк', 'кран', 'клапан', 'фильтр', 'насос',
    'водосчётчик', 'водосчетчик', 'смесител', 'унитаз', 'раковин',
    'канализац', 'водоснабж', 'водоотвед', 'сифон', 'полотенцесуш',
  ],
  'Вентиляция': [
    'вентилятор', 'диффузор', 'воздуховод', 'решётк', 'решетк',
    'клапан воздуш', 'заслонк', 'рекуператор', 'приточн', 'вытяжн',
  ],
  'Отопление': [
    'радиатор', 'котёл', 'котел', 'конвектор', 'теплосчётчик',
    'теплосчетчик', 'термостат', 'коллектор',
  ],
  'Тепломеханика/ИТП': [
    'теплообменник', 'насосная', 'итп', 'тепловой пункт', 'узел учёта',
    'узел учета', 'теплоузел', 'тепломеханик',
  ],
  'Автоматизация': [
    'датчик', 'контроллер', 'автоматик', 'привод', 'кипиа',
    'кип и а', 'термопар', 'сигнализатор',
  ],
  'Кондиционирование': [
    'кондиционер', 'сплит', 'фанкойл', 'чиллер', 'фреон',
    'мульти-сплит', 'мультисплит', 'vrv', 'vrf',
  ],
  'Слаботочка': [
    'камера', 'видеонаблюд', 'скуд', 'домофон', 'скс',
    'оптоволокн', 'видеокамер', 'контрол доступ', 'охранн',
  ],
};

// Filename keywords for section detection
const FILENAME_KEYWORDS: Record<string, string[]> = {
  'Электрика': ['электр', 'эом', 'эл_', 'эл.', 'el_', 'electr'],
  'ВК': ['вк', 'водоснаб', 'канализ', 'вод_', 'water'],
  'Вентиляция': ['вент', 'ов_', 'vent', 'возд'],
  'Отопление': ['отопл', 'от_', 'heat'],
  'Тепломеханика/ИТП': ['итп', 'тепломех', 'тм_', 'itp'],
  'Автоматизация': ['автомат', 'акит', 'кипиа', 'auto'],
  'Кондиционирование': ['конд', 'хв_', 'кв_', 'cond'],
  'Слаботочка': ['слабот', 'сс_', 'скуд', 'видео', 'скс'],
};

export function detectSection(name: string, characteristics?: string | null): string | null {
  const text = `${name} ${characteristics || ''}`.toLowerCase();

  for (const [section, keywords] of Object.entries(SECTION_RULES)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return section;
      }
    }
  }

  return null;
}

/**
 * Detect section from a list of item names using majority voting.
 */
export function detectSectionFromItems(items: { name: string; characteristics?: string | null }[]): string | null {
  if (items.length === 0) return null;

  const votes: Record<string, number> = {};

  for (const item of items) {
    const section = detectSection(item.name, item.characteristics);
    if (section) {
      votes[section] = (votes[section] || 0) + 1;
    }
  }

  const entries = Object.entries(votes);
  if (entries.length === 0) return null;

  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/**
 * Detect section from filename by keyword matching.
 */
export function detectSectionFromFilename(filename: string): string | null {
  const lower = filename.toLowerCase().replace(/[_\-\.]/g, ' ');

  for (const [section, keywords] of Object.entries(FILENAME_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        return section;
      }
    }
  }

  return null;
}
