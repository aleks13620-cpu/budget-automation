export interface SpecificationRow {
  position_number: string | null;
  name: string;
  characteristics: string | null;
  equipment_code: string | null;
  article: string | null;
  product_code: string | null;
  marking: string | null;
  type_size: string | null;
  manufacturer: string | null;
  unit: string | null;
  quantity: number | null;
  full_name: string | null;
  /** Index into items array — resolved to DB id during INSERT, not stored in DB directly */
  _parentIndex: number | null;
}

export interface SpecPdfParseQuality {
  warnings: string[];
  suggestElevatedReview: boolean;
  /** Доля строк без № позиции (0..1). Сигнал для LLM-фолбэка парсера. */
  noPosFraction: number;
  /** Доля строк-сирот: без № и без привязки к родителю (0..1). */
  orphanFraction: number;
  /**
   * Доля «голых» сирот (0..1): сирота, чьё имя — бессмысленный без родителя
   * фрагмент/код (C11-300-500, DN15, «То же»). Именно это = развал иерархии.
   * Длинные самодостаточные имена (плоский список) сюда НЕ попадают.
   */
  bareOrphanFraction: number;
  /**
   * Жёсткая блокировка загрузки: иерархия катастрофически развалена
   * (битые данные НЕ должны течь в матчер/обучение — feedback_no_corrupt_through).
   */
  hardBlock: boolean;
}

export interface ParseResult {
  items: SpecificationRow[];
  errors: string[];
  totalRows: number;
  skippedRows: number;
  /** PDF: нет извлечённых позиций — можно внести вручную в редакторе */
  category?: 'C';
  categoryReason?: string | null;
  specParseQuality?: SpecPdfParseQuality;
}
