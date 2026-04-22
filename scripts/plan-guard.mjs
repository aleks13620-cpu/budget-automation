#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const plansActiveDir = path.join(repoRoot, "docs", "plans", "active");
const implementationLogPath = path.join(repoRoot, "docs", "IMPLEMENTATION_LOG.md");
const reviewsDir = path.join(repoRoot, "docs", "plans", "reviews");

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

function listMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(dirPath, entry.name));
}

function daysSinceModified(filePath) {
  const stat = fs.statSync(filePath);
  return Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
}

function hasNonEmptyLog() {
  if (!fs.existsSync(implementationLogPath)) return false;
  const body = fs.readFileSync(implementationLogPath, "utf8").trim();
  return body.length > 0 && body.includes("## ");
}

function latestReviewDays() {
  const reviewFiles = listMarkdownFiles(reviewsDir);
  if (reviewFiles.length === 0) return Number.POSITIVE_INFINITY;
  const newestMtime = Math.max(...reviewFiles.map((filePath) => fs.statSync(filePath).mtimeMs));
  return Math.floor((Date.now() - newestMtime) / (1000 * 60 * 60 * 24));
}

function check(options) {
  const maxActivePlans = Number(options["max-active"] ?? 1);
  const staleDaysLimit = Number(options["stale-days"] ?? 10);
  const reviewDaysLimit = Number(options["review-days"] ?? 14);
  const strictMode = Boolean(options.strict);

  const activePlans = listMarkdownFiles(plansActiveDir);
  const stalePlans = activePlans.filter((filePath) => daysSinceModified(filePath) > staleDaysLimit);
  const issues = [];
  const warnings = [];

  if (activePlans.length > maxActivePlans) {
    issues.push(
      `Активных планов ${activePlans.length}, лимит ${maxActivePlans}. Нарушено правило WIP.`
    );
  }

  if (stalePlans.length > 0) {
    issues.push(
      `Обнаружены "зависшие" активные планы без обновлений > ${staleDaysLimit} дн.: ${stalePlans
        .map((filePath) => path.basename(filePath))
        .join(", ")}.`
    );
  }

  if (!hasNonEmptyLog()) {
    issues.push("Журнал docs/IMPLEMENTATION_LOG.md отсутствует или пустой.");
  }

  const reviewAgeDays = latestReviewDays();
  if (Number.isFinite(reviewAgeDays) && reviewAgeDays > reviewDaysLimit) {
    warnings.push(
      `Последнее review старше ${reviewDaysLimit} дн. (фактически ${reviewAgeDays} дн.). Рекомендуется обновить docs/plans/reviews/.`
    );
  }
  if (!Number.isFinite(reviewAgeDays)) {
    warnings.push("Файлы review не найдены в docs/plans/reviews/.");
  }

  console.log("Plan guard report:");
  console.log(`- Active plans: ${activePlans.length}`);
  console.log(`- Stale plans: ${stalePlans.length}`);
  console.log(`- Implementation log present: ${hasNonEmptyLog() ? "yes" : "no"}`);
  console.log(
    `- Latest review age (days): ${Number.isFinite(reviewAgeDays) ? String(reviewAgeDays) : "n/a"}`
  );

  if (issues.length > 0) {
    console.log("\nBlocking issues:");
    for (const issue of issues) {
      console.log(`- ${issue}`);
    }
  }

  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (strictMode && issues.length > 0) {
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Usage:
  node scripts/plan-guard.mjs check [--strict] [--max-active 1] [--stale-days 10] [--review-days 14]
`);
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (!command || command === "-h" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  if (command === "check") {
    check(options);
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
