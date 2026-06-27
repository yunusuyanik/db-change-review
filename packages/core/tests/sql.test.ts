import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeFiles, calculateRiskScore } from "../src";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("SQL analyzer", () => {
  it("detects risky SQL changes", () => {
    const result = analyzeFiles(
      [{ path: "migrations/001_risky.sql", content: fixture("risky.sql") }],
      { dialect: "postgres", failOn: "high" }
    );

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "sql.drop_table",
        "sql.update_without_where",
        "postgres.create_index_without_concurrently",
        "postgres.add_not_null_column"
      ])
    );
    expect(result.shouldFail).toBe(true);
    expect(result.riskScore).toBe(100);
  });

  it("does not flag safe SQL as critical", () => {
    const result = analyzeFiles(
      [{ path: "migrations/002_safe.sql", content: fixture("safe.sql") }],
      { dialect: "postgres" }
    );

    expect(result.findings.filter((finding) => finding.severity === "critical")).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
  });

  it("calculates risk score with cap", () => {
    const result = analyzeFiles(
      [{ path: "migrations/001_risky.sql", content: fixture("risky.sql") }],
      { dialect: "postgres" }
    );

    expect(calculateRiskScore(result.findings)).toBe(100);
    expect(result.riskLevel).toBe("critical");
  });

  it("detects PostgreSQL online index recommendations", () => {
    const result = analyzeFiles(
      [{ path: "migrations/003_postgres.sql", content: "REINDEX INDEX users_email_idx;" }],
      { dialect: "postgres" }
    );

    expect(result.findings.map((finding) => finding.ruleId)).toContain("postgres.reindex_without_concurrently");
  });

  it("detects SQL Server offline index operations", () => {
    const result = analyzeFiles(
      [
        {
          path: "migrations/004_sqlserver.sql",
          content: [
            "CREATE INDEX IX_users_email ON dbo.Users(email);",
            "ALTER INDEX IX_users_email ON dbo.Users REBUILD;"
          ].join("\n")
        }
      ],
      { dialect: "sqlserver" }
    );

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "sqlserver.create_index_without_online",
        "sqlserver.rebuild_index_without_online"
      ])
    );
  });

  it("detects MySQL ALTER TABLE without online strategy", () => {
    const result = analyzeFiles(
      [
        {
          path: "migrations/005_mysql.sql",
          content: [
            "ALTER TABLE users ADD COLUMN age INT;",
            "ALTER TABLE orders ADD COLUMN archived_at DATETIME, ALGORITHM=COPY;"
          ].join("\n")
        }
      ],
      { dialect: "mysql" }
    );

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "mysql.alter_table_without_online_strategy",
        "mysql.alter_table_algorithm_copy"
      ])
    );
  });
});
