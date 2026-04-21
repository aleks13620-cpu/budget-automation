#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const plansRoot = path.join(repoRoot, "docs", "plans");
const activeDir = path.join(plansRoot, "active");
const archiveDir = path.join(plansRoot, "archive");
const logPath = path.join(repoRoot, "docs", "IMPLEMENTATION_LOG.md");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeFilename(name) {
  return name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/_+/g, "_");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--normalize") {
      options.normalize = true;
    } else if (arg === "--summary") {
      options.summary = rest[i + 1] ?? "";
      i += 1;
    } else if (arg === "--commits") {
      options.commits = rest[i + 1] ?? "";
      i += 1;
    } else if (arg === "--month") {
      options.month = rest[i + 1] ?? "";
      i += 1;
    } else {
      options._.push(arg);
    }
  }

  return { command, options };
}

function resolveInputFile(fileArg) {
  if (path.isAbsolute(fileArg)) {
    return fileArg;
  }
  return path.resolve(repoRoot, fileArg);
}

function currentDateIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthFromIso(dateIso) {
  return dateIso.slice(0, 7);
}

function appendImplementationLog({
  dateIso,
  title,
  relativePlanPath,
  summary,
  commits,
  dryRun,
}) {
  const summaryItems = summary
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 7);

  const safeSummary = summaryItems.length > 0 ? summaryItems : ["Итог не указан."];
  const logBlock = [
    "",
    `## ${dateIso} — ${title}`,
    "- Статус: completed",
    `- План: \`${relativePlanPath.replace(/\\/g, "/")}\``,
    `- Коммиты: ${commits && commits.trim() ? commits.trim() : "n/a"}`,
    "- Итог:",
    ...safeSummary.map((item) => `  - ${item}`),
    "",
  ].join("\n");

  if (dryRun) {
    console.log("[dry-run] Будет добавлена запись в docs/IMPLEMENTATION_LOG.md:");
    console.log(logBlock);
    return;
  }

  fs.appendFileSync(logPath, logBlock, "utf8");
}

function ingest(files, { dryRun, normalize }) {
  if (files.length === 0) {
    throw new Error("Для ingest передайте минимум один путь к файлу.");
  }

  ensureDir(activeDir);

  for (const fileArg of files) {
    const sourcePath = resolveInputFile(fileArg);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Файл не найден: ${sourcePath}`);
    }

    const originalName = path.basename(sourcePath);
    const targetName = normalize ? normalizeFilename(originalName) : originalName;
    const targetPath = path.join(activeDir, targetName);

    if (dryRun) {
      console.log(`[dry-run] ${sourcePath} -> ${targetPath}`);
      continue;
    }

    fs.renameSync(sourcePath, targetPath);
    console.log(`Перенесен: ${targetPath}`);
  }
}

function resolveActivePlan(planArg) {
  const byPath = resolveInputFile(planArg);
  if (fs.existsSync(byPath)) {
    return byPath;
  }

  const candidate = path.join(activeDir, planArg);
  if (fs.existsSync(candidate)) {
    return candidate;
  }

  throw new Error(`План не найден: ${planArg}`);
}

function complete(planArg, { dryRun, month, summary, commits }) {
  if (!planArg) {
    throw new Error("Для complete передайте путь или имя файла плана.");
  }

  const sourcePath = resolveActivePlan(planArg);
  const dateIso = currentDateIso();
  const archiveMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : monthFromIso(dateIso);
  const targetDir = path.join(archiveDir, archiveMonth);
  const baseName = path.basename(sourcePath);
  const targetPath = path.join(targetDir, baseName);
  const title = path.parse(baseName).name;

  ensureDir(targetDir);

  if (dryRun) {
    console.log(`[dry-run] ${sourcePath} -> ${targetPath}`);
  } else {
    fs.renameSync(sourcePath, targetPath);
    console.log(`Архивирован: ${targetPath}`);
  }

  appendImplementationLog({
    dateIso,
    title,
    relativePlanPath: path.relative(repoRoot, targetPath),
    summary: summary ?? "",
    commits: commits ?? "",
    dryRun: Boolean(dryRun),
  });
}

function printHelp() {
  console.log(`
Использование:
  node scripts/plan-workflow.mjs ingest <file1> [file2 ...] [--dry-run] [--normalize]
  node scripts/plan-workflow.mjs complete <active-plan> [--summary "a;b;c"] [--commits "hash1..hash2"] [--month YYYY-MM] [--dry-run]
`);
}

function main() {
  ensureDir(activeDir);
  ensureDir(archiveDir);
  ensureDir(path.dirname(logPath));

  const { command, options } = parseArgs(process.argv.slice(2));

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "ingest") {
    ingest(options._, options);
    return;
  }

  if (command === "complete") {
    complete(options._[0], options);
    return;
  }

  throw new Error(`Неизвестная команда: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`Ошибка: ${error.message}`);
  process.exit(1);
}
