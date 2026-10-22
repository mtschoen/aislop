# CI / CD

aislop runs the same gate everywhere. `aislop ci` scans, prints JSON, and exits non-zero when the score drops below your threshold, an error-severity diagnostic is present, or attempted C# analysis has an unresolved target failure. The set-and-forget command is `npx --yes aislop@latest ci`: it always runs the latest published CLI, so there is no version to bump.

## Fastest path: `aislop init`

Run `npx aislop init` and answer "yes" to the GitHub Actions workflow prompt. It writes `.aislop/config.yml` and `.github/workflows/aislop.yml` for you. Commit both and your quality gate is live.

`.github/workflows/aislop.yml` is the workflow file (it must live under `.github/workflows/`). `.aislop/config.yml` is the policy file: thresholds, engines, scoring, and telemetry live there.

## GitHub Actions

```yaml
# .github/workflows/aislop.yml
name: aislop

on:
  push:
    branches: [main]
  pull_request:

jobs:
  quality-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx --yes aislop@latest ci
```

Prefer the Marketplace Action? It wraps `setup-node` and runs the same gate. From v0.18.1, the CLI version it runs follows the ref in `uses:` unless `version` is set. Tags before v0.18.1 run the latest CLI unless `version` is set.

| `uses:` ref | CLI version |
|---|---|
| `@v1`, `@main`, other branches | latest release |
| a release tag, e.g. `@v0.18.1` | `0.18.1` |
| a commit SHA | the `package.json` version at that commit |

Pinning a release tag or SHA gives reproducible builds, and Dependabot's `github-actions` updates bump the Action and the CLI together, so there is no separate version to remember:

```yaml
- uses: actions/checkout@v4
- uses: scanaislop/aislop@v0.18.1   # or @v1 to always run the latest release
```

Set `version` only to run a different CLI than the ref implies. An explicit `version` always wins, so Dependabot bumps to `uses:` no longer change the CLI.

## GitLab CI

```yaml
# .gitlab-ci.yml
aislop:
  image: node:24
  script:
    - npx --yes aislop@latest ci
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == "main"
```

## CircleCI

```yaml
# .circleci/config.yml
version: 2.1
jobs:
  aislop:
    docker:
      - image: cimg/node:24.0
    steps:
      - checkout
      - run: npx --yes aislop@latest ci
workflows:
  quality-gate:
    jobs:
      - aislop
```

## Bitbucket Pipelines

Bitbucket clones shallow by default and exposes the PR target branch as `$BITBUCKET_PR_DESTINATION_BRANCH`. Fetch the base, then gate on only the changed files (see [PR-scoped gating](#pr-scoped-gating)):

```yaml
# bitbucket-pipelines.yml
pipelines:
  pull-requests:
    "**":
      - step:
          name: aislop gate
          image: node:24
          clone:
            depth: full   # branch diffs need history
          script:
            - git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
            - npx --yes aislop@latest ci --changes --base FETCH_HEAD
```

Bitbucket's clone has only the source branch, so `git fetch origin <branch>` sets `FETCH_HEAD` without creating `origin/<branch>` - diff against `FETCH_HEAD` directly.

## Pre-commit hook

Scan only staged files to keep commits clean:

```bash
npx aislop scan --staged
```

## PR-scoped gating

A plain `--changes` diffs the working tree against `HEAD`, so in CI (where PR changes are already committed) it sees nothing. Pass `--base <ref>` to diff against the target branch instead. Both `scan` and `ci` accept `--changes` and `--base`, so you can gate a PR on only the files it touches:

```bash
npx aislop ci --changes --base origin/main
```

The base ref must exist in the checkout. With a full clone, `origin/<branch>` works directly; on a shallow or single-branch clone, run `git fetch origin <branch>` and pass `--base FETCH_HEAD` (the fetch sets `FETCH_HEAD` without creating `origin/<branch>`). If an explicit `--base` cannot be resolved, the run fails instead of silently passing an empty scan. The score gate and exit code behave exactly as a full `ci` run.

## Quality gate

Set a minimum score in `.aislop/config.yml`:

```yaml
ci:
  failBelow: 70
  format: json
```

The CI command exits 1 when the score drops below `failBelow`, when any error-severity diagnostic is present, or when a selected C# analyzer target fails without complete successful fallback. Analyzer failure fails the gate even with score 100, `failBelow: 0`, or an accepted baseline.

Incomplete analysis includes `engines.lint.failures` in JSON: an array of `{ "tool": "roslynator", "target": "src/App/App.csproj", "reason": "no report written ..." }` entries. Targets are root-relative forward-slash paths. These are execution failures, not source findings: they do not increment `issues` or change the numeric score, and source suppressions cannot erase them. The field is omitted when no target failures remain. Human status reports incomplete analysis instead of zero findings; all formats name the not-run tool and target on stderr. SARIF records unsuccessful invocations with tool-execution notifications. Machine stdout stays valid JSON or SARIF.

Format and lint checks for Python, Go, Rust, Ruby, PHP, C/C++, and C# (with `projectEvaluation`) need their tools (`ruff`, `golangci-lint`, `gofmt`, `clippy`, `cppcheck`, and so on) on `PATH`. When one is missing, those checks do not run and the score does not include them. Tools that only run under certain conditions, such as `clang-format` with a `.clang-format` file or `clang-tidy` with a `compile_commands.json`, are reported only when those conditions hold. The scan output names the missing tools, and `aislop doctor` shows how to install them (`aislop-tools` installs the bundled `ruff` and `golangci-lint`). To fail CI instead of scoring a partial scan, set:

```yaml
ci:
  failOnMissingTools: true
```

## Baseline: fail only on new findings

Adopting aislop on an existing codebase does not have to block CI until every finding is fixed. A baseline records the findings you accept today, and `aislop ci` then fails only on findings that are not in it.

```bash
aislop baseline write   # record every current finding in .aislop/ci-baseline.json
```

Commit the file and point the config at it:

```yaml
ci:
  baseline: .aislop/ci-baseline.json
```

With a baseline configured, `scan` and `ci` match each finding against it:

- A finding is matched on its rule, its file, and the text of the reported line (whitespace-insensitive), not its line number, so edits elsewhere in the file do not re-raise it. File-level findings such as `complexity/file-too-large` or `security/vulnerable-dependency` match on rule, file, and message, so a different vulnerable package is a new finding. Repeated identical findings are counted, so a second copy of an accepted finding is new. `baseline write` refuses to record a scan where an engine failed or a required tool is missing.
- CI exits 1 when any finding is not in the baseline, whatever its severity, or when the score drops below `failBelow`. Accepted findings alone do not fail CI.
- The score still counts every finding, accepted or not.
- Entries that no longer occur are reported as stale. Run `aislop baseline prune` to remove them; prune never adds entries, so the baseline only shrinks as findings are fixed. Entries for an engine that was skipped or missing a tool are never treated as stale, a line-level entry only becomes stale once its line is gone from the file (or the file is deleted), and a file-level entry from an external tool (formatter, linter, dependency audit, or knip) only becomes stale once its file is deleted. A tool that fails quietly therefore cannot make `prune` drop entries.
- With `--changes` or `--staged`, stale entries are only reported for files in the scanned scope.

This file is separate from `.aislop/baseline.json`, the score snapshot that `aislop hook baseline` writes for agent hooks; `aislop baseline write` refuses to write to that path.

If the configured file is missing or invalid, the run prints a warning and treats every finding as new. In JSON output, matched diagnostics carry `"baselined": true` and a `baseline` object reports `path`, `status`, `accepted`, `new`, and `stale`.

## JSON output

Both `aislop ci` and `aislop scan --json` emit structured JSON for parsing in CI. Example shape (values illustrative):

```json
{
  "schemaVersion": "2",
  "cliVersion": "<version>",
  "score": 87,
  "label": "Healthy",
  "engines": {
    "format":       { "issues": 0, "skipped": false, "elapsed": 406 },
    "lint":         { "issues": 0, "skipped": false, "elapsed": 378 },
    "code-quality": { "issues": 1, "skipped": false, "elapsed": 812 },
    "ai-slop":      { "issues": 2, "skipped": false, "elapsed": 455 },
    "security":     { "issues": 0, "skipped": false, "elapsed": 1103 }
  },
  "diagnostics": [ ... ]
}
```

An engine that crashed during the scan also carries `"failed": true`. A `skipped` engine without `failed` was skipped on purpose, and its `skipReason` says why. When a tool needed for a detected language is not installed, the engine lists it in `missingTools`, even if the engine still ran for other languages:

```json
"engines": {
  "format": { "issues": 0, "skipped": true, "elapsed": 0, "skipReason": "missing tools: ruff", "missingTools": ["ruff"] },
  "lint":   { "issues": 3, "skipped": false, "elapsed": 412, "missingTools": ["ruff"] }
}
```

An engine skipped only because the scan has no files it applies to has no `missingTools`.

### C# pass execution record

`schemaVersion` 2 adds `engines.lint.executions` whenever the scan detects C#. It holds one record for the JetBrains pass (`jb inspectcode`) and one for the Roslynator pass, produced for successful runs as well as failed and unselected ones, so a clean zero is distinguishable from a pass that never ran:

```json
"lint": {
  "issues": 0, "skipped": false, "elapsed": 9120,
  "executions": [
    {
      "tool": "jb inspectcode",
      "status": "ran",
      "targets": ["App.sln"],
      "analyzedProjects": ["One/One.csproj", "Two/Two.csproj"],
      "excludedProjects": ["Vendor/Vendor.csproj"],
      "elapsed": 8841
    },
    {
      "tool": "roslynator",
      "status": "not-selected",
      "reason": "projectEvaluation disabled",
      "targets": [],
      "analyzedProjects": [],
      "excludedProjects": ["Vendor/Vendor.csproj"],
      "elapsed": 0
    }
  ]
}
```

- `status` is `ran`, `failed` (the pass started and at least one target did not complete; `reason` joins the failure reasons and the same failures appear in `failures`), or `not-selected` (`reason` is `projectEvaluation disabled`, `<tool> disabled in lint.csharp config`, `<tool> tool missing`, or `no solution or restored project targets`).
- `targets` are the repository-relative solution or project files handed to the tool. jb inspects the solution even when a user exclude names one of its projects (the excluded project's findings are filtered out afterwards); Roslynator falls back to per-project targets when the solution declares an excluded project. Both fall back to per-project targets when the solution declares a gitignored project; a gitignored or excluded .csproj the solution does not declare leaves the solution as the target.
- `analyzedProjects` are repository-relative `.csproj` paths. For jb they come from the `<Project>` elements of the report resolved to project files through the target solution's project mapping or invocation target; for Roslynator they are the successfully analyzed project targets, or the solution's member projects when a solution target succeeded. A project removed by a user exclude is listed only in `excludedProjects`, never in `analyzedProjects`.
- `elapsed` is milliseconds.

A consumer can fail closed by checking `status === "ran"` for each tool and that its expected project set is a subset of `analyzedProjects`. The same records appear in SARIF as `runs[0].invocations[0].properties.analyzerExecutions`.
