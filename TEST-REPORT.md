# aislop - Test Report

`2026-11-08`

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Mode** | best-effort |
| **Tests** | 4216 total (4139 passed, 0 failed, 77 skipped), Windows Node 22.19.0 |
| **Git** | 07b554f (pr-crew/direct-issue-25984-df2d4bf6 working tree) |
| **Coverage** | 16892/19801 lines (85.30%), 2909 uncovered; 0 exclusion annotations |
| **Lint** | aislop: 94 findings (0 errors, 11 warnings, 83 info), inherited baseline; ShellCheck: 0 findings; TypeScript: 0 errors |

## Coverage

| Measure | Covered | Total | Percent |
|---------|---------|-------|---------|
| Statements | 19073 | 23015 | 82.87% |
| Branches | 11375 | 15303 | 74.33% |
| Functions | 2996 | 3535 | 84.75% |
| Lines | 16892 | 19801 | 85.30% |

## Lint

| Tool | Findings | Errors | Warnings | Info |
|------|----------|--------|----------|------|
| aislop full scan | 94 | 0 | 11 | 83 |
| Biome (changed test file) | 0 | 0 | 0 | 0 |
| TypeScript | 0 | 0 | 0 | 0 |

The full-scan baseline contains one per-case suppression and no documented
exceptions. The configured V8 coverage include set is `src/**/*.{ts,tsx}`.

## Commands

```bash
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm scan
node dist/cli.js ci .
pnpm vitest run tests/gitea-coverage-status.test.ts tests/gitea-windows-node.test.ts tests/gitea-dotnet-integration.test.ts
pnpm exec biome check tests/gitea-coverage-status.test.ts
pnpm gen:schema
git diff --exit-code schema/aislop.config.schema.json
git diff --check
```
