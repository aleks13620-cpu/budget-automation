// SQL схема базы данных для системы автоматизации расчётов

export const CREATE_TABLES_SQL = `
-- Проекты
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Спецификации (по разделам)
CREATE TABLE IF NOT EXISTS specifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  section TEXT NOT NULL,
  file_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Позиции спецификации (из Excel-файла заказчика)
CREATE TABLE IF NOT EXISTS specification_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  specification_id INTEGER,
  position_number TEXT,
  name TEXT NOT NULL,
  characteristics TEXT,
  equipment_code TEXT,
  manufacturer TEXT,
  unit TEXT,
  quantity REAL,
  section TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (specification_id) REFERENCES specifications(id) ON DELETE CASCADE
);

-- Поставщики
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact_info TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Счета от поставщиков
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  supplier_id INTEGER,
  invoice_number TEXT,
  invoice_date DATE,
  file_name TEXT,
  file_path TEXT,
  total_amount REAL,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

-- Позиции счетов (распарсенные данные)
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  article TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  quantity REAL,
  price REAL,
  amount REAL,
  row_index INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

-- Правила сопоставления (база знаний)
CREATE TABLE IF NOT EXISTS matching_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specification_pattern TEXT NOT NULL,
  invoice_pattern TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  is_analog INTEGER DEFAULT 0,
  times_used INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Результаты сопоставления
CREATE TABLE IF NOT EXISTS matched_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specification_item_id INTEGER NOT NULL,
  invoice_item_id INTEGER NOT NULL,
  confidence REAL,
  match_type TEXT,
  is_confirmed INTEGER DEFAULT 0,
  is_selected INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (specification_item_id) REFERENCES specification_items(id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id) ON DELETE CASCADE
);

-- Настройки парсеров для поставщиков
CREATE TABLE IF NOT EXISTS supplier_parser_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL UNIQUE,
  config JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
);

-- Индексы для ускорения поиска
CREATE INDEX IF NOT EXISTS idx_specifications_project ON specifications(project_id);
CREATE INDEX IF NOT EXISTS idx_spec_items_project ON specification_items(project_id);
CREATE INDEX IF NOT EXISTS idx_spec_items_spec ON specification_items(specification_id);
CREATE INDEX IF NOT EXISTS idx_spec_items_name ON specification_items(name);
CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_article ON invoice_items(article);
CREATE INDEX IF NOT EXISTS idx_invoice_items_name ON invoice_items(name);
CREATE INDEX IF NOT EXISTS idx_matched_items_spec ON matched_items(specification_item_id);
CREATE INDEX IF NOT EXISTS idx_matched_items_invoice ON matched_items(invoice_item_id);
CREATE INDEX IF NOT EXISTS idx_matching_rules_spec ON matching_rules(specification_pattern);
`;
