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
pnpm scan              # Build + run aislop on itself
node dist/cli.js scan . # Run after building manually
```

## Key architecture decisions

- **TypeScript strict mode**, ES2022 target, bundler module resolution
- **Zod v4** for config validation. Import from `"zod/v4"`, not `"zod"`
- **tsdown** (rolldown-based) for bundling. Two entry points: `cli.ts` and `index.ts`
- **Version injection**: `tsdown.config.ts` reads `package.json` version and injects it via `env.VERSION`. Access it in source via `process.env.VERSION`.
- **vitest** for testing with a 30-second timeout
- **pnpm** as the package manager (pnpm-workspace.yaml, pnpm-lock.yaml)
- **Node >= 20 required**. `tsdown`/`rolldown` uses `node:util.styleText` which requires Node 20.12+

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

- **Branch model**: `develop` branch -> PR to `main` -> squash merge
- **Releases**: automated via `.github/workflows/release.yml` on `v*` tags
- **CI**: Node 20 + 22 matrix, typecheck + build + test + self-scan
- All changes should pass: `pnpm typecheck && pnpm test && pnpm scan`

## Adding new AI slop rules

1. Pick the right file in `src/engines/ai-slop/` (or create a new one)
2. Write a detector function returning `Diagnostic[]`
3. Use string concatenation to avoid self-detection (see above)
4. Register the rule in `src/commands/rules.ts` (`BUILTIN_RULES` array)
5. Write tests in `tests/`
6. Validate: `pnpm typecheck && pnpm vitest run && pnpm scan`

## Important constraints

- `complexity.ts` must stay <= 400 lines (it checks itself for file-too-large)
- The `files` field in `package.json` controls what ships to npm. Only `dist` and `scripts`
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
