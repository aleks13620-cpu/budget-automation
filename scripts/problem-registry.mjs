#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const registryPath = path.join(repoRoot, "docs", "problem-registry.yaml");
const reportPath = path.join(repoRoot, "docs", "problem-registry-report.md");
const dbPath = path.join(repoRoot, "database", "budget_automation.db");
const dbStructurePath = path.join(repoRoot, "docs", "database-structure.md");
const AUTO_START = "<!-- AUTO-GENERATED:START -->";
const AUTO_END = "<!-- AUTO-GENERATED:END -->";

const allowedStatuses = ["open", "in_progress", "blocked", "resolved"];
const allowedPriorities = ["critical", "high", "medium", "low"];
const allowedTypes = ["bug", "tech_debt", "docs", "performance", "test_gap"];
const defaultScoring = {
  impact: 3,
  urgency: 3,
  frequency: 3,
  confidence: 3,
  effort: 3,
  risk: 3,
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function todayIso() {
  return new Date().toISOString();
}

function scoreOrDefault(value, fallback = 3) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 1) return 1;
  if (parsed > 5) return 5;
  return Math.round(parsed);
}

function normalizeScoring(scoring) {
  return {
    impact: scoreOrDefault(scoring?.impact, defaultScoring.impact),
    urgency: scoreOrDefault(scoring?.urgency, defaultScoring.urgency),
    frequency: scoreOrDefault(scoring?.frequency, defaultScoring.frequency),
    confidence: scoreOrDefault(scoring?.confidence, defaultScoring.confidence),
    effort: scoreOrDefault(scoring?.effort, defaultScoring.effort),
    risk: scoreOrDefault(scoring?.risk, defaultScoring.risk),
  };
}

function scoringFromLegacyPriority(priority) {
  if (priority === "critical") {
    return { impact: 5, urgency: 5, frequency: 4, confidence: 4, effort: 3, risk: 5 };
  }
  if (priority === "high") {
    return { impact: 4, urgency: 4, frequency: 4, confidence: 4, effort: 3, risk: 4 };
  }
  if (priority === "low") {
    return { impact: 2, urgency: 2, frequency: 2, confidence: 3, effort: 3, risk: 2 };
  }
  return { ...defaultScoring };
}

function computeScores(scoring) {
  const severityRaw =
    scoring.impact * 0.35 +
    scoring.urgency * 0.25 +
    scoring.frequency * 0.2 +
    scoring.risk * 0.2;
  const priorityRaw = severityRaw * (scoring.confidence / 5) + (5 - scoring.effort) * 0.15;

  const severityScore = Number(severityRaw.toFixed(2));
  const priorityScore = Number(priorityRaw.toFixed(2));
  const priorityBucket =
    priorityScore >= 3.5 ? "P0" : priorityScore >= 2.8 ? "P1" : priorityScore >= 2.1 ? "P2" : "P3";

  return { severityScore, priorityScore, priorityBucket };
}

function mapBucketToPriority(bucket) {
  if (bucket === "P0") return "critical";
  if (bucket === "P1") return "high";
  if (bucket === "P2") return "medium";
  return "low";
}

function normalizeStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function isIsoDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
}

function daysSince(isoDateTime) {
  const time = Date.parse(isoDateTime);
  if (Number.isNaN(time)) return 0;
  return Math.floor((Date.now() - time) / (1000 * 60 * 60 * 24));
}

function normalizeTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    } else {
      options._.push(arg);
    }
  }

  return { command, options };
}

function normalizeIssue(issue) {
  const scoringSeed = issue.scoring ?? scoringFromLegacyPriority(issue.priority);
  const scoring = normalizeScoring(scoringSeed);
  const computed = computeScores(scoring);
  const normalized = {
    ...issue,
    description: String(issue.description ?? "").trim(),
    user_impact: String(issue.user_impact ?? issue.description ?? "").trim(),
    owner: String(issue.owner ?? "unassigned").trim() || "unassigned",
    links: Array.isArray(issue.links) ? issue.links : [],
    created_at: issue.created_at ?? todayIso(),
    updated_at: issue.updated_at ?? todayIso(),
    resolved_at: issue.resolved_at ?? null,
    resolution_note: String(issue.resolution_note ?? "").trim(),
    scoring,
    severity_score: computed.severityScore,
    priority_score: computed.priorityScore,
    priority_bucket: issue.priority_bucket ?? computed.priorityBucket,
    suggested_actions: normalizeStringArray(issue.suggested_actions),
    next_action: String(issue.next_action ?? "").trim(),
    blocking_dependencies: normalizeStringArray(issue.blocking_dependencies),
    due_date: issue.due_date ? String(issue.due_date).trim() : "",
  };
  if (!allowedPriorities.includes(normalized.priority)) {
    normalized.priority = mapBucketToPriority(normalized.priority_bucket);
  }
  return normalized;
}

function normalizeRegistry(registry) {
  return {
    meta: {
      version: 2,
      updated_at: registry.meta?.updated_at ?? todayIso(),
    },
    issues: (registry.issues ?? []).map((issue) => normalizeIssue(issue)),
  };
}

function loadRegistry() {
  if (!fs.existsSync(registryPath)) {
    return {
      meta: { version: 2, updated_at: todayIso() },
      issues: [],
    };
  }

  const raw = fs.readFileSync(registryPath, "utf8").trim();
  if (!raw) {
    return {
      meta: { version: 2, updated_at: todayIso() },
      issues: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "docs/problem-registry.yaml имеет неподдерживаемый формат. Ожидается JSON-совместимый YAML."
    );
  }

  if (!parsed.meta || !Array.isArray(parsed.issues)) {
    throw new Error("Некорректная структура реестра: нужны ключи meta и issues[].");
  }

  return normalizeRegistry(parsed);
}

function saveRegistry(registry) {
  registry.meta.version = 2;
  registry.meta.updated_at = todayIso();
  ensureDir(path.dirname(registryPath));
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function nextId(issues) {
  const max = issues.reduce((acc, issue) => {
    const match = /^PRB-(\d+)$/.exec(issue.id ?? "");
    if (!match) return acc;
    return Math.max(acc, Number(match[1]));
  }, 0);
  return `PRB-${String(max + 1).padStart(3, "0")}`;
}

function validateRegistry(registry) {
  const errors = [];
  const idSet = new Set();
  const titleSet = new Set();

  for (let i = 0; i < registry.issues.length; i += 1) {
    const issue = registry.issues[i];
    const prefix = `issues[${i}]`;
    if (!issue.id || !/^PRB-\d{3,}$/.test(issue.id)) {
      errors.push(`${prefix}: invalid id (${issue.id ?? "empty"})`);
    }
    if (idSet.has(issue.id)) {
      errors.push(`${prefix}: duplicate id (${issue.id})`);
    }
    idSet.add(issue.id);

    const normalized = normalizeTitle(issue.title);
    if (!normalized) {
      errors.push(`${prefix}: empty title`);
    } else if (titleSet.has(normalized)) {
      errors.push(`${prefix}: duplicate title (${issue.title})`);
    } else {
      titleSet.add(normalized);
    }

    if (!allowedStatuses.includes(issue.status)) {
      errors.push(`${prefix}: invalid status (${issue.status})`);
    }
    if (!allowedPriorities.includes(issue.priority)) {
      errors.push(`${prefix}: invalid priority (${issue.priority})`);
    }
    if (!allowedTypes.includes(issue.type)) {
      errors.push(`${prefix}: invalid type (${issue.type})`);
    }
    if (!Array.isArray(issue.links)) {
      errors.push(`${prefix}: links must be array`);
    }
    if (!String(issue.user_impact ?? "").trim()) {
      errors.push(`${prefix}: user_impact is required`);
    }
    const scoring = normalizeScoring(issue.scoring);
    for (const key of Object.keys(defaultScoring)) {
      if (!Number.isFinite(scoring[key]) || scoring[key] < 1 || scoring[key] > 5) {
        errors.push(`${prefix}: scoring.${key} must be between 1 and 5`);
      }
    }
    if (!["P0", "P1", "P2", "P3"].includes(issue.priority_bucket)) {
      errors.push(`${prefix}: invalid priority_bucket (${issue.priority_bucket})`);
    }
    if ((issue.priority_bucket === "P0" || issue.priority_bucket === "P1") && issue.owner === "unassigned") {
      errors.push(`${prefix}: owner is required for ${issue.priority_bucket}`);
    }
    if (issue.due_date && !isIsoDateString(issue.due_date)) {
      errors.push(`${prefix}: due_date must be YYYY-MM-DD`);
    }
  }

  return errors;
}

function findIssue(registry, id) {
  const issue = registry.issues.find((item) => item.id === id);
  if (!issue) {
    throw new Error(`Проблема не найдена: ${id}`);
  }
  return issue;
}

function addIssue(options) {
  const title = String(options.title ?? "").trim();
  if (!title) {
    throw new Error("Для add обязателен --title.");
  }

  const registry = loadRegistry();
  const normalized = normalizeTitle(title);
  const duplicate = registry.issues.find((issue) => normalizeTitle(issue.title) === normalized);
  if (duplicate && !options.force) {
    throw new Error(`Похожий заголовок уже есть: ${duplicate.id} (${duplicate.title}). Добавьте --force при необходимости.`);
  }

  const issue = {
    id: nextId(registry.issues),
    title,
    description: String(options.description ?? "").trim(),
    user_impact: String(options["user-impact"] ?? options.description ?? "").trim(),
    type: allowedTypes.includes(options.type) ? options.type : "tech_debt",
    priority: "medium",
    status: "open",
    owner: String(options.owner ?? "unassigned").trim(),
    links: options.link ? [String(options.link)] : [],
    created_at: todayIso(),
    updated_at: todayIso(),
    resolved_at: null,
    resolution_note: "",
    scoring: normalizeScoring({
      impact: options.impact,
      urgency: options.urgency,
      frequency: options.frequency,
      confidence: options.confidence,
      effort: options.effort,
      risk: options.risk,
    }),
    severity_score: 0,
    priority_score: 0,
    priority_bucket: "P2",
    suggested_actions: normalizeStringArray(options["suggested-actions"]),
    next_action: String(options["next-action"] ?? "").trim(),
    blocking_dependencies: normalizeStringArray(options.blockers),
    due_date: isIsoDateString(options["due-date"]) ? String(options["due-date"]) : "",
  };
  const computed = computeScores(issue.scoring);
  issue.severity_score = computed.severityScore;
  issue.priority_score = computed.priorityScore;
  issue.priority_bucket = computed.priorityBucket;
  issue.priority = allowedPriorities.includes(options.priority)
    ? options.priority
    : mapBucketToPriority(issue.priority_bucket);

  registry.issues.push(issue);
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`Validation failed:\n- ${errors.join("\n- ")}`);
  }
  saveRegistry(registry);
  console.log(`Добавлена проблема ${issue.id}: ${issue.title}`);
}

function updateIssue(options) {
  const id = String(options._[0] ?? "").trim();
  if (!id) {
    throw new Error("Для update нужен ID: update PRB-001 --status in_progress");
  }

  const registry = loadRegistry();
  const issue = findIssue(registry, id);

  if (options.title) issue.title = String(options.title).trim();
  if (options.description) issue.description = String(options.description).trim();
  if (options["user-impact"]) issue.user_impact = String(options["user-impact"]).trim();
  if (options.owner) issue.owner = String(options.owner).trim();
  if (options.status) {
    if (!allowedStatuses.includes(options.status)) throw new Error(`Недопустимый status: ${options.status}`);
    issue.status = options.status;
  }
  if (options.priority) {
    if (!allowedPriorities.includes(options.priority)) throw new Error(`Недопустимый priority: ${options.priority}`);
    issue.priority = options.priority;
  }
  if (options.type) {
    if (!allowedTypes.includes(options.type)) throw new Error(`Недопустимый type: ${options.type}`);
    issue.type = options.type;
  }
  if (options.link) {
    issue.links = [...new Set([...(issue.links ?? []), String(options.link)])];
  }
  if (options.impact) issue.scoring.impact = scoreOrDefault(options.impact);
  if (options.urgency) issue.scoring.urgency = scoreOrDefault(options.urgency);
  if (options.frequency) issue.scoring.frequency = scoreOrDefault(options.frequency);
  if (options.confidence) issue.scoring.confidence = scoreOrDefault(options.confidence);
  if (options.effort) issue.scoring.effort = scoreOrDefault(options.effort);
  if (options.risk) issue.scoring.risk = scoreOrDefault(options.risk);
  if (options["suggested-actions"]) issue.suggested_actions = normalizeStringArray(options["suggested-actions"]);
  if (options["next-action"]) issue.next_action = String(options["next-action"]).trim();
  if (options.blockers) issue.blocking_dependencies = normalizeStringArray(options.blockers);
  if (options["due-date"] !== undefined) {
    const value = String(options["due-date"] ?? "").trim();
    if (value && !isIsoDateString(value)) throw new Error("due_date должен быть в формате YYYY-MM-DD");
    issue.due_date = value;
  }

  issue.updated_at = todayIso();
  const computed = computeScores(normalizeScoring(issue.scoring));
  issue.severity_score = computed.severityScore;
  issue.priority_score = computed.priorityScore;
  issue.priority_bucket = computed.priorityBucket;
  if (!options.priority) {
    issue.priority = mapBucketToPriority(issue.priority_bucket);
  }
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`Validation failed:\n- ${errors.join("\n- ")}`);
  }
  saveRegistry(registry);
  console.log(`Обновлена проблема ${issue.id}`);
}

function resolveIssue(options) {
  const id = String(options._[0] ?? "").trim();
  if (!id) throw new Error("Для resolve нужен ID.");

  const registry = loadRegistry();
  const issue = findIssue(registry, id);
  issue.status = "resolved";
  issue.resolved_at = todayIso();
  issue.updated_at = todayIso();
  issue.resolution_note = String(options.note ?? "").trim();
  if (options.link) {
    issue.links = [...new Set([...(issue.links ?? []), String(options.link)])];
  }
  saveRegistry(registry);
  console.log(`Проблема ${id} переведена в resolved.`);
}

function reopenIssue(options) {
  const id = String(options._[0] ?? "").trim();
  if (!id) throw new Error("Для reopen нужен ID.");
  const registry = loadRegistry();
  const issue = findIssue(registry, id);
  issue.status = "open";
  issue.resolved_at = null;
  issue.updated_at = todayIso();
  if (options.note) {
    issue.resolution_note = `${issue.resolution_note}\nReopened: ${String(options.note).trim()}`.trim();
  }
  saveRegistry(registry);
  console.log(`Проблема ${id} снова открыта.`);
}

function listIssues(options) {
  const registry = loadRegistry();
  const statusFilter = options.status ? String(options.status) : null;
  const priorityFilter = options.priority ? String(options.priority) : null;

  const issues = registry.issues.filter((issue) => {
    if (statusFilter && issue.status !== statusFilter) return false;
    if (priorityFilter && issue.priority !== priorityFilter) return false;
    return true;
  });

  if (issues.length === 0) {
    console.log("Проблемы не найдены.");
    return;
  }

  for (const issue of issues) {
    console.log(
      `${issue.id} [${issue.status}] [${issue.priority_bucket}/${issue.priority}] score=${issue.priority_score} ${issue.title}`
    );
  }
}

function statsIssues() {
  const registry = loadRegistry();
  const counts = {
    total: registry.issues.length,
    open: 0,
    in_progress: 0,
    blocked: 0,
    resolved: 0,
    p0: 0,
    p1: 0,
    p2: 0,
    p3: 0,
  };

  for (const issue of registry.issues) {
    if (counts[issue.status] !== undefined) counts[issue.status] += 1;
    if (issue.priority_bucket === "P0") counts.p0 += 1;
    if (issue.priority_bucket === "P1") counts.p1 += 1;
    if (issue.priority_bucket === "P2") counts.p2 += 1;
    if (issue.priority_bucket === "P3") counts.p3 += 1;
  }

  console.log(JSON.stringify(counts, null, 2));
}

function prioritizeIssues(options = {}) {
  const registry = loadRegistry();
  const syncPriority = Boolean(options["sync-priority"]);

  for (const issue of registry.issues) {
    issue.scoring = normalizeScoring(issue.scoring);
    const computed = computeScores(issue.scoring);
    issue.severity_score = computed.severityScore;
    issue.priority_score = computed.priorityScore;
    issue.priority_bucket = computed.priorityBucket;
    if (syncPriority || !allowedPriorities.includes(issue.priority)) {
      issue.priority = mapBucketToPriority(issue.priority_bucket);
    }
    issue.updated_at = todayIso();
  }

  registry.issues.sort((a, b) => {
    if (a.status === "resolved" && b.status !== "resolved") return 1;
    if (b.status === "resolved" && a.status !== "resolved") return -1;
    return b.priority_score - a.priority_score;
  });

  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`Validation failed:\n- ${errors.join("\n- ")}`);
  }
  saveRegistry(registry);
  console.log("Приоритизация завершена.");
}

function generateReport() {
  const registry = loadRegistry();
  const active = registry.issues
    .filter((item) => item.status !== "resolved")
    .sort((a, b) => b.priority_score - a.priority_score);

  const lines = [
    "# Problem Registry Report",
    "",
    `Updated: ${todayIso()}`,
    "",
  ];

  lines.push("## Top priorities to solve now");
  if (active.length === 0) {
    lines.push("- none");
  } else {
    for (const item of active.slice(0, 5)) {
      lines.push(
        `- ${item.id} [${item.priority_bucket}/${item.priority}] score=${item.priority_score} ${item.title} -> user impact: ${item.user_impact}`
      );
      if (item.next_action) {
        lines.push(`  next: ${item.next_action}`);
      }
    }
  }
  lines.push("");

  const aging = active.filter((item) => daysSince(item.created_at) >= 14);
  lines.push("## Aging issues (14+ days open)");
  if (aging.length === 0) {
    lines.push("- none");
  } else {
    for (const item of aging) {
      lines.push(`- ${item.id} open for ${daysSince(item.created_at)} days (${item.title})`);
    }
  }
  lines.push("");

  const overdue = active.filter((item) => item.due_date && Date.parse(`${item.due_date}T23:59:59Z`) < Date.now());
  lines.push("## Overdue issues");
  if (overdue.length === 0) {
    lines.push("- none");
  } else {
    for (const item of overdue) {
      lines.push(`- ${item.id} due ${item.due_date} (${item.title})`);
    }
  }
  lines.push("");

  const byStatus = ["open", "in_progress", "blocked", "resolved"];
  for (const status of byStatus) {
    const list = registry.issues.filter((item) => item.status === status);
    lines.push(`## ${status} (${list.length})`);
    if (list.length === 0) {
      lines.push("- none");
      lines.push("");
      continue;
    }
    for (const item of list) {
      lines.push(
        `- ${item.id} [${item.priority_bucket}/${item.priority}] score=${item.priority_score} ${item.title}`
      );
      lines.push(`  user impact: ${item.user_impact}`);
      if (item.due_date) lines.push(`  due: ${item.due_date}`);
    }
    lines.push("");
  }

  ensureDir(path.dirname(reportPath));
  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Отчет обновлен: ${reportPath}`);
}

function scanCandidates() {
  const registry = loadRegistry();
  const candidates = [];
  const register = (title, description, userImpact, severityHint = "medium") => {
    const normalized = normalizeTitle(title);
    const exists = registry.issues.some((issue) => normalizeTitle(issue.title) === normalized);
    if (exists) return;
    candidates.push({ title, description, user_impact: userImpact, severityHint });
  };

  const gitignorePath = path.join(repoRoot, ".gitignore");
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  if (!gitignore.includes("*.db-wal") || !gitignore.includes("*.db-shm")) {
    register(
      "Missing sqlite transient ignores",
      "В .gitignore отсутствуют sqlite transient паттерны (*.db-wal / *.db-shm).",
      "Временные файлы БД попадают в изменения и могут случайно уйти в коммит.",
      "high"
    );
  }

  const docsPath = path.join(repoRoot, "docs", "problem-registry-report.md");
  if (!fs.existsSync(docsPath)) {
    register(
      "Problem report is missing",
      "Файл отчета отсутствует и не публикует список приоритетов.",
      "Команда не видит общий приоритетный список задач для решения.",
      "medium"
    );
  }

  if (candidates.length === 0) {
    console.log("Новых кандидатов не найдено.");
    return;
  }

  console.log("Candidate issues:");
  for (const candidate of candidates) {
    console.log(
      `- ${candidate.title} [hint:${candidate.severityHint}]\n  description: ${candidate.description}\n  user_impact: ${candidate.user_impact}`
    );
  }
}

function getDatabase() {
  const require = createRequire(import.meta.url);
  let Database;
  try {
    Database = require(path.join(repoRoot, "backend", "node_modules", "better-sqlite3"));
  } catch {
    throw new Error("Не найден better-sqlite3. Установите зависимости в backend: npm install");
  }
  return new Database(dbPath, { readonly: true });
}

function generateDbSnapshot() {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Файл БД не найден: ${dbPath}`);
  }

  const db = getDatabase();
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  const indices = db
    .prepare(
      "SELECT name, tbl_name AS table_name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name"
    )
    .all();

  const block = [];
  block.push("## Auto-generated schema snapshot");
  block.push("");
  block.push(`Source DB: \`${path.relative(repoRoot, dbPath).replace(/\\/g, "/")}\``);
  block.push(`Generated: ${todayIso()}`);
  block.push("");

  for (const table of tables) {
    block.push(`### Table: ${table.name}`);
    block.push("```sql");
    block.push(table.sql || `-- SQL definition not found for ${table.name}`);
    block.push("```");
    block.push("");

    const columns = db.prepare(`PRAGMA table_info('${table.name.replace(/'/g, "''")}')`).all();
    block.push("| Column | Type | Not Null | PK | Default |");
    block.push("|---|---|---:|---:|---|");
    for (const column of columns) {
      block.push(
        `| ${column.name} | ${column.type || ""} | ${column.notnull} | ${column.pk} | ${column.dflt_value ?? ""} |`
      );
    }
    block.push("");
  }

  block.push("## Indices");
  block.push("");
  if (indices.length === 0) {
    block.push("- none");
  } else {
    for (const index of indices) {
      block.push(`- ${index.table_name}.${index.name}`);
      if (index.sql) {
        block.push("```sql");
        block.push(index.sql);
        block.push("```");
      }
    }
  }
  block.push("");

  let content = "";
  if (fs.existsSync(dbStructurePath)) {
    content = fs.readFileSync(dbStructurePath, "utf8");
  } else {
    content = [
      "# Database Structure",
      "",
      "Документ описывает текущую структуру БД.",
      "",
      "## Manual notes",
      "",
      "- Добавляйте бизнес-контекст и пояснения по изменениям схемы.",
      "",
      AUTO_START,
      AUTO_END,
      "",
    ].join("\n");
  }

  if (!content.includes(AUTO_START) || !content.includes(AUTO_END)) {
    throw new Error("В docs/database-structure.md отсутствуют маркеры авто-блока.");
  }

  const [before] = content.split(AUTO_START);
  const after = content.split(AUTO_END)[1];
  const merged = `${before}${AUTO_START}\n\n${block.join("\n")}\n${AUTO_END}${after}`;
  ensureDir(path.dirname(dbStructurePath));
  fs.writeFileSync(dbStructurePath, merged, "utf8");
  db.close();

  console.log(`Снимок структуры БД обновлен: ${dbStructurePath}`);
}

function validateCommand() {
  const registry = loadRegistry();
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    console.log("Validation errors:");
    for (const error of errors) console.log(`- ${error}`);
    process.exit(1);
  }
  console.log("problem-registry.yaml is valid.");
}

function printHelp() {
  console.log(`
Usage:
  node scripts/problem-registry.mjs add --title "..." --user-impact "..." [--description "..."] [--type bug|tech_debt|docs|performance|test_gap] [--priority critical|high|medium|low] [--impact 1..5 --urgency 1..5 --frequency 1..5 --confidence 1..5 --effort 1..5 --risk 1..5] [--owner "..."] [--link "..."] [--suggested-actions "a;b"] [--next-action "..."] [--blockers "a;b"] [--due-date YYYY-MM-DD] [--force]
  node scripts/problem-registry.mjs update PRB-001 [--status open|in_progress|blocked|resolved] [--priority ...] [--type ...] [--title "..."] [--description "..."] [--user-impact "..."] [--impact 1..5 --urgency 1..5 --frequency 1..5 --confidence 1..5 --effort 1..5 --risk 1..5] [--owner "..."] [--link "..."] [--suggested-actions "a;b"] [--next-action "..."] [--blockers "a;b"] [--due-date YYYY-MM-DD]
  node scripts/problem-registry.mjs resolve PRB-001 [--note "..."] [--link "..."]
  node scripts/problem-registry.mjs reopen PRB-001 [--note "..."]
  node scripts/problem-registry.mjs list [--status ...] [--priority ...]
  node scripts/problem-registry.mjs stats
  node scripts/problem-registry.mjs prioritize [--sync-priority]
  node scripts/problem-registry.mjs scan
  node scripts/problem-registry.mjs validate
  node scripts/problem-registry.mjs report
  node scripts/problem-registry.mjs db:snapshot
`);
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "add") return addIssue(options);
  if (command === "update") return updateIssue(options);
  if (command === "resolve") return resolveIssue(options);
  if (command === "reopen") return reopenIssue(options);
  if (command === "list") return listIssues(options);
  if (command === "stats") return statsIssues();
  if (command === "prioritize") return prioritizeIssues(options);
  if (command === "scan") return scanCandidates();
  if (command === "validate") return validateCommand();
  if (command === "report") return generateReport();
  if (command === "db:snapshot") return generateDbSnapshot();

  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`Ошибка: ${error.message}`);
  process.exit(1);
}
