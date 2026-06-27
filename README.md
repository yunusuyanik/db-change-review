# DB Change Review by dbaops

DB Change Review checks pull requests for risky database changes before they are merged.

It looks at changed database-related files, runs deterministic rules, and leaves a pull request comment with the risks it found. It does not use an LLM to decide whether a change is risky.

DB Change Review currently understands common patterns in:

- SQL migrations
- EF Core migrations
- Prisma schema files

## What It Catches

DB Change Review is designed to catch changes that often need extra rollout care, such as:

- dropping tables or columns
- `UPDATE` or `DELETE` without a `WHERE`
- PostgreSQL indexes created without `CONCURRENTLY`
- PostgreSQL `REINDEX` without `CONCURRENTLY`
- SQL Server indexes created or rebuilt without `ONLINE = ON`
- MySQL `ALTER TABLE` without an online schema change strategy
- columns added as `NOT NULL`
- columns added with defaults
- foreign keys or checks added without delayed validation patterns
- EF Core migration operations that map to risky database changes

The report includes a risk score, a severity summary, the rule that matched, and links back to the changed lines in the pull request.

## Rule Coverage

DB Change Review uses deterministic rules. It is intentionally conservative: a finding means the change deserves review, not that it is always wrong.

| Area | Rules |
| --- | --- |
| Generic SQL | `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `UPDATE` without `WHERE`, `DELETE` without `WHERE`, column type changes, column/table renames |
| PostgreSQL | `CREATE INDEX` without `CONCURRENTLY`, `REINDEX` without `CONCURRENTLY`, `NOT NULL` columns added directly, columns added with defaults, foreign keys or checks added without `NOT VALID` |
| SQL Server | `CREATE INDEX` or `ALTER INDEX ... REBUILD` without `WITH (ONLINE = ON)` |
| MySQL | `ALTER TABLE` using `ALGORITHM=COPY`, or `ALTER TABLE` without `ALGORITHM=INSTANT` / `ALGORITHM=INPLACE` and `LOCK=NONE` |
| EF Core | Migration operations that map to destructive, locking, or compatibility-sensitive database changes |
| Prisma | Prisma schema files are detected for database-review context |

For production databases, prefer online or staged rollout patterns where the engine supports them:

- PostgreSQL: use `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, and delayed validation with `NOT VALID`.
- SQL Server: use `WITH (ONLINE = ON)` for supported editions and index types. If online operations are not supported, schedule the change or use a phased rollout.
- MySQL: prefer `ALGORITHM=INSTANT` or `ALGORITHM=INPLACE` with `LOCK=NONE` where supported. For large tables, use `pt-online-schema-change` or `gh-ost`.

## GitHub Actions Usage

Add this workflow to the repository you want DB Change Review to review:

```yaml
name: db-change-review

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  db-change-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}

      - uses: yunusuyanik/db-change-review@v1.0.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          base: origin/${{ github.base_ref }}
          dialect: postgres
```

DB Change Review updates the same pull request comment on every run instead of posting duplicates.

The workflow permissions matter. DB Change Review reads the diff and writes a pull request comment, so it needs:

- `contents: read`
- `pull-requests: write`
- `issues: write`

## Options

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | Yes | | Token used to create or update the PR comment. Use `${{ secrets.GITHUB_TOKEN }}`. |
| `base` | No | `origin/main` | Git ref to compare against. |
| `dialect` | No | `postgres` | SQL dialect for dialect-specific rules. Supported values: `postgres`, `sqlserver`, `mysql`, `unknown`. |
| `comment-on-clean` | No | `false` | Post a clean report even when no database-related files changed. |

## Local Usage

Install dependencies:

```bash
pnpm install
```

Build the packages:

```bash
pnpm build
```

Print a Markdown report for the current branch:

```bash
node packages/cli/dist/index.js scan --base origin/main --dialect postgres
```

Create or update a pull request comment:

```bash
GITHUB_TOKEN=$(gh auth token) \
node packages/cli/dist/index.js comment \
  --repo owner/repo \
  --pr 123 \
  --base origin/main \
  --dialect postgres
```

## Development

Run tests:

```bash
pnpm test
```

Run type checks:

```bash
pnpm typecheck
```

Build:

```bash
pnpm build
```

## Notes

- DB Change Review uses deterministic rules, not a full SQL parser.
- Findings are meant to flag changes that deserve review, not to prove a migration is unsafe.
- The default workflow is GitHub Actions plus a pull request comment.
