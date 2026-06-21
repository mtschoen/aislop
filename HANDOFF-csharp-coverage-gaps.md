# C# engine coverage gaps (dogfooding handoff)

> **ALL TIERS COMPLETE (2026-06-20).** Tier 1+2+1d landed in commit `0bad668`;
> Tier 3 (1a formatter, item 4 worker exemption, coverage-label cleanup, idiom
> rules incl. string-concat-in-loop, IDisposable via roslynator `IDISP001`) landed
> in `db875d0` + biome cleanup `482cfa8`, merged into `schoen/main`, CI green on the
> fork. `dotnet format whitespace` is scoped to whitespace only (the gofmt analogue)
> so it doesn't overlap roslynator; IDisposable uses IDisposableAnalyzers (CA2000 is
> disabled-by-default) so no curated type list is needed; `ConfigureAwait` is
> deliberately left to roslynator. The per-tier notes below are retained as the
> historical record. Nothing here is still open.

Source: dogfooding `aislop 0.12.0` (the `mtschoen/aislop` C#-capable fork build) on
**file-wizard** (a real multi-project C# repo: net8 class lib + CLI + net10 tests +
MAUI), 2026-06-19. The repo scanned at 17/100 then 25/100 after a cleanup pass. The
findings below are aislop-engine gaps surfaced by that scan, listed for triage in
this repo. None of these block file-wizard; they describe where C# coverage trails
the other languages.

## Status (updated 2026-06-20)

Addressed in this repo (feat/csharp-support):
- **1c false-green** - format/lint engines now report `skipped (no ... for the
  detected languages)` instead of "done (0 issues)" when no runner fires. (Note:
  1b lint was already wired to `roslynator`; the false green only showed when
  roslynator was absent.)
- **1d NuGet dependency audit** - `dotnet list package --vulnerable
  --include-transitive --format json` is now wired into the security engine
  (`security/vulnerable-dependency`, `detail: dotnet`) and `doctor`'s audit plan,
  gated on `csharp` + `dotnet` installed. Top-level and transitive findings,
  deduped across target frameworks. Validated end-to-end against a real CVE.
- **2 swallowed-exception comment consistency** - a comment-only catch (line OR
  block) now passes as documented/intentional; only a truly-empty `{ }` flags.
- **3 idiom layer (partial)** - added `csharp-broad-catch`, `csharp-linq-count`,
  `csharp-index-loop`, `csharp-if-ladder`. Still open: missing `using`/IDisposable,
  `ConfigureAwait(false)`, string-concat-in-loop (need type info / Roslyn).
- **5 comment double-counting** - `narrative-comment`/`meta-comment` are now
  deduped per file:line in the orchestrator.

Still open: 1a (formatter wiring), 4 (console-leftover worker-process exemption),
and the type-info idiom rules above. Separately surfaced: `.cs` sits in BOTH the
supported source list and `discover.ts`'s `UNSUPPORTED_CODE_EXTENSIONS`, so a C#
repo still scores fine but is cosmetically labeled `dominantUnsupported: "C#"` in
the coverage breakdown - worth cleaning up.

Toolchain note: on the scanning machine **both `roslynator 0.12.0.0` and
`dotnet format` are installed and on PATH**, so the gaps below are real wiring gaps,
not "tool absent."

---

## 1. Engine-level gaps (highest impact)

### 1a. No C# formatter is wired (false green)
`aislop doctor` reports Formatting **"skipped - no formatter / no supported
language"** for a C# repo, yet `aislop scan` prints **"Formatting: done (0 issues)"**
in its summary. `dotnet format` (and csharpier) exist and are installed. Effect: a CI
reader sees a green Format engine and assumes the C# is format-clean when the engine
did nothing.
- Wire `dotnet format` (or csharpier) as the C# formatter, AND/OR
- make the scan summary mirror `doctor` and print **"skipped (no C# tool)"** instead
  of "done (0 issues)" so it isn't read as a pass.

### 1b. No C# linter is wired (false green) - headline
Same shape for Linting: `doctor` says **"skipped - no linter / no supported
language"**, `scan` says **"Linting: done (0 issues, ~2s)"**. `roslynator 0.12.0.0`
is installed. The fork's selling point is "C#/roslynator support," but the lint
engine is not invoking roslynator (or any Roslyn analyzer bridge) for this repo.
Investigate engine discovery/wiring - is it looking for a global tool, a `dotnet
roslynator` invocation, an analyzer package? This is the single biggest gap: every
other major language gets a linter (ruff, clippy, oxlint, typescript, rubocop, go),
C# gets none despite the tool being present.

### 1c. Format/Lint "done (0 issues)" vs doctor "skipped" is the real bug
Independent of wiring the tools: the scan summary and `doctor` disagree. `doctor` is
honest ("skipped, no supported language"); the scan summary launders the same state
into "done (0 issues)". At minimum the two should agree, because the scan summary is
what CI and humans read.

### 1d. No NuGet dependency audit
Security depends on a lockfile; C# projects rarely commit `packages.lock.json`, so
`security/vulnerable-dependency` is effectively always off for C#. Other ecosystems
(npm/pip/cargo/go/bundler/composer) get a real audit. Consider a `dotnet list
package --vulnerable` path so C# gets dependency-vuln coverage.

---

## 2. swallowed-exception: comment-emptiness heuristic is inconsistent

A `catch` whose body is **only a `//` line comment** is treated as empty and flagged,
but the same catch with an **inline `/* ... */` block comment** is treated as handled
and passes. Observed on file-wizard (same file even):

- `catch { /* swallow: a throwing handler must not kill the watcher */ }` -> PASS
- `catch { // Access denied, etc. }` -> FLAGGED
- `catch (OperationCanceledException) { // Normal stop. ... }` -> FLAGGED

Both forms are documented intentional catches; only the comment syntax differs. This
pushed the cleanup toward `/* */` purely to satisfy the parser, which is a tell the
heuristic is syntactic rather than semantic. Recommend: treat a non-trivial line
comment the same as a block comment (a catch body that is *any* real comment naming
the invariant should count as handled), or document the intended distinction.

---

## 3. Rule-level C# AI-slop depth vs other languages

C# ships 8 ai-slop rules (async-void, console-leftover, empty-catch-rethrow,
not-implemented, null-forgiving, redundant-doc-comment, suppressed-warning,
sync-over-async) - all "leftover" focused. Python alone has 8 idiom-level rules
(bare/broad-except, chained-dict-get, isinstance-ladder, mutable-default,
print-debug, range-len-loop, repetitive-dispatch). C# has no idiom layer. Missing
analogues that would carry their weight on real C#:

- **broad-catch** (cf. `python-broad-except`): `catch (Exception ex) { log; continue; }`
  is invisible unless the body is empty. A non-empty broad catch that hides specific
  failure modes is exactly the slop Python flags.
- **LINQ idioms**: `.Count() > 0` -> `.Any()`, `.Where(p).First()` -> `.First(p)`,
  eager `.ToList()` forcing materialization, multiple-enumeration of `IEnumerable`.
  A large, very common C# slop surface, entirely uncovered.
- **missing `using` / IDisposable**: a disposable created and never disposed - the
  canonical C# resource leak. Uncovered.
- **`ConfigureAwait(false)`** in library async (deadlock/perf) - relevant to any
  class-library target. Uncovered.
- **index-loop -> foreach** (cf. `python-range-len-loop`): `for (int i=0; i<a.Length; i++)`
  where `foreach` is clearer. Uncovered.
- **if/else-ladder -> switch** (cf. `python-repetitive-dispatch`). Uncovered.
- **string concat in a loop -> StringBuilder**. Uncovered.

---

## 4. csharp-console-leftover: no "child-process worker" exemption

The rule exempts console *apps* but not a **library that is also a child-process
worker**. file-wizard's `MftScanHelper` / `UsnJournalScanHelper` are elevated worker
processes whose **stdout is the IPC protocol** (the parent reads results from stdout);
their `Console.Write*` is the contract, not a leftover. The rule flagged them. Consider
an exemption for a designated worker entrypoint, or a heuristic distinguishing
structured stdout writers from stray debug prints.

---

## 5. Rule overlap / double counting

`ai-slop/narrative-comment` and `ai-slop/meta-comment` fired on the **identical 6
locations** (algorithm section-header comments). One underlying comment is penalized
twice under two rule IDs, inflating both the finding count and the score impact for a
single issue. Consider deduping overlapping comment rules per location, or making them
mutually exclusive.

---

## 6. What worked well (keep)

The C# engine's real-signal hit rate was high where it does have rules:

- **swallowed-exception** correctly found 11 genuine empty catches and drove real
  fixes (a centralized best-effort `QuietFile.TryDelete`, the
  `AggregateException.Handle(e => e is OperationCanceledException)` teardown pattern,
  and narrowing a bare access-denied catch so real faults propagate). Strong signal.
- **csharp-sync-over-async**, **csharp-null-forgiving**, **complexity/file-too-large**,
  **complexity/function-too-long** all fired accurately on real targets.

The leftover-detection layer is solid. The gap is the absent format/lint wiring (1)
and the missing idiom layer (3).

---

# Tier 3 continuation (handoff for a fresh session, 2026-06-20)

Tier 1 (1c, 2, 5) + Tier 2 (4 idiom rules) + 1d (NuGet audit) + the README fix are
**done and verified** (see Status section up top). They are committed on
`feat/csharp-support` (look for the session's commit). What remains is Tier 3 below.

## Orientation for the next agent

- **Branch:** `feat/csharp-support` (the fork keeps C# support here, not on `main`).
- **C# rules are pure regex over split lines** - no AST/Roslyn. Engine entry points:
  `src/engines/ai-slop/csharp-patterns.ts` (most rules + the `scanLineMatches`
  helper and `pushFinding`), `src/engines/ai-slop/exceptions.ts` (swallowed-exception
  C# arm), `src/engines/security/audit.ts` (NuGet audit).
- **Adding a rule touches FOUR places**, all enforced by
  `tests/commands/rules.catalog.test.ts`: (1) emit it in the engine, (2)
  `src/commands/rules.ts` catalog list, (3) `src/output/rule-labels.ts` label,
  (4) `docs/rules.md` table. Miss one and the catalog test fails.
- **Doctor parity:** `src/commands/doctor.ts` has parallel `FORMAT_SPECS` /
  `LINT_SPECS` / `AUDIT_SPECS` planners. A new tool wired into an engine should get
  a matching doctor spec so `aislop doctor` and the scan summary agree (the 1c bug
  was exactly this disagreement). `AUDIT_SPECS` now supports a `languages` predicate
  (added for 1d) for tools with no fixed manifest filename.
- **Test pattern:** mkdtemp + write a `.cs`/`.csproj` fixture + call the detector;
  see `tests/csharp-patterns.test.ts`. Engine-result tests use `DEFAULT_CONFIG`;
  see `tests/engines/format-lint-skip.test.ts`.

## Gotchas (cost real time this session)

- **Rebuild before any CLI smoke test.** `node dist/cli.js` runs stale code until you
  re-run `npx tsdown`. I burned a debug cycle on a "missing" feature that was just an
  unrebuilt `dist/`. Always `npx tsdown` after editing `src/` before smoke-testing.
- **Test baseline is 45 pre-existing failures on Windows** (file-mode `0o600`, git
  worktrees, FD leaks, `examples/`/`vendor/` path detection). Do NOT chase these.
  Verify regressions by failure-count delta, not absolute (stash-and-compare works).
- **dotnet 10.0.300 is installed** here and supports `--vulnerable` (needs >=9.0.300)
  and auto-restores. `roslynator` is also installed, so lint actually runs.
- **No em-dashes** in any generated content (user rule); messages use ` - ` ASCII.

## Remaining work, in recommended order

### 1a. Wire a C# formatter (`dotnet format` or csharpier) - M
- Add a `runDotnetFormat` to `src/engines/format/` mirroring `gofmt.ts`/`ruff-format.ts`,
  and a branch in `format/index.ts` gated on `csharp` + tool installed. `dotnet format
  --verify-no-changes --report <json>` (or csharpier `--check`) gives a parseable
  diff; emit a `format/*` diagnostic per unformatted file.
- Add a `FORMAT_SPECS` entry in `doctor.ts` (use the `languages` predicate, like the
  1d AUDIT_SPECS entry, since there's no fixed manifest name) so doctor reports it.
- Smoke-test against a real `.cs` file with bad formatting; `dotnet format` is slow
  (restore + msbuild) so mind `auditTimeout`-style bounds.

### 4. console-leftover worker-process exemption - S/M (design-y)
- `flagConsoleLeftover` in `csharp-patterns.ts` exempts Exe projects and
  `Console.Error`. Add a worker-entrypoint exemption: a library whose `Console.Write*`
  on stdout IS an IPC protocol (file-wizard's `MftScanHelper`/`UsnJournalScanHelper`).
- Cleanest heuristic: a marker attribute/pragma (e.g. `[IpcWorker]` or a
  `// aislop-worker` comment) on the file/class; check for it before the
  `CONSOLE_OUT_RE` scan. Decide the convention with the user first - it's a new
  public contract.

### Coverage-label cleanup (`.cs` mislabeled unsupported) - S
- `.cs` is in BOTH `source-files.ts` (supported, line ~22) and
  `src/utils/discover.ts` `UNSUPPORTED_CODE_EXTENSIONS` (line ~57, value "C#").
  A C# repo still scores (verified: 90/100), but coverage reports
  `dominantUnsupported: "C#"`, which reads wrong. Remove `.cs` from
  `UNSUPPORTED_CODE_EXTENSIONS` and check `analyzeCoverage`'s `negligible` math still
  holds for a pure-C# repo (supportedFiles must stay > 0). Add/adjust a coverage test.

### Type-info idiom rules - L, lower priority / higher false-positive risk
- missing `using`/IDisposable, `ConfigureAwait(false)`, string-concat-in-loop. These
  need type knowledge a line-regex doesn't have. Options: a curated well-known-types
  list (e.g. `SqlConnection`, `FileStream`, `HttpClient` for IDisposable), or defer to
  the roslynator path. `ConfigureAwait` is best left to roslynator entirely. Discuss
  the accuracy/recall tradeoff with the user before building - the existing rules are
  high-precision and that reputation is worth protecting.

## Branch leftovers to be aware of
- `schoen/main`, `fix/discover-languages`, `fix/windows-portability` each have an
  unpushed merge-of-`main` commit from the start of this session (not pushed by
  request). `feat/csharp-support` also has unpushed commits.
