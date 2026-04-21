# Database Structure

Документ описывает текущую структуру БД проекта.

## Manual notes

- В этом разделе фиксируйте бизнес-контекст и причины изменений схемы.
- После изменения структуры БД запускайте `npm run problem-registry:db:snapshot` в `backend`.

<!-- AUTO-GENERATED:START -->

## Auto-generated schema snapshot

Source DB: `database/budget_automation.db`
Generated: 2026-04-15T17:43:01.306Z

### Table: construction_synonyms
```sql
CREATE TABLE construction_synonyms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  abbreviation TEXT NOT NULL,
  full_form TEXT NOT NULL,
  category TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',
  times_used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| abbreviation | TEXT | 1 | 0 |  |
| full_form | TEXT | 1 | 0 |  |
| category | TEXT | 1 | 0 |  |
| source | TEXT | 1 | 0 | 'seed' |
| times_used | INTEGER | 0 | 0 | 0 |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: gigachat_file_cache
```sql
CREATE TABLE gigachat_file_cache (
  file_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (file_hash, purpose)
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| file_hash | TEXT | 1 | 1 |  |
| purpose | TEXT | 1 | 2 |  |
| response_json | TEXT | 1 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: gigachat_match_cache
```sql
CREATE TABLE gigachat_match_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_text TEXT NOT NULL,
  invoice_text TEXT NOT NULL,
  is_match INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(spec_text, invoice_text)
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| spec_text | TEXT | 1 | 0 |  |
| invoice_text | TEXT | 1 | 0 |  |
| is_match | INTEGER | 1 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: invoice_items
```sql
CREATE TABLE invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  article TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  quantity REAL,
  price REAL,
  amount REAL,
  row_index INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, is_manual INTEGER DEFAULT 0, is_delivery INTEGER DEFAULT 0, quantity_packages REAL DEFAULT NULL, needs_unit_review INTEGER DEFAULT 0, original_price REAL DEFAULT NULL, original_unit TEXT DEFAULT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| invoice_id | INTEGER | 1 | 0 |  |
| article | TEXT | 0 | 0 |  |
| name | TEXT | 1 | 0 |  |
| unit | TEXT | 0 | 0 |  |
| quantity | REAL | 0 | 0 |  |
| price | REAL | 0 | 0 |  |
| amount | REAL | 0 | 0 |  |
| row_index | INTEGER | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| is_manual | INTEGER | 0 | 0 | 0 |
| is_delivery | INTEGER | 0 | 0 | 0 |
| quantity_packages | REAL | 0 | 0 | NULL |
| needs_unit_review | INTEGER | 0 | 0 | 0 |
| original_price | REAL | 0 | 0 | NULL |
| original_unit | TEXT | 0 | 0 | NULL |

### Table: invoice_items_history
```sql
CREATE TABLE invoice_items_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  items_snapshot TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| invoice_id | INTEGER | 1 | 0 |  |
| version | INTEGER | 1 | 0 |  |
| items_snapshot | TEXT | 1 | 0 |  |
| action | TEXT | 1 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: invoices
```sql
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  supplier_id INTEGER,
  invoice_number TEXT,
  invoice_date DATE,
  file_name TEXT,
  file_path TEXT,
  total_amount REAL,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, parsing_category TEXT, parsing_category_reason TEXT, discount_detected REAL DEFAULT NULL, discount_applied INTEGER DEFAULT 0, vat_amount REAL DEFAULT NULL, needs_amount_review INTEGER DEFAULT 0, vat_rate INTEGER DEFAULT 22,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| project_id | INTEGER | 1 | 0 |  |
| supplier_id | INTEGER | 0 | 0 |  |
| invoice_number | TEXT | 0 | 0 |  |
| invoice_date | DATE | 0 | 0 |  |
| file_name | TEXT | 0 | 0 |  |
| file_path | TEXT | 0 | 0 |  |
| total_amount | REAL | 0 | 0 |  |
| status | TEXT | 0 | 0 | 'pending' |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| parsing_category | TEXT | 0 | 0 |  |
| parsing_category_reason | TEXT | 0 | 0 |  |
| discount_detected | REAL | 0 | 0 | NULL |
| discount_applied | INTEGER | 0 | 0 | 0 |
| vat_amount | REAL | 0 | 0 | NULL |
| needs_amount_review | INTEGER | 0 | 0 | 0 |
| vat_rate | INTEGER | 0 | 0 | 22 |

### Table: matched_items
```sql
CREATE TABLE matched_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specification_item_id INTEGER NOT NULL,
  invoice_item_id INTEGER NOT NULL,
  confidence REAL,
  match_type TEXT,
  is_confirmed INTEGER DEFAULT 0,
  is_selected INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, source TEXT DEFAULT 'invoice', is_analog INTEGER DEFAULT 0,
  FOREIGN KEY (specification_item_id) REFERENCES specification_items(id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_item_id) REFERENCES invoice_items(id) ON DELETE CASCADE
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| specification_item_id | INTEGER | 1 | 0 |  |
| invoice_item_id | INTEGER | 1 | 0 |  |
| confidence | REAL | 0 | 0 |  |
| match_type | TEXT | 0 | 0 |  |
| is_confirmed | INTEGER | 0 | 0 | 0 |
| is_selected | INTEGER | 0 | 0 | 0 |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| source | TEXT | 0 | 0 | 'invoice' |
| is_analog | INTEGER | 0 | 0 | 0 |

### Table: matching_rules
```sql
CREATE TABLE matching_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specification_pattern TEXT NOT NULL,
  invoice_pattern TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  is_analog INTEGER DEFAULT 0,
  times_used INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, supplier_id INTEGER REFERENCES suppliers(id), is_negative INTEGER DEFAULT 0, source TEXT DEFAULT 'manual')
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| specification_pattern | TEXT | 1 | 0 |  |
| invoice_pattern | TEXT | 1 | 0 |  |
| confidence | REAL | 0 | 0 | 1.0 |
| is_analog | INTEGER | 0 | 0 | 0 |
| times_used | INTEGER | 0 | 0 | 1 |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| updated_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| supplier_id | INTEGER | 0 | 0 |  |
| is_negative | INTEGER | 0 | 0 | 0 |
| source | TEXT | 0 | 0 | 'manual' |

### Table: operator_feedback
```sql
CREATE TABLE operator_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  spec_item_id INTEGER REFERENCES specification_items(id) ON DELETE SET NULL,
  invoice_item_id INTEGER,
  comment TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
, status TEXT DEFAULT 'new')
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| type | TEXT | 1 | 0 |  |
| project_id | INTEGER | 0 | 0 |  |
| spec_item_id | INTEGER | 0 | 0 |  |
| invoice_item_id | INTEGER | 0 | 0 |  |
| comment | TEXT | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| status | TEXT | 0 | 0 | 'new' |

### Table: price_list_items
```sql
CREATE TABLE price_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  article TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  price REAL,
  row_index INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| price_list_id | INTEGER | 1 | 0 |  |
| article | TEXT | 0 | 0 |  |
| name | TEXT | 1 | 0 |  |
| unit | TEXT | 0 | 0 |  |
| price | REAL | 0 | 0 |  |
| row_index | INTEGER | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: price_lists
```sql
CREATE TABLE price_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supplier_id INTEGER REFERENCES suppliers(id),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  parser_config JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| project_id | INTEGER | 1 | 0 |  |
| supplier_id | INTEGER | 0 | 0 |  |
| file_name | TEXT | 1 | 0 |  |
| file_path | TEXT | 1 | 0 |  |
| status | TEXT | 0 | 0 | 'pending' |
| parser_config | JSON | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: projects
```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| name | TEXT | 1 | 0 |  |
| description | TEXT | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| updated_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: size_synonyms
```sql
CREATE TABLE size_synonyms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical TEXT NOT NULL,
  synonym TEXT NOT NULL UNIQUE
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| canonical | TEXT | 1 | 0 |  |
| synonym | TEXT | 1 | 0 |  |

### Table: spec_parse_rules
```sql
CREATE TABLE spec_parse_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specification_id INTEGER REFERENCES specifications(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  corrected_value TEXT NOT NULL,
  times_used INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| specification_id | INTEGER | 0 | 0 |  |
| field | TEXT | 1 | 0 |  |
| raw_value | TEXT | 1 | 0 |  |
| corrected_value | TEXT | 1 | 0 |  |
| times_used | INTEGER | 0 | 0 | 1 |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: specification_items
```sql
CREATE TABLE specification_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  position_number TEXT,
  name TEXT NOT NULL,
  characteristics TEXT,
  equipment_code TEXT,
  manufacturer TEXT,
  unit TEXT,
  quantity REAL,
  section TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, specification_id INTEGER REFERENCES specifications(id) ON DELETE CASCADE, parent_item_id INTEGER REFERENCES specification_items(id), full_name TEXT, article TEXT, product_code TEXT, marking TEXT, type_size TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| project_id | INTEGER | 1 | 0 |  |
| position_number | TEXT | 0 | 0 |  |
| name | TEXT | 1 | 0 |  |
| characteristics | TEXT | 0 | 0 |  |
| equipment_code | TEXT | 0 | 0 |  |
| manufacturer | TEXT | 0 | 0 |  |
| unit | TEXT | 0 | 0 |  |
| quantity | REAL | 0 | 0 |  |
| section | TEXT | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| specification_id | INTEGER | 0 | 0 |  |
| parent_item_id | INTEGER | 0 | 0 |  |
| full_name | TEXT | 0 | 0 |  |
| article | TEXT | 0 | 0 |  |
| product_code | TEXT | 0 | 0 |  |
| marking | TEXT | 0 | 0 |  |
| type_size | TEXT | 0 | 0 |  |

### Table: specification_items_history
```sql
CREATE TABLE specification_items_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specification_id INTEGER NOT NULL REFERENCES specifications(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  items_snapshot TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| specification_id | INTEGER | 1 | 0 |  |
| version | INTEGER | 1 | 0 |  |
| items_snapshot | TEXT | 1 | 0 |  |
| action | TEXT | 1 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: specification_parser_configs
```sql
CREATE TABLE specification_parser_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specification_id INTEGER NOT NULL UNIQUE REFERENCES specifications(id) ON DELETE CASCADE,
  header_row INTEGER NOT NULL,
  column_mapping TEXT NOT NULL,
  merge_multiline INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| specification_id | INTEGER | 1 | 0 |  |
| header_row | INTEGER | 1 | 0 |  |
| column_mapping | TEXT | 1 | 0 |  |
| merge_multiline | INTEGER | 1 | 0 | 1 |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| updated_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: specifications
```sql
CREATE TABLE specifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  section TEXT NOT NULL,
  file_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, raw_data TEXT, parse_source TEXT DEFAULT 'excel',
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| project_id | INTEGER | 1 | 0 |  |
| section | TEXT | 1 | 0 |  |
| file_name | TEXT | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| raw_data | TEXT | 0 | 0 |  |
| parse_source | TEXT | 0 | 0 | 'excel' |

### Table: supplier_parser_configs
```sql
CREATE TABLE supplier_parser_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL UNIQUE,
  config JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| supplier_id | INTEGER | 1 | 0 |  |
| config | JSON | 1 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| updated_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

### Table: suppliers
```sql
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact_info TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
, vat_rate INTEGER DEFAULT 20, prices_include_vat INTEGER DEFAULT 1)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| name | TEXT | 1 | 0 |  |
| contact_info | TEXT | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |
| vat_rate | INTEGER | 0 | 0 | 20 |
| prices_include_vat | INTEGER | 0 | 0 | 1 |

### Table: unit_conversion_triggers
```sql
CREATE TABLE unit_conversion_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  from_unit TEXT,
  to_unit TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

| Column | Type | Not Null | PK | Default |
|---|---|---:|---:|---|
| id | INTEGER | 0 | 1 |  |
| keyword | TEXT | 1 | 0 |  |
| from_unit | TEXT | 0 | 0 |  |
| to_unit | TEXT | 1 | 0 |  |
| description | TEXT | 0 | 0 |  |
| created_at | DATETIME | 0 | 0 | CURRENT_TIMESTAMP |

## Indices

- construction_synonyms.idx_construction_syn_unique
```sql
CREATE UNIQUE INDEX idx_construction_syn_unique ON construction_synonyms(abbreviation, full_form, category)
```
- invoice_items.idx_invoice_items_article
```sql
CREATE INDEX idx_invoice_items_article ON invoice_items(article)
```
- invoice_items.idx_invoice_items_invoice
```sql
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id)
```
- invoice_items.idx_invoice_items_name
```sql
CREATE INDEX idx_invoice_items_name ON invoice_items(name)
```
- invoice_items_history.idx_invoice_history_invoice
```sql
CREATE INDEX idx_invoice_history_invoice ON invoice_items_history(invoice_id)
```
- invoices.idx_invoices_project
```sql
CREATE INDEX idx_invoices_project ON invoices(project_id)
```
- invoices.idx_invoices_supplier
```sql
CREATE INDEX idx_invoices_supplier ON invoices(supplier_id)
```
- matched_items.idx_matched_items_invoice
```sql
CREATE INDEX idx_matched_items_invoice ON matched_items(invoice_item_id)
```
- matched_items.idx_matched_items_spec
```sql
CREATE INDEX idx_matched_items_spec ON matched_items(specification_item_id)
```
- matching_rules.idx_matching_rules_spec
```sql
CREATE INDEX idx_matching_rules_spec ON matching_rules(specification_pattern)
```
- size_synonyms.idx_size_synonyms_synonym
```sql
CREATE INDEX idx_size_synonyms_synonym ON size_synonyms(synonym)
```
- spec_parse_rules.idx_spec_parse_rules_spec
```sql
CREATE INDEX idx_spec_parse_rules_spec ON spec_parse_rules(specification_id)
```
- spec_parse_rules.idx_spec_parse_rules_unique
```sql
CREATE UNIQUE INDEX idx_spec_parse_rules_unique ON spec_parse_rules(specification_id, field, raw_value)
```
- specification_items.idx_spec_items_name
```sql
CREATE INDEX idx_spec_items_name ON specification_items(name)
```
- specification_items.idx_spec_items_project
```sql
CREATE INDEX idx_spec_items_project ON specification_items(project_id)
```
- specification_items.idx_spec_items_spec
```sql
CREATE INDEX idx_spec_items_spec ON specification_items(specification_id)
```
- specification_items_history.idx_spec_items_history_spec
```sql
CREATE INDEX idx_spec_items_history_spec ON specification_items_history(specification_id)
```
- specification_parser_configs.idx_spec_parser_configs_spec
```sql
CREATE INDEX idx_spec_parser_configs_spec ON specification_parser_configs(specification_id)
```
- specifications.idx_specifications_project
```sql
CREATE INDEX idx_specifications_project ON specifications(project_id)
```

<!-- AUTO-GENERATED:END -->
