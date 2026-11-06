# aislop - Test Report

`2026-11-06T01:13:27Z`

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Mode** | best-effort |
| **Tests** | 4215 total (4192 passed, 0 failed, 23 skipped) |
| **Git** | 36cce90 (maintenance working tree) |
| **Coverage** | 16970/19801 lines (85.70%), 2831 uncovered; 0 exclusion annotations |
| **Lint** | aislop: 94 findings (0 errors, 11 warnings, 83 info), inherited baseline; ShellCheck: 0 findings; TypeScript: 0 errors |

## Coverage

| Measure | Covered | Total | Percent |
|---------|---------|-------|---------|
| Statements | 19161 | 23015 | 83.25% |
| Branches | 11443 | 15303 | 74.77% |
| Functions | 3012 | 3535 | 85.20% |
| Lines | 16970 | 19801 | 85.70% |

## Lint

| Tool | Findings | Errors | Warnings | Info |
|------|----------|--------|----------|------|
| aislop full scan | 94 | 0 | 11 | 83 |
| aislop changed-file scan | 2 pre-existing context findings in unchanged code | 0 | 1 | 1 |
| ShellCheck | 0 | 0 | 0 | 0 |
| TypeScript | 0 | 0 | 0 | 0 |

The full-scan baseline contains one per-case suppression and no documented
exceptions. New scripts and tests have zero findings. The configured V8
coverage include set is `src/**/*.{ts,tsx}`.

## Commands

```bash
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm scan
node dist/cli.js scan . --changes
bash -n init.sh
shellcheck init.sh
```
