import { finding } from "../../rules/common.js";
import type { AnalyzeOptions, Finding, SqlStatement } from "../../types.js";

function compact(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

function objectFrom(statement: string, pattern: RegExp): string | undefined {
  return pattern.exec(statement)?.[1]?.replace(/["`[\]]/g, "");
}

export function analyzeSqlStatement(file: string, statement: SqlStatement, options: AnalyzeOptions): Finding[] {
  const findings: Finding[] = [];
  const text = compact(statement.text);
  const upper = text.toUpperCase();
  const base = { sourceType: "sql" as const, file, line: statement.line, statement: text };

  if (/^DROP\s+TABLE\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sql.drop_table",
      severity: "critical",
      category: "destructive",
      title: "DROP TABLE detected",
      message: "Dropping a table removes the table and its data, and can break dependent application code.",
      suggestion: "Use a staged deprecation plan, verify backups, and drop only after all references are removed.",
      objectName: objectFrom(text, /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i)
    }));
  }

  if (/^ALTER\s+TABLE\b.*\bDROP\s+COLUMN\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sql.drop_column",
      severity: "critical",
      category: "data_loss",
      title: "DROP COLUMN detected",
      message: "Dropping a column can permanently remove data and break older application versions.",
      suggestion: "Deploy a two-step migration: stop writing and reading the column before removing it.",
      objectName: objectFrom(text, /^ALTER\s+TABLE\s+([^\s;]+)/i)
    }));
  }

  if (/^TRUNCATE\s+TABLE\b/i.test(text) || /^TRUNCATE\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sql.truncate_table",
      severity: "critical",
      category: "data_loss",
      title: "TRUNCATE TABLE detected",
      message: "TRUNCATE removes all rows and can take stronger locks than expected.",
      suggestion: "Confirm this is intentional and prefer batched deletes for production data changes.",
      objectName: objectFrom(text, /^TRUNCATE(?:\s+TABLE)?\s+([^\s;]+)/i)
    }));
  }

  if (/^UPDATE\b/i.test(text) && !/\bWHERE\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sql.update_without_where",
      severity: "critical",
      category: "data_loss",
      title: "UPDATE without WHERE",
      message: "UPDATE without WHERE may affect the entire table.",
      suggestion: "Add a WHERE clause or split the operation into safe batches.",
      objectName: objectFrom(text, /^UPDATE\s+([^\s;]+)/i)
    }));
  }

  if (/^DELETE\s+FROM\b/i.test(text) && !/\bWHERE\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sql.delete_without_where",
      severity: "critical",
      category: "data_loss",
      title: "DELETE without WHERE",
      message: "DELETE without WHERE may remove every row in the table.",
      suggestion: "Add a WHERE clause and consider deleting in batches.",
      objectName: objectFrom(text, /^DELETE\s+FROM\s+([^\s;]+)/i)
    }));
  }

  if (/^ALTER\s+TABLE\b.*\bALTER\s+COLUMN\b.*\bTYPE\b/i.test(text) || /^ALTER\s+TABLE\b.*\bMODIFY\s+COLUMN\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sql.alter_column_type",
      severity: "high",
      category: "compatibility",
      title: "Column type change detected",
      message: "Changing a column type can rewrite large tables or make existing values incompatible.",
      suggestion: "Use an expand-and-backfill migration when changing types on production tables.",
      objectName: objectFrom(text, /^ALTER\s+TABLE\s+([^\s;]+)/i)
    }));
  }

  if (/\bRENAME\s+COLUMN\b/i.test(text) || /\bsp_rename\b.*\bCOLUMN\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sql.rename_column",
      severity: "high",
      category: "compatibility",
      title: "Column rename detected",
      message: "Renaming a column can break application versions that still use the old name.",
      suggestion: "Use a compatibility window with both old and new columns before removing the old name.",
      objectName: objectFrom(text, /^ALTER\s+TABLE\s+([^\s;]+)/i)
    }));
  }

  if (/\bRENAME\s+TO\b/i.test(text) && /^ALTER\s+TABLE\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sql.rename_table",
      severity: "high",
      category: "compatibility",
      title: "Table rename detected",
      message: "Renaming a table can break deployed code, jobs, views, and permissions.",
      suggestion: "Use a compatibility plan or replacement object before renaming production tables.",
      objectName: objectFrom(text, /^ALTER\s+TABLE\s+([^\s;]+)/i)
    }));
  }

  if (options.dialect === "postgres" && /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(text) && !/\bCONCURRENTLY\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "postgres.create_index_without_concurrently",
      severity: "high",
      category: "locking",
      title: "Postgres index created without CONCURRENTLY",
      message: "CREATE INDEX without CONCURRENTLY can block writes on busy Postgres tables.",
      suggestion: "Use CREATE INDEX CONCURRENTLY outside a transaction for production tables."
    }));
  }

  if (options.dialect === "postgres" && /^REINDEX\b/i.test(text) && !/\bCONCURRENTLY\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "postgres.reindex_without_concurrently",
      severity: "high",
      category: "locking",
      title: "Postgres REINDEX without CONCURRENTLY",
      message: "REINDEX without CONCURRENTLY can block reads or writes while the index is rebuilt.",
      suggestion: "Use REINDEX CONCURRENTLY where supported, and run it outside a transaction for production indexes."
    }));
  }

  if (options.dialect === "postgres" && /^ALTER\s+TABLE\b.*\bADD\s+COLUMN\b.*\bNOT\s+NULL\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "postgres.add_not_null_column",
      severity: "high",
      category: "locking",
      title: "Postgres NOT NULL column added directly",
      message: "Adding a NOT NULL column directly can lock or validate the table and fail on existing rows.",
      suggestion: "Plan this as a phased migration and account for lock time or validation cost on production tables.",
      objectName: objectFrom(text, /^ALTER\s+TABLE\s+([^\s;]+)/i)
    }));
  }

  if (options.dialect === "postgres" && /^ALTER\s+TABLE\b.*\bADD\s+COLUMN\b.*\bDEFAULT\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "postgres.add_column_with_default",
      severity: "medium",
      category: "performance",
      title: "Postgres column added with default",
      message: "Adding a column with a default can be expensive depending on Postgres version and default expression.",
      suggestion: "Add the column first, backfill in batches, then add the default separately.",
      objectName: objectFrom(text, /^ALTER\s+TABLE\s+([^\s;]+)/i)
    }));
  }

  if (options.dialect === "postgres" && /^ALTER\s+TABLE\b.*\bADD\s+CONSTRAINT\b.*\bFOREIGN\s+KEY\b/i.test(text) && !/\bNOT\s+VALID\b/i.test(upper)) {
    findings.push(finding({
      ...base,
      ruleId: "postgres.add_foreign_key_without_not_valid",
      severity: "high",
      category: "locking",
      title: "Foreign key added without NOT VALID",
      message: "Adding a foreign key validates existing rows immediately and can lock large tables.",
      suggestion: "Add the constraint NOT VALID, then VALIDATE CONSTRAINT in a controlled step.",
      objectName: objectFrom(text, /^ALTER\s+TABLE\s+([^\s;]+)/i)
    }));
  }

  if (options.dialect === "postgres" && /^ALTER\s+TABLE\b.*\bADD\s+CONSTRAINT\b.*\bCHECK\b/i.test(text) && !/\bNOT\s+VALID\b/i.test(upper)) {
    findings.push(finding({
      ...base,
      ruleId: "postgres.add_check_constraint_without_not_valid",
      severity: "medium",
      category: "locking",
      title: "CHECK constraint added without NOT VALID",
      message: "Adding a CHECK constraint validates existing rows immediately.",
      suggestion: "Add the CHECK constraint NOT VALID, then validate it separately.",
      objectName: objectFrom(text, /^ALTER\s+TABLE\s+([^\s;]+)/i)
    }));
  }

  if (options.dialect === "sqlserver" && /^CREATE\s+(UNIQUE\s+)?(CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\b/i.test(text) && !/\bONLINE\s*=\s*ON\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sqlserver.create_index_without_online",
      severity: "high",
      category: "locking",
      title: "SQL Server index created without ONLINE = ON",
      message: "Creating or rebuilding indexes offline can block production reads or writes for the target table.",
      suggestion: "For supported SQL Server editions and index types, use WITH (ONLINE = ON). If ONLINE is not supported, schedule the change or use a phased rollout."
    }));
  }

  if (options.dialect === "sqlserver" && /^ALTER\s+INDEX\b.*\bREBUILD\b/i.test(text) && !/\bONLINE\s*=\s*ON\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "sqlserver.rebuild_index_without_online",
      severity: "high",
      category: "locking",
      title: "SQL Server index rebuild without ONLINE = ON",
      message: "Offline index rebuilds can hold blocking locks for the duration of the rebuild.",
      suggestion: "For supported SQL Server editions and index types, rebuild with ONLINE = ON or run the operation during a controlled maintenance window."
    }));
  }

  if (options.dialect === "mysql" && /^ALTER\s+TABLE\b/i.test(text) && /\bALGORITHM\s*=\s*COPY\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "mysql.alter_table_algorithm_copy",
      severity: "high",
      category: "locking",
      title: "MySQL ALTER TABLE uses ALGORITHM=COPY",
      message: "ALGORITHM=COPY can rebuild the table and take disruptive metadata locks on busy MySQL tables.",
      suggestion: "Prefer ALGORITHM=INSTANT or ALGORITHM=INPLACE with LOCK=NONE where supported, or use an online schema change tool such as pt-online-schema-change or gh-ost."
    }));
  }

  if (options.dialect === "mysql" && /^ALTER\s+TABLE\b/i.test(text) && !/\bALGORITHM\s*=\s*(INSTANT|INPLACE)\b/i.test(text) && !/\bLOCK\s*=\s*NONE\b/i.test(text)) {
    findings.push(finding({
      ...base,
      ruleId: "mysql.alter_table_without_online_strategy",
      severity: "medium",
      category: "locking",
      title: "MySQL ALTER TABLE without online strategy",
      message: "ALTER TABLE may copy or lock the table depending on MySQL version, storage engine, and operation.",
      suggestion: "Declare ALGORITHM=INSTANT or ALGORITHM=INPLACE with LOCK=NONE when supported, or use pt-online-schema-change or gh-ost for large production tables."
    }));
  }

  return findings;
}
