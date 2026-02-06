const SECTION_RULES: Record<string, string[]> = {
  'Электрика': [
    'кабель', 'провод', 'автомат', 'щит', 'розетк', 'выключател',
    'светильник', 'лампа', 'узо', 'рубильник',
  ],
  'Водоснабжение и канализация (ВК)': [
    'труба', 'задвижк', 'кран', 'клапан', 'фильтр', 'насос',
    'водосчётчик', 'водосчетчик', 'смесител', 'унитаз', 'раковин',
  ],
  'Вентиляция': [
    'вентилятор', 'диффузор', 'воздуховод', 'решётк', 'решетк',
    'клапан воздуш', 'заслонк', 'рекуператор',
  ],
  'Отопление': [
    'радиатор', 'котёл', 'котел', 'конвектор', 'теплосчётчик',
    'теплосчетчик', 'термостат', 'коллектор',
  ],
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
