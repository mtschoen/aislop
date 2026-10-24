# AI Agent Instructions for aislop

aislop is a unified code-quality CLI: formatting, linting, code-quality,
AI-pattern, architecture, and security checks; density-aware score out of 100.

- npm package and CLI binary: `aislop`; configuration directory: `.aislop/`
- Upstream repository: https://github.com/scanaislop/aislop
- **Must read [Agent development details](docs/agent-development.md) in full**
  before designing/changing/reviewing detectors or changing architecture or
  navigating the engine layout.
- **Must read [Local and fleet deployment](docs/local-fleet-deployment.md) in
  full** before linking builds, refreshing/diagnosing fleet installs, changing
  wrappers, or publishing the fork. Linked instructions are mandatory for that
  work; the core rules below still apply.

## Build & test commands

```bash
pnpm install           # Install dependencies
pnpm build             # Build with tsdown (cleans dist itself)
pnpm typecheck         # tsc --noEmit
pnpm test              # Build + vitest run
pnpm vitest run        # Tests without rebuilding (faster iteration)
pnpm test:coverage     # V8 line coverage and Cobertura output
pnpm scan              # Build + run aislop on itself
node dist/cli.js scan . # Run after building manually
```

All changes should pass:
`pnpm typecheck && pnpm test && pnpm test:coverage && pnpm scan`.

## Architecture and naming

- TypeScript strict mode, ES2022 target, bundler module resolution.
- Zod v4: import from `"zod/v4"`, not `"zod"`.
- tsdown (rolldown-based) bundles the CLI and public API, plus MCP and framework
  adapter entries; see `tsdown.config.ts`. It injects the `package.json` version
  through `env.VERSION` (with an environment override); use `process.env.VERSION`.
- vitest has a 30-second timeout; pnpm uses `pnpm-workspace.yaml` and
  `pnpm-lock.yaml`.
- Node `^22.18 || >=24.11` is required to run, build, and test; CI uses 22 and 24.
- `aislop` is the package/binary/config branding. **Do not rename** `ai-slop`,
  the internal engine name and rule prefix (e.g. `ai-slop/trivial-comment`), or
  `"AI Slop"`, the diagnostic category label.

## Workflow and permissions

- **Keep fork-only changes in their own files/modules where possible.** Prefer
  new files, additive registrations, and extracted constants over weaving changes
  through upstream files when both work; separate modules reduce sync conflicts.
- **Upstream branch model:** branch from current `origin/develop`; open PRs to
  `develop` unless the task explicitly says otherwise. `origin` is upstream
  (`scanaislop/aislop`); `fork` is the personal fork (`mtschoen/aislop`), whose
  integration branch is `schoen/main`.
- Writing worktrees live at sibling `~/aislop-worktrees/<task>`, one per branch,
  not inside the checkout.
- `develop` -> `main` promotion is a maintainer decision, even with green checks.
  **Do not merge PRs, publish releases, or promote branches unless
  explicitly asked in the current task.**
- Publishing a GitHub Release runs `.github/workflows/release.yml`; failed npm
  publishes can use its guarded manual recovery after promotion to `main`.
- Default to draft PRs on github.com unless explicitly asked for ready PRs.
  Self-hosted Gitea PRs open ready: the instance is user-controlled and its
  review cycle gates merges.
- Verify package installs in a clean temporary environment before reporting a
  published package as working.
- Issues here are auto-claimed by pr-crew, which lands its own PR within the
  hour. Implementing a fix in the same session? Open the PR directly, not an
  issue first, or the two lanes race.
- **CI:** Node 22 + 24, typecheck + build + test + self-scan.
- **Fork verification backstop:** `.gitea/workflows/ci.yml` runs Ubuntu Node
  22/24, Windows host-Node, coverage status, quality gate, and C# lint on pushes
  to `schoen/main`, `feat/**`, `fix/**`. Coverage posts `pr-crew/coverage` for
  the default-branch gate. Check it green before pushing branches to GitHub to
  save cloud minutes and PR churn.

## Cross-platform and writing rules

Contributors and CI run on Linux, macOS, and Windows.

- **No Unix-only shell in `package.json` scripts:** `rm -rf`, `cp`, `mv`, etc.
  fail under cmd.exe. tsdown cleans its output directory by default, so
  `rm -rf dist` is redundant; the build script is just `tsdown`.
- **No `VAR=value cmd` prefixes:** cmd.exe cannot parse them (`NODE_ENV` is
  reported as unrecognized). Source does not read `NODE_ENV`; the build does
  not need that assignment. If a script genuinely needs an environment variable,
  add the `cross-env` dev dependency and use `cross-env VAR=value cmd`.
- Emit forward-slash diagnostic paths so `/`-anchored classifiers match on all
  operating systems. Green Linux CI alone is not a Windows guarantee.
- **On this fork, Windows test failures are regressions**, not environment noise.
  The merged `fix/windows-tests` work made `schoen/main` fully green. Separately,
  clean upstream checkouts have known path/permission failures (home-directory
  resolution, `0600` bits, repository-relative paths); do not apply that caveat
  to fork failures.
- Defender inspects files opened by scanner binaries and slows large Windows
  scans. Before changing exclusions, read
  [Windows performance](docs/windows-performance.md) for the opt-in process/path
  exclusion script `scripts/setup-windows-defender.ps1` and its tradeoffs;
  `node.exe` is deliberately not in its managed list.
- **ASCII punctuation only; no em-dashes** in generated prose, comments, commit
  messages, PR bodies, or string literals. Use ` - `, `:`, or parentheses;
  non-ASCII punctuation can trigger cp1252 encoding problems on Windows.
- **No hard-coded machine-specific paths in shipped code or docs.** Derive paths
  from `os.homedir()`, environment variables, or arguments for portability.
- Prefer full-word identifiers (`maximum`, not `max`; `configuration`, not
  `config`) unless this clashes with an existing API.

## Detector design: closed, structural decisions

Before writing a detector, state its finite, enumerable question. **A detector
is a fixed spelling or a query over a real parser's tree**, never a regex-driven
mini-parser. Mandatory [development details](docs/agent-development.md) preserve
the full examples and boundaries.

- Beyond a literal token/one-line fixed spelling, JS/TS **must use the
  TypeScript compiler AST**; C# must use its bundled tree-sitter tree. A parser
  does not make intent inference sound.
- No hand-rolled bracket matching, top-level argument splitting, alias/binding
  tracking, or nearby-issue-link parsing. Blanking strings/comments first does
  not make text matching structural.
- Python stays fixed-spelling-only until a grammar is bundled; existing text
  detectors are grandfathered. Document alias/binding non-detections.
- No intent/meaning inference from surrounding declarations. Recurring new
  misclassifications on one axis mean rescope. Bounded neighboring syntax and
  AST parents are allowed only for definite structural questions.
- **Freeze detector PR scope:** state detections and deliberate non-detections.
  Out-of-scope inputs are follow-ups; claimed-input misfires and false positives
  on ordinary valid code block. Under-reporting is acceptable; valid-code
  misfires are not (users disable the engine).
- Record bounds and why non-detections are deliberate in `docs/rules.md` when
  the rule lands. Do not claim more coverage than the code provides.
- Let authors express intent with
  `// aislop-ignore-next-line <rule> -- reason`, rather than growing exclusion
  lists to guess it.

## Detector design: deterministic results and scan scope

The same tree and configuration must yield the same findings and score on every
machine/account, locally and in CI. **This outranks coverage.** Detectors that
need environment-dependent decisions do not ship in that form.

- Decisions may read only scanned files, repository `.aislop/` configuration,
  and documented CLI options, not the invoking account (`os.homedir()`, user
  name, `HOME`/`USERPROFILE`), hostname, undocumented environment variables,
  working directory outside the scan root, wall clock, timezone, locale, or
  machine-global tool settings. jb `InconsistentNaming` is excluded by default
  because it depends on machine-global ReSharper configuration.
- Optional external tools are the only sanctioned variation, **and output must
  name it**. Absent, disabled, or failed tools must appear in the lint execution
  record, a `*-skipped` advisory, or an engine failure, never a clean zero.
  Fixed-tool-set consumers pin versions and validate execution records (as
  git-wizard's gate does for jb and roslynator).
- Known violations to close, not copy: `docs/rules.md` documents missing C# and
  C/C++ tooling as silently skipped.
- **Git-index detectors must respect selected scan paths** (`--staged`,
  `--changes`, hooks, and include filters), without dropping selected non-source
  artifacts through source-extension filtering. Surface missing Git and
  operational Git failures, including scope-discovery failures, rather than
  treating them as successful empty results. Only genuine non-repositories are
  quiet. See `src/engines/ai-slop/committed-artifacts.ts` and
  `src/commands/scan-file-scope.ts`; hooks pass their selected artifact paths in
  `src/hooks/io/scoped-scan.ts`.

## Self-detection and new-rule checklist

aislop scans itself. In all detector files under `src/engines/ai-slop/`, **do not
embed literal detected patterns** in regexes, strings, or diagnostic messages.
Break them with string concatenation. The required development doc preserves
the concrete example.

1. Pick or create the appropriate `src/engines/ai-slop/` file.
2. Write a detector returning `Diagnostic[]`; avoid self-detection as above.
3. Register **every new rule id in any engine** in all consistency-gate locations
   or `pnpm vitest run` fails:
   - `src/commands/rules.ts`: `BUILTIN_RULES`.
   - `src/output/rule-labels.ts`: both `RULE_LABELS` and `RULE_DESCRIPTIONS`.
   - `src/scoring/rule-impact-ai-slop.ts` or `rule-impact-core.ts`: the relevant
     classification (`strict` / `standard` / `maintainability` / `mechanical` /
     `style` / `advisory` / `report-only`), composed by `src/scoring/rule-impact.ts`.
   - `docs/rules.md`: a catalog table row (asserted by tests).
4. Write tests in `tests/`.
5. Validate: `pnpm typecheck && pnpm vitest run && pnpm scan`.

## Packaging and other constraints

- `complexity.ts` must stay <= 400 lines; it checks itself for file-too-large.
- `package.json`'s `files` field controls npm contents: `dist`, `scripts`,
  `tools/grammars`, and `tools/jb` (bundled JetBrains settings). A new bundled
  asset outside `dist`/`scripts` needs its own inclusion or its resolver can
  silently return null from the installed package.
- PostHog's telemetry key is public client-side data, safe to hardcode.
  Telemetry is opt-out and off in CI by default.
