# AI Agent Instructions for aislop

This file provides context for AI coding assistants (Claude Code, OpenCode, Copilot, Cursor, etc.) working on the aislop codebase.

## What is aislop?

aislop is a unified code-quality CLI that catches the lazy patterns AI coding tools leave behind. It runs formatting, linting, code-quality, AI-pattern, architecture, and security checks behind a single command and returns a score out of 100.

- **npm package**: `aislop`
- **CLI binary**: `aislop`
- **Config directory**: `.aislop/`
- **Repository**: https://github.com/scanaislop/aislop

## Build & test commands

```bash
pnpm install           # Install dependencies
pnpm build             # Build with tsdown (tsdown cleans dist itself)
pnpm typecheck         # tsc --noEmit
pnpm test              # Build + vitest run
pnpm vitest run        # Run tests without rebuilding (faster iteration)
pnpm test:coverage     # Run tests with V8 line coverage and Cobertura output
pnpm scan              # Build + run aislop on itself
node dist/cli.js scan . # Run after building manually
```

## Cross-platform scripts

Contributors and CI run on Linux, macOS, and Windows. Keep `package.json`
scripts portable:

- **No Unix-only shell in scripts.** `rm -rf`, `cp`, `mv`, etc. fail under
  cmd.exe on Windows. tsdown already cleans its output directory before each
  build, so an explicit `rm -rf dist` is redundant; the `build` script is just
  `tsdown`.
- **No `VAR=value cmd` prefixes.** cmd.exe cannot parse a leading env-var
  assignment, so `NODE_ENV=production tsdown` errors with
  `'NODE_ENV' is not recognized`. If a script genuinely needs an env var set
  cross-platform, add the `cross-env` dev dependency and use
  `cross-env VAR=value cmd`.
- **A green Linux CI run is not a Windows guarantee.** A handful of
  path/permission tests (home-dir resolution, `0600` permission bits,
  repo-relative path conversion) are environment-specific and may fail locally
  on Windows while passing in CI. Emit forward-slash paths in diagnostics so
  `/`-anchored classifiers match on every OS.

## Writing conventions

- **No hard-coded machine-specific paths** in shipped code (e.g.
  `C:\Users\...`, `/home/...`). Derive from `os.homedir()`, env vars, or
  arguments so it works across machines and CI.
- **Avoid em-dashes** (U+2014) in committed prose and string literals; a stray
  em-dash can force a cp1252 re-encode on some Windows toolchains. Use ASCII
  (` - `, `:`, or parentheses).

## Key architecture decisions

- **TypeScript strict mode**, ES2022 target, bundler module resolution
- **Zod v4** for config validation. Import from `"zod/v4"`, not `"zod"`
- **tsdown** (rolldown-based) for bundling. Two entry points: `cli.ts` and `index.ts`
- **Version injection**: `tsdown.config.ts` reads `package.json` version and injects it via `env.VERSION`. Access it in source via `process.env.VERSION`.
- **vitest** for testing with a 30-second timeout
- **pnpm** as the package manager (pnpm-workspace.yaml, pnpm-lock.yaml)
- **Node ^22.18 || >=24.11 required** (tsdown 0.22's own engines floor; it relies on `Promise.withResolvers` among other modern APIs). One floor for running and building.

## Project structure

```
src/
  cli.ts                    # CLI entry (commander.js)
  index.ts                  # Public API exports
  version.ts                # APP_VERSION constant

  commands/                 # CLI subcommands
    scan.ts, fix.ts, ci.ts, init.ts, doctor.ts, rules.ts, interactive.ts

  config/                   # Configuration
    schema.ts               # Zod v4 schema
    defaults.ts             # Default values and YAML templates
    index.ts                # File discovery and loading

  engines/                  # Detection engines (run in parallel)
    types.ts                # Diagnostic, Engine, EngineContext types
    orchestrator.ts         # Parallel engine runner
    format/                 # Formatting (biome, ruff, gofmt, cargo fmt, rubocop, php-cs-fixer)
    lint/                   # Linting (oxlint, ruff, golangci-lint, clippy, rubocop)
    code-quality/           # Complexity, duplication, dead code (knip)
    ai-slop/                # AI pattern detection (13 rules)
    architecture/           # Custom import/path rules
    security/               # Secrets, eval, innerHTML, SQL/shell injection, audits

  scoring/                  # Score calculation (0-100, density-aware)
  output/                   # Terminal rendering, JSON output
  utils/                    # Discovery, git, subprocess, tooling, telemetry

tests/                      # Vitest tests (13 files, 285+ tests)
scripts/                    # Postinstall tool downloads (ruff, golangci-lint)
.aislop/                    # aislop's own config
```

## Self-detection avoidance

aislop scans itself. Detector source code must NOT contain the literal patterns being detected. Use string concatenation to break patterns:

```typescript
// WRONG. aislop will flag its own source
const pattern = /as any/;

// CORRECT. Breaks the literal so it won't self-match
const pattern = new RegExp(`${"a" + "s"}\\s+${"an" + "y"}`);
```

This applies to regex patterns, string literals, and diagnostic messages in all detector files under `src/engines/ai-slop/`.

## Naming conventions

- **`aislop`** is the npm package name, CLI binary name, and config directory (`.aislop/`)
- **`ai-slop`** is the engine name and rule prefix (e.g., `ai-slop/trivial-comment`). Do NOT rename these. They are internal identifiers, not user-facing branding.
- **`"AI Slop"`** is the category label in diagnostics. Do NOT change this.

## Workflow

- **Branch model**: branch from current `origin/develop`; open PRs to `develop` unless the task explicitly says otherwise.
- **Main promotion**: `develop` -> `main` is a maintainer decision. Do not merge it just because checks are green.
- **Releases**: publishing a GitHub Release runs `.github/workflows/release.yml`; failed npm publishes can use its guarded manual recovery after promotion to `main`.
- **CI**: Node 22 + 24 matrix, typecheck + build + test + self-scan.
- **In-house verification backstop (fork)**: `.gitea/workflows/ci.yml` runs the
  full matrix (ubuntu node 22/24, windows host-node, coverage status, quality
  gate, C# lint) on the self-hosted gitea for every push to `schoen/main`,
  `feat/**`, `fix/**`. The coverage job posts `pr-crew/coverage` for the
  default-branch gate.
  Check it green there before pushing branches to GitHub - saves cloud runner
  minutes and keeps draft-PR churn quiet.
- All changes should pass: `pnpm typecheck && pnpm test && pnpm test:coverage && pnpm scan`.

## Agent operation guardrails

- Default to draft PRs unless the task explicitly asks for a ready PR.
- Do not merge PRs, publish releases, or promote branches unless explicitly asked in the current task.
- Verify package installs in a clean temp environment before reporting a published package as working.

## Rule design: state a closed decision surface

Before writing a detector, write down the question it answers and check that the
question has a finite, enumerable answer. A rule that decides **semantics from
syntax over an open-ended input space cannot be finished by iteration**: a
reviewer probing it adversarially will always find two more real
misclassifications, each fix will be correct, and the defect count will not
converge. Three detectors stalled this way, accumulating 17 review rounds
between them with no quality improvement, until the guessing subsystems were
deleted rather than refined.

Signs the surface is open, and the rule needs rescoping rather than another fix:

- The detector infers intent ("is this configuration, or data?", "is this a
  route, or a filesystem path?"). Intent has no syntactic answer.
- It assigns meaning to context instead of asking a closed structural question:
  what surrounding declarations mean or what an identifier was bound to. Reading
  bounded neighboring syntax or following AST parent nodes is still structural
  when the resulting question has a definite answer.
- Each review round fixes the named case and surfaces a different case on the
  same axis.

What a closed surface looks like: a literal list you can read in one sitting, a
single-line pattern, or a structural query with a definite answer. A closed list
can be under-inclusive or over-inclusive, and a reviewer can probe it
exhaustively and stop. That is the property that makes a rule finishable.

Concrete guidance:

- **Python detectors must be structurally decidable without reconstructing Python
  semantics.** No import tracking, alias resolution, scope stacks, or decorator
  scope. `python-patterns.ts` is the house pattern: match explicit spellings and
  bounded lexical shapes such as one line, a fixed neighboring window, a
  delimited signature, or a literal whole-file marker. Treat unrecognized aliases
  and bindings as documented non-detections. Modelling Python binding semantics
  with regexes and no parser does not work.
- **JS/TS detectors may use TypeScript AST state**, because structural queries
  (is this node a property assignment?) have definite answers. Inferring meaning
  from surrounding syntax does not become sound just because an AST is available.
- **Under-reporting is acceptable; misfiring on valid code is not.** A rule that
  fires on ordinary application code gets the whole engine switched off, which
  costs more than every finding it would ever produce.
- **Record the bounds in `docs/rules.md` when the rule lands**, not after someone
  rediscovers them. State what is deliberately not detected and why. A
  documented non-detection is a design decision; an undocumented one reads as a
  bug, and a doc that claims more coverage than the code delivers turns a correct
  diagnostic into an apparent misfire.
- **Let the author express intent, not the detector guess it.** The inline
  suppression `// aislop-ignore-next-line <rule> -- reason` exists for the case
  the rule cannot decide. Reach for it instead of growing an exclusion list,
  because a growing exclusion list is the open surface coming back.

## Adding new AI slop rules

1. Pick the right file in `src/engines/ai-slop/` (or create a new one)
2. Write a detector function returning `Diagnostic[]`
3. Use string concatenation to avoid self-detection (see above)
4. Register the new rule id in **every** place the consistency-gate tests
   check, or `pnpm vitest run` will fail (this applies to any new rule id in
   any engine, not just ai-slop):
   - `src/commands/rules.ts` (`BUILTIN_RULES` array)
   - `src/output/rule-labels.ts` - **two** maps: the short label map and the
     longer description map
   - `src/scoring/rule-impact.ts` - a score-impact classification
     (`strict` / `standard` / `maintainability` / `style` / `advisory`)
   - `docs/rules.md` - a table row (the catalog test asserts this)
5. Write tests in `tests/`
6. Validate: `pnpm typecheck && pnpm vitest run && pnpm scan`

## Important constraints

- `complexity.ts` must stay <= 400 lines (it checks itself for file-too-large)
- The `files` field in `package.json` controls what ships to npm: `dist`,
  `scripts`, and `tools/jb` (the bundled JetBrains settings asset). A new
  bundled asset outside `dist`/`scripts` needs its own entry here or it silently
  ships as null from its resolver function.
- PostHog telemetry key is a public client-side key (safe to hardcode)
- Telemetry is opt-out and off in CI by default

## Cross-platform notes

Contributors and CI run on Linux, macOS, and Windows. Keep `package.json`
scripts portable:

- **No Unix-only shell in scripts.** Do not prefix commands with `rm -rf`,
  `cp`, `mv`, etc. They fail under cmd.exe on Windows. tsdown already cleans
  its output directory before each build (the `clean` option defaults to
  `true`), so an explicit `rm -rf dist` is both redundant and non-portable.
  The `build` script is just `tsdown`.
- **No `VAR=value cmd` prefixes.** cmd.exe cannot parse a leading env-var
  assignment, so `NODE_ENV=production tsdown` errors with
  `'NODE_ENV' is not recognized`. Nothing in this codebase reads `NODE_ENV`
  (the bundle is byte-identical with or without it), so it was dropped. If a
  script ever genuinely needs an env var set cross-platform, add the
  `cross-env` dev dependency and use `cross-env VAR=value cmd`.
- **Windows tests are fully green on this fork.** The `fix/windows-tests`
  work merged into `schoen/main` made the entire suite pass on Windows
  (112 files / 1164 tests as of the upstream-0.11.0 merge). A clean
  *upstream* checkout still fails ~42 tests on Windows (path/permission
  assumptions), so a red suite there is expected - but on `schoen/main`
  any Windows test failure is a real regression, not environment noise.
- **Windows Defender slows large scans.** Real-time scanning inspects every
  file aislop's scanner binaries open. `scripts/setup-windows-defender.ps1`
  manages opt-in process/path exclusions; see
  [docs/windows-performance.md](docs/windows-performance.md) for the
  tradeoffs (including why `node.exe` is deliberately excluded from the
  managed list).

## Local deploy (running your build as the global `aislop`)

To make the `aislop` command on your machine run a local checkout instead of
the published npm release:

```bash
pnpm build              # produce dist/
pnpm link --global      # repoint the global aislop at this checkout
aislop --version        # verify it resolves to your build
```

This fork is developed with git worktrees under `.worktrees/` (one per
branch). `pnpm link --global` from a worktree points the global command at
that worktree's `dist/`, so rebuild after switching branches. Remotes:
`origin` is upstream (scanaislop/aislop); `fork` is the personal fork
(mtschoen/aislop) with an integration branch `schoen/main`.

Alternative: install the fork build as a pinned global package (what the
fleet machines use):

```bash
cd /tmp/x   # neutral dir: no pnpm-workspace.yaml, no packageManager pin
~/AppData/Roaming/npm/pnpm add -g --allow-build=aislop "github:mtschoen/aislop#schoen/main"
```

Invoke pnpm's npm-installed shim directly, NOT via corepack: the nested
`pnpm install` that prepares the git tarball sees this repo's
`packageManager` pin, and a corepack-invoked pnpm refuses to version-switch
(ERR_PNPM_PREPARE_PACKAGE). Re-run the same line after pushing new commits
to refresh the pinned install.

To publish the fork build to the internal Gitea npm registry as
`@schoen/aislop` (for consumer repos that install it like a normal
dependency), run `scripts/publish-gitea.ps1` from a machine on the
internal network. Bump `version` in package.json first; the registry
rejects an already-published version.

## Writing conventions

- **No em-dashes** (U+2014) in generated content: prose, comments, commit
  messages, PR bodies, string literals. Use ASCII (` - `, `:`, or
  parentheses). On Windows a stray em-dash can force cp1252 encoding issues.
- **No hard-coded machine-specific paths** in shipped code (e.g.
  `C:\Users\...`, `/home/...`). Derive from `os.homedir()`, env vars, or
  arguments so it works across machines and CI.
- **Full-word identifiers** over abbreviations (`maximum` not `max`,
  `configuration` not `config`) where it does not clash with existing API.
