#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  analyzeFiles,
  generateMarkdownReport,
  type AnalyzedFile,
  type MarkdownReportOptions,
  type SqlDialect
} from "@dbaops/db-change-review-core";

const marker = "<!-- db-change-review-by-dbaops -->";

interface CliOptions {
  base: string;
  repo?: string;
  pr?: string;
  token?: string;
  dialect: SqlDialect;
  commentOnClean: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  db-change-review scan [--base origin/main] [--dialect postgres|sqlserver|mysql|unknown]",
    "  db-change-review comment --repo owner/name --pr 123 [--base origin/main] [--dialect postgres|sqlserver|mysql|unknown]",
    "",
    "Environment fallbacks:",
    "  GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_EVENT_PATH"
  ].join("\n");
}

function parseArgs(argv: string[]): { command: string; options: CliOptions } {
  const [command = "scan", ...args] = argv;
  const options: CliOptions = {
    base: "origin/main",
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
    dialect: parseDialect(process.env.DB_CHANGE_REVIEW_DIALECT),
    commentOnClean: process.env.DB_CHANGE_REVIEW_COMMENT_ON_CLEAN === "true"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];

    if (arg === "--base" && value) {
      options.base = value;
      index += 1;
      continue;
    }
    if (arg === "--repo" && value) {
      options.repo = value;
      index += 1;
      continue;
    }
    if (arg === "--pr" && value) {
      options.pr = value;
      index += 1;
      continue;
    }
    if (arg === "--token" && value) {
      options.token = value;
      index += 1;
      continue;
    }
    if (arg === "--dialect" && value) {
      options.dialect = parseDialect(value);
      index += 1;
      continue;
    }
    if (arg === "--comment-on-clean") {
      options.commentOnClean = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  options.pr ??= pullRequestNumberFromEvent();
  return { command, options };
}

function parseDialect(value: string | undefined): SqlDialect {
  if (value === "postgres" || value === "sqlserver" || value === "mysql" || value === "unknown") {
    return value;
  }
  return "postgres";
}

function pullRequestNumberFromEvent(): string | undefined {
  if (!process.env.GITHUB_EVENT_PATH) return undefined;

  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) as {
      pull_request?: { number?: number };
      number?: number;
    };
    const number = event.pull_request?.number ?? event.number;
    return number ? String(number) : undefined;
  } catch {
    return undefined;
  }
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isDatabaseCandidate(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.endsWith(".sql") ||
    normalized.includes("migration") ||
    normalized.includes("migrations") ||
    normalized.includes("db/migrate") ||
    normalized.includes("prisma/migrations") ||
    normalized.includes("alembic/versions") ||
    normalized.endsWith("/prisma/schema.prisma") ||
    normalized === "prisma/schema.prisma" ||
    (normalized.endsWith(".cs") && normalized.includes("/migrations/"))
  );
}

function addedLinesFromPatch(base: string, path: string): string {
  const patch = git(["diff", `${base}...HEAD`, "--", path]);
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function changedDatabaseFiles(base: string): AnalyzedFile[] {
  const paths = git(["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean)
    .filter(isDatabaseCandidate);

  return paths.map((path) => ({
    path,
    content: addedLinesFromPatch(base, path) || readFileSync(path, "utf8")
  }));
}

function cleanReport(): string {
  return [
    "## DB Change Review",
    "",
    "**None risk** · 0/100 · **0 database risks found**",
    "",
    "No database-related file changes were found.",
    "",
    "<sub>DB Change Review by dbaops</sub>"
  ].join("\n");
}

function buildReport(options: CliOptions, reportOptions: MarkdownReportOptions = {}): string {
  const files = changedDatabaseFiles(options.base);
  if (files.length === 0) return cleanReport();

  return generateMarkdownReport(
    analyzeFiles(files, {
      dialect: options.dialect,
      failOn: "high"
    }),
    reportOptions
  );
}

async function githubJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "db-change-review-by-dbaops",
      ...init.headers
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function upsertComment(repo: string, commentsUrl: string, body: string, token: string): Promise<void> {
  const comments = await githubJson<Array<{ id: number; body?: string; user?: { login?: string } }>>(commentsUrl, token);
  const existing =
    comments.find((item) => item.body?.includes(marker) && item.user?.login === "github-actions[bot]") ??
    comments.find((item) => item.body?.includes(marker) && !item.user?.login);

  if (existing) {
    await githubJson(`https://api.github.com/repos/${repo}/issues/comments/${existing.id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ body })
    });
    console.log(`db-change-review: updated PR comment ${existing.id}`);
    return;
  }

  const created = await githubJson<{ id: number }>(commentsUrl, token, {
    method: "POST",
    body: JSON.stringify({ body })
  });
  console.log(`db-change-review: created PR comment ${created.id}`);
}

async function comment(options: CliOptions): Promise<void> {
  if (!options.repo) throw new Error("--repo or GITHUB_REPOSITORY is required");
  if (!options.pr) throw new Error("--pr or GITHUB_EVENT_PATH is required");
  if (!options.token) throw new Error("--token or GITHUB_TOKEN is required");

  const pull = await githubJson<{ head: { sha: string } }>(
    `https://api.github.com/repos/${options.repo}/pulls/${options.pr}`,
    options.token
  );
  const report = buildReport(options, {
    sourceUrlBase: `https://github.com/${options.repo}/blob/${pull.head.sha}`
  });
  if (!options.commentOnClean && report.includes("No database-related file changes were found.")) {
    console.log("db-change-review: no database changes found; comment skipped");
    return;
  }

  const body = `${marker}\n\n${report}`;
  const commentsUrl = `https://api.github.com/repos/${options.repo}/issues/${options.pr}/comments`;
  await upsertComment(options.repo, commentsUrl, body, options.token);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "scan") {
    console.log(buildReport(options));
    return;
  }
  if (command === "comment") {
    await comment(options);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
