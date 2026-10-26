# Rules Reference

`aislop` groups checks into six engines. Each engine runs in parallel for speed.

## Formatting

Enforces consistent formatting using the best tool for each language.

| Language | Tool |
|---|---|
| TypeScript / JavaScript | Biome |
| Python | ruff format |
| Go | gofmt |
| Rust | cargo fmt |
| Ruby | rubocop |
| PHP | php-cs-fixer |
| C/C++ | clang-format (requires `.clang-format` in the repo) |

## Linting

Catches bugs and bad practices.

| Language | Tool |
|---|---|
| TypeScript / JavaScript | oxlint (bundled, with React/Next.js awareness) |
| Expo / React Native | expo-doctor (project health, dependency checks) |
| Python | ruff |
| Go | golangci-lint |
| Rust | clippy |
| Ruby | rubocop |
| C# | jb inspectcode + Roslynator + AsyncFixer/Meziantou (optional, requires .NET SDK; each tool toggleable independently) |
| C/C++ | cppcheck + clang-tidy + optional jb inspectcode/ReSharper C++ (clang-tidy requires `compile_commands.json`; jb is off by default and needs Windows + MSVC; all are system tools, not bundled) |

### C# linting: hybrid jb + Roslynator

The C# lint pass is a **hybrid of two independently togglable tools** that both run when available, with findings merged and de-duplicated:

- **jb inspectcode** (`jb/*` rules) - ReSharper-native inspections via the JetBrains CLI
- **Roslynator** (`dotnet/*` rules) - Roslyn analyzer diagnostics

Both tools run by default when available: each runs only when it is enabled (both default to on) AND its CLI is installed AND a `.csproj`/`.sln` is present. Missing tooling is silently skipped.

**Restore-evidence gate.** With a solution file at the repo root, the whole solution is analyzed in one pass. Without one, both tools fan out per `.csproj` - and every project costs a full MSBuild workspace load, so aislop only analyzes projects with restore evidence (`project.assets.json`, written by `dotnet restore` or a build, in `obj/` beside the project or in an arcade-style central `artifacts/obj/<ProjectName>/`), capped at 32 projects per scan. Skipped projects are reported once per scan as an advisory `dotnet/projects-skipped` info diagnostic rather than silently dropped. This is the C# analogue of clang-tidy gating on `compile_commands.json`: on a cold checkout the build-backed passes step aside instead of serially burning their timeouts, and the text-tier C# rules still run. `dotnet format` applies the same gate silently.

#### jb inspectcode (`jb/*`)

Rules are named `jb/<ReSharper-inspection-id>`, e.g. `jb/RedundantUsingDirective`. jb inspectcode produces ReSharper-native inspections across the full solution.

**Severity mapping:**

| jb severity | aislop severity |
|---|---|
| ERROR, WARNING | warning |
| SUGGESTION, HINT | info |

The floor is controlled by `jbSeverityFloor` (default: `WARNING`). Findings below the floor are dropped. `InconsistentNaming` is excluded by default because it binds to a machine-global ReSharper config and produces unreliable results via the CLI.

**Install:**

```bash
dotnet tool install -g JetBrains.ReSharper.GlobalTools
```

#### Roslynator (`dotnet/*`)

Shells out to the [`roslynator`](https://github.com/dotnet/roslynator) CLI and reports a curated subset of analyzer diagnostics, each prefixed `dotnet/`:

| Rule | What it catches |
|---|---|
| `dotnet/AsyncFixer01` | Unnecessary `async`/`await` (the await is the last statement) |
| `dotnet/AsyncFixer02` | Long-running or blocking operations inside an `async` method |
| `dotnet/AsyncFixer03` | Fire-and-forget `async void` - unhandled exceptions crash the process |
| `dotnet/MA0040` / `MA0042` / `MA0045` | Meziantou async/`Task` best practices (cancellation tokens, blocking calls) |
| `dotnet/CS0219` / `CS0162` | Unused variable / unreachable code (compiler diagnostics) |
| `dotnet/IDISP001` | An `IDisposable` is created but never disposed (resource leak; from IDisposableAnalyzers) |
| `dotnet/projects-skipped` | Advisory notice: projects without restore evidence (or beyond the 32-project cap) were not analyzed by the build-backed passes |

**Install:**

```bash
dotnet tool install -g roslynator.dotnet.cli
```

aislop bundles the AsyncFixer, Meziantou.Analyzer, and IDisposableAnalyzers assemblies so these rules fire even on projects that don't reference them. Where Roslynator reports an accurate async finding, the approximate Phase-1 regex rule (`ai-slop/csharp-async-void` / `ai-slop/csharp-sync-over-async`) at the same line is suppressed so you never see both.

#### De-duplication

Selected C# analyzers report invocation failures and missing or unreadable reports as not-run targets. A jb report counts only when it is structurally complete (XML comments ignored): an opened `<Report>` holding a self-closing `<Issues />` or an `<Issues>` section closed by `</Issues>`, with `</Report>` ending the document. jb writes `<Project>` elements only for projects with findings, so a clean report carries none; a clean report counts only after exit code 0, while a report naming a project is accepted at any exit code. Solution coverage uses `dotnet sln list` members with the existing visibility/exclude/gitignore filtering and jb's `jbProjects` scope. jb credits only exact trimmed stdout lines `Inspecting <FileName>.csproj`; `Analyzing` lines under `--swea` are context, not inspection proof. Roslynator uses one solution run with `--verbosity detailed`, credits `Analyze '<ProjectName>'` lines using the project file name without `.csproj`, and rejects members named by `Msbuild failed when processing the file '<path>'` lines. Missing evidence leaves members unanalyzed; zero evidence with expected members fails naming the tool. Solution members that can emit evidence during the invocation and share a project file name with an expected member (including user-excluded members, which jb still inspects) cannot be attributed and fail explicitly. These console spellings were observed on jb 2026.2 and roslynator 0.13.0; unrecognized output fails closed. Deliberately, jb inspection still counts when references fail to resolve: dependency health is outside this coverage check. A per-project pass retains its invocation-target behavior (and jb scope filtering). Both `scan` and `ci` exit non-zero for unresolved failures, independently of scoring. Roslynator retries failed solution invocations through visible restored projects, capped at 32; missing solution evidence fails coverage without retrying. Recovery requires at least one project, no visible project omitted for restore evidence or the cap, and successful analysis of every fallback target. Successful findings survive partial failure. Success from jb does not cover Roslynator failure or conversely. Timeouts share this failure path but do not trigger solution fallback; timeout budgets are unchanged.

With `projectEvaluation: true`, enabled analyzers missing from PATH or without solution or restored project targets fail the gate. Projects skipped for missing restore evidence are engine failures, including an unrestored member of an otherwise restored solution despite a successful analyzer report. Run `dotnet restore` to supply `project.assets.json`. Disabled project evaluation and explicitly disabled analyzers retain their skip policy. A pass that succeeds against a solution must also have analyzed every C# member that `dotnet sln list` reports, minus user-excluded and gitignored projects (and, for jb, projects outside the `jbProjects` scope); a missing or unrestored member, or a `dotnet sln list` that cannot run, is reported as a not-run target the same way. C++-only jb failure policy is unchanged.

When both tools run, findings are merged and de-duplicated by `(filePath, line, bare-rule-id)`, where the bare rule id is the part after the `jb/` or `dotnet/` namespace prefix (so a `jb/CS0219` and a `dotnet/CS0219` at the same site count as one). When jb and roslynator report an equivalent finding at the same location, the jb finding wins.

Multi-targeted members count once per project file. jb repeats the same `Inspecting <FileName>.csproj` line; Roslynator's `Analyze '<ProjectName>(<tfm>)'` lines are attributed to `<ProjectName>.csproj` when unique among active solution members and not ambiguous with a literal parenthesized project file name. An MSBuild failure naming the member excludes the whole project, including targets with successful analysis evidence.

#### `lint.csharp` config block

Both passes are independently togglable via the `lint.csharp` config block:

```yaml
lint:
  csharp:
    projectEvaluation: false              # opt in only for repositories you trust
    jb: true                              # run jb inspectcode if installed
    roslynator: true                      # run roslynator if installed
    jbSeverityFloor: WARNING              # ERROR | WARNING | SUGGESTION | HINT
    jbExcludeTypes: [InconsistentNaming]  # CLI-unreliable; bound to machine-global config
    # jbProjects: "MyApp*"               # optional --project glob to scope big solutions
```

| Field | Default | Description |
|---|---|---|
| `projectEvaluation` | `false` | Allow MSBuild-backed lint, format, and NuGet audit passes. These may evaluate repository-controlled project files; enable only for repositories you trust. Forces `ci.failOnMissingTools: true`, overriding explicit `false`. Enabled C# analyzers with missing tools or no restored targets, and projects without restore evidence (including solution members), fail the gate. |
| `jb` | `true` | Run jb inspectcode when installed |
| `roslynator` | `true` | Run roslynator when installed |
| `jbSeverityFloor` | `WARNING` | Drop jb findings below this severity |
| `jbExcludeTypes` | `["InconsistentNaming"]` | Inspection type IDs to exclude from jb results |
| `jbProjects` | (unset) | Optional `--project` glob passed to jb inspectcode to scope analysis in large solutions |

### C/C++ linting: cppcheck, clang-tidy, and (optional) jb inspectcode

The C/C++ lint pass shells out to system tools (none are bundled):

- **cppcheck** (`cppcheck/*` rules) - runs on any C/C++ checkout; no extra files required
- **clang-tidy** (`clang-tidy/*` rules) - runs only when a `compile_commands.json` is present (generated by CMake with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, or by Bear/intercept-build)

**Chunked invocation.** cppcheck runs once per deterministic chunk of source files (see `chunkFilePaths`) rather than in a single invocation, so a large enough tree cannot exceed the OS command-line length limit. Each chunk has a 180s timeout. If a chunk times out or otherwise fails to run, its files are not analyzed and their findings are absent from that scan; this is reported once per scan as an advisory `cppcheck/chunks-skipped` info diagnostic rather than silently dropped, alongside a per-chunk stderr warning identifying the affected files. Recover the skipped findings by re-running cppcheck directly on the named files or investigating why the chunk timed out or failed.

`clang-tidy` discovery is intentionally flexible for common build outputs:

- `build/compile_commands.json`
- `build/<Configuration>/compile_commands.json` (for multi-config/partitioned CMake outputs)
- `out/compile_commands.json`
- `cmake-build-*/<...>/compile_commands.json`

Example CMake commands:

```bash
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build
```

If your CI writes the database in a different subdirectory, keep that directory stable across runs so aislop can find it.

- **jb inspectcode** (`jb/Cpp*` rules) - ReSharper C++ inspections via the JetBrains CLI, OFF by default (enable with `lint.cpp.jb`). The same `jb` tool used for C# also inspects C++ projects in a loadable solution; it requires Windows + MSVC for the MSBuild project model.
Findings from all active tools are merged and de-duplicated by `(filePath, line, canonical-rule-id)`. The canonical id collapses jb's clang-tidy-backed inspections (`jb/CppClangTidyBugproneNarrowingConversions`) onto the matching standalone clang-tidy id (`clang-tidy/bugprone-narrowing-conversions`) so the same defect is not double-counted.

The C/C++ lint pass is configurable via the `lint.cpp` block:

```yaml
lint:
  cpp:
    cppcheck: true                 # run cppcheck if installed
    clangTidy: true                # run clang-tidy if a compile DB is present
    cppcheckEnable: "warning,performance,portability"
    jb: false                      # run jb inspectcode (ReSharper C++) over C++ projects
    jbSeverityFloor: WARNING        # ERROR | WARNING | SUGGESTION | HINT
    jbExcludeTypes: []             # jb TypeIds to exclude from C++ results
    # jbProjects: "MyNative*"      # optional --project scope for jb's C++ pass
```

| Field | Default | Description |
|---|---|---|
| `cppcheck` | `true` | Run cppcheck when installed |
| `clangTidy` | `true` | Run clang-tidy when a `compile_commands.json` is present |
| `cppcheckEnable` | `warning,performance,portability` | cppcheck `--enable` set |
| `jb` | `false` | Run jb inspectcode over C++ projects (requires `jb` + a loadable solution; Windows + MSVC) |
| `jbSeverityFloor` | `WARNING` | Drop jb C++ findings below this severity |
| `jbExcludeTypes` | `[]` | jb TypeIds to exclude from C++ results |
| `jbProjects` | (unset) | Optional `--project` scope for jb's C++ pass |

When both C# and C++ jb are enabled, aislop runs a single inspectcode pass over the union of both project scopes and partitions the results by language.

Missing tooling is silently skipped; run `aislop doctor` to see what is detected.

## Code Quality

Measures structural complexity, finds dead code, and detects unused dependencies.

| Rule | What it checks |
|---|---|
| `complexity/function-too-long` | Functions exceeding configurable line limit (default: 80). For Python, measured by logical body code: the signature, docstrings, comments, and blank lines do not count. For C#, measured from the bundled tree-sitter C# grammar over block-bodied methods, constructors, destructors, operators, conversion operators, local functions, and accessors (starting at the signature rather than leading attributes, comments, or preprocessor directives); type declarations (including C# 12 primary-constructor types) and expression-bodied members (`=>`) are deliberately not measured as functions, and a missing or unloadable C# grammar fails the `code-quality` engine rather than falling back to line patterns. For C++ and other brace-delimited languages, declarations and prototypes ending in `;` have no body and are skipped. Braces inside strings, comments, and regexes are ignored. `async def`/`async Task` and multi-line wrapped signatures are detected. |
| `complexity/file-too-large` | Files exceeding configurable line limit (default: 400, counting every physical line). Both size rules report only past 10% over the limit; see [Quality thresholds](configuration.md#quality-thresholds) for how lines are counted. |
| `complexity/deep-nesting` | Control-flow nesting beyond threshold (default: 5). For C#, computed from each block-bodied member's AST body (`if`, `for`, `foreach`, `while`, `do`, `switch`, `try`, with `else if` remaining at the enclosing `if` depth). |
| `complexity/too-many-params` | Functions with too many parameters (default: 6). For Python, counts required parameters only: `self`/`cls`, `*args`/`**kwargs`, the `*` / `/` separators, and parameters with a default are not counted. For C#, counts syntax-tree parameters on block-bodied members and on ordinary class/struct primary constructors, ignoring comments and attributes and counting a trailing `params` parameter once. Positional `record`, `record class`, and `record struct` component lists are deliberately excluded because they declare properties; explicit constructors and methods inside records are still checked. |
| `code-quality/duplicate-block` | Repeated blocks of implementation code that should usually be extracted or shared |
| `code-quality/repeated-chained-call` | Repeated long call chains on the same receiver that should usually be cached or factored |
| `code-quality/unused-declaration` | Unused top-level declarations detected for safe removal |
| `knip/files` | Unused files not imported anywhere (JS/TS, fixable with `fix -f`) |
| `knip/exports`, `knip/types` | Unused exports and types (JS/TS) |
| `knip/dependencies` | Unused dependencies in package.json (fixable with `fix`) |
| `knip/devDependencies` | Unused devDependencies in package.json (fixable with `fix`) |
| `knip/unlisted` | Packages imported in code but missing from package.json |
| `knip/unresolved` | Imports that cannot be resolved |
| `knip/binaries` | Binaries used but not declared in package.json |
| `knip/duplicates` | Duplicate exports reported by knip |

## AI Slop

The rules that make aislop unique. These catch the patterns AI assistants leave behind.

| Rule | Severity | What it catches |
|---|---|---|
| `ai-slop/trivial-comment` | warning | Comments restating the code (`// Import React`, `// Return the value`) |
| `ai-slop/narrative-comment` | warning | Decorative separators, phase/section headers, JSDoc preambles without meaningful tags (caught on top-level *and* interface/type members), cross-reference commentary, and longer prose blocks that carry an AI-narration signal (a restatement opener or step-by-step narration). Length alone is not flagged. |
| `ai-slop/swallowed-exception` | error | Empty catch blocks, catch blocks that only log (JS/TS/Python/Go/Ruby/Java/C#) |
| `ai-slop/silent-recovery` | warning | Catch blocks that log without including the caught error and then continue; Python logging calls that attach the traceback are exempt (see notes below the table) |
| `ai-slop/meta-comment` | warning | Comments about implementation phases, agent behavior, or generated-code process instead of the code itself |
| `ai-slop/hidden-fallback` | warning | JS/TS fallback logic that turns missing counts, failed diagnostics, or impossible states into safe-looking values without surfacing the missing input or failure |
| `ai-slop/redundant-try-catch` | warning | JS/TS catch blocks that only rethrow the same error without adding context, cleanup, or recovery |
| `ai-slop/redundant-type-coercion` | warning | TypeScript primitive parameters re-coerced with `String(...)`, `Number(...)`, or `Boolean(...)` |
| `ai-slop/duplicate-type-declaration` | warning | Exported TypeScript type/interface declarations repeated with the same name and shape across files |
| `ai-slop/thin-wrapper` | warning | Functions that only forward their own parameters unchanged to another function (a call that transforms its arguments is not flagged) |
| `ai-slop/generic-naming` | info | AI-generated names: `helper_1`, `data2`, `temp1` |
| `ai-slop/unused-import` | warning | Unused imports (JS/TS and Python) |
| `ai-slop/unused-css` | warning | Custom CSS/SCSS classes defined in stylesheets but referenced nowhere in the project (className/`cn`/`clsx`/template literals/`data-*`/HTML/JSX). Tailwind/utility-looking classes are skipped, and any class whose name appears as a substring in any source string (e.g. an interpolation prefix like `ui-`) is spared. Project-wide pass; conservative by design. |
| `ai-slop/console-leftover` | warning | `console.log`/`debug`/`info` left in production code |
| `ai-slop/todo-stub` | info | Unresolved, untracked TODO/FIXME/HACK comments (a TODO that links a tracking issue is spared) |
| `ai-slop/unreachable-code` | warning | Code after `return`/`throw` statements |
| `ai-slop/constant-condition` | warning | `if (true)`, `if (false)`, `if (0)` |
| `ai-slop/empty-function` | info | Empty function bodies |
| `ai-slop/unsafe-type-assertion` | warning | `as any` in TypeScript |
| `ai-slop/double-type-assertion` | warning | `as unknown as X` pattern |
| `ai-slop/ts-directive` | info | `@ts-ignore` / `@ts-expect-error` usage |
| `ai-slop/unknown-directive` | warning | `aislop-ignore-*` comments with an unrecognised scope (for example `aislop-ignore-nextline`), which suppress nothing. Checked in JS/TS, Python, Go, C#, and C/C++ files, where string literals can be told apart from comments. |
| `ai-slop/duplicate-import` | warning | Multiple imports from the same module that should be merged |
| `ai-slop/hardcoded-url` | warning | Environment-specific URLs hardcoded in production code instead of env/config; Python docstring content is exempt (see notes below the table) |
| `ai-slop/hardcoded-id` | warning | Provider/project IDs hardcoded in production code instead of env/config |
| `ai-slop/hardcoded-user-path` | warning | Home-directory paths (`/home/<name>`, `/Users/<name>`, `<drive>:\Users\<name>`, configured roots) hardcoded in source or tests instead of runtime APIs/config |
| `ai-slop/committed-tool-output` | warning | A tracked file whose name ends in `.log`, `.trx`, `.sarif`, `.stdout.txt`, `.stderr.txt`, `.tar.gz`, `.tgz`, `.tar`, `.zip`, or `.7z` (raw tool output committed as proof); see [Committed tool output](#committed-tool-output-ai-slopcommitted-tool-output-ai-slopcommitted-large-file) |
| `ai-slop/committed-large-file` | warning | A tracked text file (no NUL byte in its first 8000 bytes) larger than `quality.maxTrackedFileBytes` (default 524288 bytes, 512 KiB), other than a lockfile; see [Committed tool output](#committed-tool-output-ai-slopcommitted-tool-output-ai-slopcommitted-large-file) |
| `ai-slop/repeated-magic-literal` | warning | The same name and value pair repeats more than `quality.repeatedLiteralThreshold` times in supported Python, JavaScript, or TypeScript source, regardless of surrounding structure |
| `ai-slop/python-bare-except` | warning | Python `except:` blocks that catch everything without naming an exception type |
| `ai-slop/python-broad-except` | warning | Python broad exception handlers with silent/pass-style bodies |
| `ai-slop/python-mutable-default` | warning | Python function defaults such as `[]`, `{}`, or `set()` that are shared across calls; only bare top-level defaults, not call-wrapped keyword arguments (see notes below the table) |
| `ai-slop/python-print-debug` | warning | Python `print(...)` debug output left in production modules |
| `ai-slop/python-range-len-loop` | info | Python `for i in range(len(items))` loops that usually want direct iteration or `enumerate()` |
| `ai-slop/python-chained-dict-get` | warning | Python `.get(..., {}).get(...)` fallback chains that hide missing-data cases |
| `ai-slop/python-repetitive-dispatch` | warning | Repeated Python equality branch ladders that should usually become a table/set/handler map |
| `ai-slop/python-isinstance-ladder` | warning | Repeated Python `isinstance(...)` ladders that should usually become a handler map or normalized representation |
| `ai-slop/go-library-panic` | warning | Go `panic(...)` calls in non-main library code unless clearly intentional |
| `ai-slop/rust-non-test-unwrap` | warning | Rust `.unwrap()` in production code where errors should be handled or documented |
| `ai-slop/rust-todo-stub` | warning | Rust `todo!()` stubs in production code |
| `ai-slop/hallucinated-import` | error | JS/TS and Python imports without matching manifest declarations or recognized module evidence |
| `ai-slop/tautological-test` | warning | A single assertion that cannot fail: JavaScript/TypeScript `expect(true).toBe(true)`-style comparisons of equal fixed literals, `assert.ok(true)`, `expect(true).toBeTruthy()`, decided on the TypeScript AST; Python `assert True` or `assert 1` (optionally with a message) and `self.assertTrue(True)`; C# `Assert.True(true, ...)` and `Assert.IsTrue(true, ...)`. Judged per assertion, never from the rest of the test (see the bounds below the table) |
| `ai-slop/test-sleep` | warning | A fixed-duration delay written directly inside a test file, outside any loop (see the bounds below the table) |
| `ai-slop/test-spawn-timeout-literal` | warning | A numeric literal timeout bounding a real subprocess in a Python or JavaScript/TypeScript test file; the JavaScript/TypeScript arm is decided on the TypeScript AST (see the bounds below the table) |
| `ai-slop/test-wall-clock-assertion` | warning | A test assertion whose value comes from the real clock (see the bounds below the table) |
| `ai-slop/csharp-not-implemented` | warning | C# `throw new NotImplementedException()` stubs the agent forgot to fill in |
| `ai-slop/csharp-redundant-doc-comment` | warning | C# XML-doc `<summary>` that just restates the member (`Gets or sets the X`) without adding information |
| `ai-slop/csharp-async-void` | warning | C# `async void` methods that aren't event handlers (can't be awaited; exceptions crash the process) |
| `ai-slop/csharp-sync-over-async` | warning | C# blocking on a Task via `.Result` / `.Wait()` / `.GetAwaiter().GetResult()` (deadlock risk) |
| `ai-slop/csharp-suppressed-warning` | warning | C# `#pragma warning disable` / `[SuppressMessage]` without a justification comment |
| `ai-slop/csharp-empty-catch-rethrow` | warning | C# catch blocks that only rethrow without adding context, cleanup, or recovery |
| `ai-slop/csharp-null-forgiving` | warning | C# null-forgiving `!` operator silencing nullable warnings instead of handling null |
| `ai-slop/csharp-console-leftover` | warning | C# `Console.*` / `Debug.*` / `Trace.*` output left in library code |
| `ai-slop/csharp-broad-catch` | warning | C# `catch (Exception)` that catches everything (non-empty, non-rethrow) instead of the specific type(s) it can handle |
| `ai-slop/csharp-linq-count` | warning | C# `.Count() > 0` / `.Count() == 0` enumerating a whole sequence where `.Any()` short-circuits |
| `ai-slop/csharp-index-loop` | warning | C# index `for` loop over `.Length`/`.Count` that reads more clearly as `foreach` |
| `ai-slop/csharp-if-ladder` | warning | C# chain of 4+ if/else-if branches comparing one value against constants (a `switch` in disguise) |
| `ai-slop/csharp-string-concat-in-loop` | warning | C# string built with `+=` inside a loop (O(n^2) reallocation; use a `StringBuilder`) |
| `ai-slop/cpp-not-implemented` | warning | C++ stub throws `std::logic_error("not implemented")` or `assert(false && "not implemented")` |
| `ai-slop/cpp-using-namespace-std-in-header` | warning | `using namespace std;` at header scope leaks into every translation unit that includes the header |
| `ai-slop/cpp-c-style-cast` | warning | C-style cast in C++ code; prefer `static_cast` / `reinterpret_cast` for explicitness |
| `ai-slop/cpp-manual-delete` | warning | Manual `delete` / `delete[]`; prefer `std::unique_ptr` or RAII containers |
| `ai-slop/cpp-iostream-leftover` | warning | `std::cout` / `std::cerr` left in library code (files without a `main`) |
| `ai-slop/cpp-null-literal` | warning | `NULL` used in C++ (`.cc`/`.cpp`/`.cxx`/`.hh`/`.hpp`/`.hxx`); prefer `nullptr` |
| `ai-slop/cpp-define-constant` | warning | Object-like `#define` constant in C++; prefer `constexpr` / `const` |
| `ai-slop/cpp-endl-in-stream` | warning | `<< std::endl` flushes the stream on every call; prefer `'\n'` |
| `ai-slop/em-dash` | info | Non-ASCII dash characters: em dash (U+2014), en dash, horizontal bar, figure dash, unicode/non-breaking hyphen, minus sign |
| `ai-slop/smart-punctuation` | info | Curly single/double quotes, horizontal ellipsis, arrows, non-breaking and zero-width spaces |
| `ai-slop/systemd-timeout` | warning | `Type=oneshot` systemd unit without an explicit `TimeoutStartSec=`, or an explicit unbounded start timeout (`infinity`) without a rationale comment |

Note: `ai-slop/trivial-comment`, `ai-slop/narrative-comment`, and `ai-slop/swallowed-exception` also cover C# (`.cs`) and C/C++ (`.c`, `.cpp`, `.h`, `.hpp`).

For Go blank-identifier assignments, `ai-slop/swallowed-exception` checks explicit unqualified calls and indexes package-level function signatures once per directory per scan. A known non-error last result suppresses the finding. Matching local parameter names (including grouped parameters and named callback types) leave the call unresolved; the detector does not resolve callback types, imports, or aliases. This is a bounded lexical check, not Go type or scope analysis.

### Python dependency names (`ai-slop/hallucinated-import`)

For names extracted from `pyproject.toml`, `requirements.txt`, and `Pipfile`,
Python distribution comparisons follow PEP 503 normalization: lowercase the
name and replace every run of dots, underscores, and hyphens with one hyphen.
For example, `Foo.Bar` matches the import name `foo_bar`, and either
`discord.py` or `discord-py` satisfies `import discord`.

This normalization does not discover arbitrary distribution-to-module mappings.
The rule retains its existing import-root and distribution-prefix comparisons,
explicit import-to-distribution aliases, standard-library recognition, and local
module checks. Dots in Python import statements still separate submodules.
The change does not expand supported manifest syntax or resolve installed package
metadata, and an unrelated undeclared import still produces a finding.

### Repeated magic literals (`ai-slop/repeated-magic-literal`)

**What is reported.** The same literal value, appearing under the same name more than `quality.repeatedLiteralThreshold` times in one file, is reported once. The comparison is exclusive: a threshold of 3 first reports at 4 occurrences. This is a counting rule: it does not examine what encloses a literal. A value assigned in a plain statement, passed as a call argument, sitting in an object literal, or repeated across the rows of a lookup table all count the same way. A collection whose rows all repeat one value is reported deliberately, because that is one default written N times, not N independent decisions.

**Supported structural sites.** In Python, the rule scans keyword arguments and plain assignments (`name = value`) at any nesting depth, over comment- and string-masked source, so occurrences inside comments or string literals are not counted.

In JavaScript and TypeScript, the rule scans object property assignments, parameter defaults, variable-declaration initializers, class property initializers, and plain assignment expressions (`target = value`), at any nesting depth. Whether the enclosing structure is a call argument, a returned object, a standalone variable, or a row of an array or object table makes no difference.

Supported JS/TS properties have static identifier, string, or numeric names. Supported values are finite numeric literals (including unary `+` and `-`) and non-empty string literals of at most 80 characters after parentheses and TypeScript assertion wrappers are removed. The numeric values -1, 0, 1, and 2 are treated as trivial and excluded.

**Deliberate non-detection: trivial values.** The numeric values -1, 0, 1, and 2, and five whitespace-only string values (a newline, a carriage return plus newline, a carriage return, a tab, and a single space), are never reported, regardless of how often they repeat. The whitespace set is closed and matched on the decoded value, so the escape spelling `"\n"` in Python, JavaScript, and TypeScript is exempt; a Python raw string such as `r"\n"` holds a backslash and the letter n, not a newline, and is still counted. Other whitespace strings (for example two spaces) and the empty string are not covered by this exemption.

**Differing values never group.** Grouping is by name and value together, so a property whose value differs across rows of a table never groups on that property. A named-constant reference (`timeout=_DEFAULT_TIMEOUT_SECONDS`) contributes nothing to any group: only literal occurrences are counted.

**Suppress above the reported line.** Where the repetition genuinely is data, or the values are meant to stay independently tunable, suppress it with a reason. The diagnostic is reported on the first occurrence in the group, so the directive goes above that line:

```ts
// aislop-ignore-next-line ai-slop/repeated-magic-literal -- per-state timeouts are independently tunable
```

### Vacuous assertions (`ai-slop/tautological-test`)

Reported per assertion on test files only. The JavaScript/TypeScript arm is decided on the
TypeScript AST of the unmasked source, including assertions split across multiple lines, and
reports on the line where the outer assertion call starts. Python and C# keep their line-based
behavior with string and comment interiors blanked. Examples quoted in strings or comments
are ignored.

| Language | Reported spellings |
| --- | --- |
| JavaScript/TypeScript | `expect(<literal>).toBe(<equal literal>)`, `assert.equal/strictEqual(<literal>, <equal literal>)`, `assert.ok(true)`, `assert(true)`, `expect(true).toBeTruthy()` |
| Python | `assert True`, `assert 1` (either may carry `, <message>`), `self.assertTrue(True)` |
| C# | `Assert.True(true, ...)`, `Assert.IsTrue(true, ...)` |

**JavaScript/TypeScript accepted shapes.** A call to `expect(<L>).toBe(<R>)` has exactly one
argument in each call, and equal fixed literals on both sides. Calls to `assert.equal(<L>, <R>)`
and `assert.strictEqual(<L>, <R>)` have at least two arguments, with equal fixed literals in the
first two positions. The other accepted calls are `expect(true).toBeTruthy()` with exactly one
inner argument and no outer arguments, `assert(true, ...)`, and `assert.ok(true, ...)`. Receivers
must be the identifiers `expect` or `assert`, and methods must be property accesses with exactly
the named method. Fixed literals are booleans, `null`, the identifier `undefined`, numeric literals
(optionally under unary minus), strings, and templates without substitutions. Equality requires
the same literal category and `Object.is` on the decoded values: `1` equals `1.0`, differently
quoted strings can be equal, and negative zero differs from zero.

**Deliberate non-detections.** The rule does not look at the rest of the test: a test whose only
assertion is vacuous is not distinguished from one with other assertions, and "must not raise"
smoke tests are not recognised. Python and C# assertions split across multiple lines are not
reported.
`assert x == x` and other identifier self-comparisons are not reported, and neither are Java, Go,
or Ruby spellings. JavaScript/TypeScript does not track aliases or `require(...)` bindings, and
does not report other callee names, non-literal values, or templates with substitutions.

```python
# aislop-ignore-next-line ai-slop/tautological-test -- placeholder until the harness lands
assert True
```

### Literal timeouts on real processes (`ai-slop/test-spawn-timeout-literal`)

Runs only over test files. A numeric kill bound on a real process is not an assertion, so the
clock rules never see it, yet under a loaded runner a healthy child outlives it and the test goes
red for a reason unrelated to the change.

**What is reported.** A direct numeric literal (`10`, `1_000`, `2.5`, or a product such as
`10 * 1000`) as the timeout of:

| Language | Reported calls |
| --- | --- |
| Python | `subprocess.run/check_output/check_call/call(..., timeout=<number>)`; a call to a configured wrapper name carrying `timeout=<number>`; `communicate(timeout=<number>)` and `wait(<number>)` / `wait(timeout=<number>)` on a name the same file assigns from `Popen(...)` |
| JavaScript/TypeScript | `execSync`, `spawnSync`, `execFileSync` with `{ timeout: <number> }`; `child_process.exec` / `execFile` (also `childProcess.`) with the same option |

**JavaScript/TypeScript accepted shapes.** The TypeScript AST of the unmasked source decides
calls whose callee is exactly the identifier `execSync`, `spawnSync`, or `execFileSync`, or a
property access named `exec` or `execFile` on the identifier `child_process` or `childProcess`.
When the first argument is not a spread, the second argument is checked when it is an object
literal; for `spawnSync`, `execFileSync`, and `execFile`, the third argument is checked when the
second argument is an array literal and the third argument is an object literal. Its effective `timeout` is determined in
property order: identifier, string, and template-without-substitutions keys named `timeout`
are accepted, including computed string and template literal keys. The last matching key wins
across all key forms. A property assignment accepts a positive numeric literal (including numeric
separators), a recursively nested product of accepted numeric literals, or parentheses around
either shape. A matching shorthand property, method, getter, setter, or other value replaces the
effective value with a non-literal. A spread after the last matching key makes the value
undecidable; a spread before a later matching key does not matter. A computed key that is not a plain
string or template literal, appearing after the last matching key, makes the value undecidable
and nothing is reported; one before a later matching key does not matter. Findings use the line and column of the call's start and preserve the literal source text.

**Configuration.** `aiSlop.testSpawnTimeout.wrapperNames` (default `run_captured`,
`run_command`, `_run`) names the Python wrappers treated as process spawns; setting it replaces
the default list. `aiSlop.testSpawnTimeout.helperPaths` lists path substrings; a test file whose
repository-relative path contains one is skipped, which is how a shared test-side helper that
owns the bound stays quiet.

**Deliberate non-detections.** A named constant (`timeout=BOUND`), an environment lookup with a
literal default, `None`, and expressions outside the accepted literal or product shapes above are
not reported; neither is
a JS/TS `timeout` property whose effective value is non-literal or has a later spread. The JS/TS
arm does not track aliases or `require(...)` bindings, and does not report `cp.execSync`,
identifiers that are not exactly the named callee, options arguments preceded by a spread
argument, third-position options when the second argument is not an array literal (such as a
second-position callback or an opaque identifier/call), non-literal values, zero, negative values,
or templates with substitutions. A method call on a receiver the file does not visibly assign
as a bare name from `Popen(...)` at statement level is not reported, nor is a `timeout` argument
on a non-process call such as an HTTP client. Other languages are not covered.

**Fix, in order.** Run the logic in-process and delete the spawn; otherwise mark the test as
integration tier and take the bound from one shared helper; for a test about timeout handling,
fake the timeout outcome. A bound that is the subject of the test can be kept in place:

```python
# aislop-ignore-next-line ai-slop/test-spawn-timeout-literal -- the timeout is what is under test
subprocess.run(["sleeper"], timeout=1)
```

### Test timing (`ai-slop/test-sleep`, `ai-slop/test-wall-clock-assertion`)

Both rules run only over the files the scan classifies as tests. Every arm but one reads source
with string and comment interiors blanked, so a spelling quoted inside a fixture or shown in a
comment is never reported. The exception is the C# arm of `ai-slop/test-wall-clock-assertion`,
which parses the file (see below) and gets the same guarantee from the parse.

**Languages covered.** Python (`.py`), JavaScript/TypeScript (`.ts`, `.tsx`, `.js`, `.jsx`,
`.mjs`, `.cjs`), C# (`.cs`), Go (`.go`), PHP (`.php`), and C/C++ (`.c`, `.cc`, `.cpp`, `.cxx`,
`.h`, `.hh`, `.hpp`, `.hxx`). Java and Rust are deliberately not covered: aislop has no
string/comment masker for those extensions, so a sleep spelling inside a string literal could
not be told apart from real code. Ruby is deliberately not covered: `ai-slop/test-sleep`
relies on brace blocks for loop analysis (which Ruby closes with `end`), and
`ai-slop/test-wall-clock-assertion` shares the same test file loader so the two rules cover the
same languages.

#### Fixed sleeps (`ai-slop/test-sleep`)

**What is reported.** One of a closed list of sleep spellings, with a fixed non-zero duration,
that is not inside a loop:

| Language | Reported spellings |
| --- | --- |
| Python | `time.sleep(<number>)`, `asyncio.sleep(<number>)` |
| JavaScript/TypeScript | `setTimeout(<identifier>, <number>)` on a line that also builds a `new Promise(`; `await setTimeout(<number>)` (the `node:timers/promises` form) |
| C# | `Thread.Sleep(...)` and `Task.Delay(...)` taking a number or `TimeSpan.From*(<number>)` |
| Go | `time.Sleep(<number> * time.<Unit>)` and `time.Sleep(time.<Unit>)` |
| PHP | `sleep(<number>)`, `usleep(<number>)` |
| C/C++ | `sleep_for(chrono::<unit>(<number>))` |

**A delay inside a loop is not reported.** Polling a condition on an interval until a deadline
is the recommended replacement for a fixed sleep, and it is written as a delay inside a loop.
Every block enclosing the delay is walked outward and asked one question: does its header begin
with `for`, `while`, `do`, `foreach`, or `loop`? Python uses its own block rule, indentation,
to find those headers. A loop whose body is a single unbraced statement is recognised from the
one preceding statement.

**A zero duration is not reported.** `setTimeout(resolve, 0)` and `asyncio.sleep(0)` yield to
the scheduler; they do not wait on the wall clock.

**Deliberate non-detections.**

- **A delay reached through a helper.** `await sleep(50)`, `await delay(50)`, and
  `self._wait(50)` are not reported. Deciding that a name refers to a sleep would mean
  resolving imports and local bindings, and the rule stops at literal spellings.
- **A delay whose duration is not a literal.** `setTimeout(resolve, milliseconds)` and
  `time.sleep(timeout)` are not reported. This is what keeps a shared helper such as
  `const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))`
  out of the results; its callers pass the literal, and those call sites are not reported
  either, per the point above.
- **A delay spread over several lines.** Only the single-line spellings above are matched. A
  `new Promise` whose `setTimeout` sits on the next line is not reported.
- **Python `sleep(...)` imported bare.** `from time import sleep` followed by `sleep(2)` is not
  reported, because only the module-qualified spelling is matched.

Where a delay genuinely is what the test exercises, say so in place rather than reshaping the
rule:

```ts
// aislop-ignore-next-line ai-slop/test-sleep -- the debounce window under test is 200ms
await new Promise((resolve) => setTimeout(resolve, 250));
```

#### Clock-dependent assertions (`ai-slop/test-wall-clock-assertion`)

**What is reported.** Outside C#, a single line that both makes an assertion and reads the real
clock. Both halves are closed lists:

| Language | Assertion forms | Clock reads |
| --- | --- | --- |
| JavaScript/TypeScript | `expect(`, `assert(`, `assert.<name>(` | `Date.now()`, `performance.now()`, `hrtime` |
| Python | a line-leading `assert `, `.assert<Name>(` | `time.time()`, `time.monotonic()`, `time.perf_counter()`, `time.process_time()`, `datetime.now(`, `datetime.utcnow(` |
| Go | `assert.<Name>(`, `require.<Name>(` | `time.Now(`, `time.Since(` |
| PHP | `->assert<Name>(`, `assert(` | `microtime(`, `hrtime(`, `time()` |
| C/C++ | `EXPECT_*(`, `ASSERT_*(` | `chrono::duration_cast`, `*clock::now()`, `clock()` |

**C# is decided on the syntax tree, not on the line.** `.Elapsed*` is an ordinary property on
most receivers and reads the machine clock only on a `System.Diagnostics.Stopwatch`, so the C#
arm parses the file with the bundled tree-sitter C# grammar
(`tools/grammars/tree-sitter-c_sharp.wasm`) and asks a structural question of the tree. The grammar is loaded once per process, the first time a C# file is parsed; a project with no
C# files never loads it. For `ai-slop/test-wall-clock-assertion`, when the grammar is missing or cannot be loaded, a warning is emitted
to stderr (once per process) and the scan reports no C# findings rather than failing (whereas C# complexity checks in `code-quality` report an engine failure).


An assertion is reported when a clock read appears anywhere inside an `Assert.<Name>(...)`
invocation or inside an invocation whose member is `.Should()`, and the reported line is the
line of the clock read. A clock read is one of `DateTime.Now`, `DateTime.UtcNow`,
`DateTimeOffset.Now`, `DateTimeOffset.UtcNow`, `Environment.TickCount`,
`Environment.TickCount64`, `Stopwatch.GetTimestamp()` invocation, `Stopwatch.GetElapsedTime(...)`
invocation (including their `System.*` namespace-qualified forms), or a member whose name begins
with `Elapsed` read through `receiver.Member` or `receiver?.Member`.

**The `.Elapsed*` decision surface.** A member whose name begins with `Elapsed` is a clock read
if and only if its receiver, read through any parentheses and any null-forgiving `!`, is one of:

1. the spelling `Stopwatch`, `Diagnostics.Stopwatch`, or `System.Diagnostics.Stopwatch` (also the
   `global::`-qualified form), written as an identifier or a qualified name;
2. a Stopwatch construction, meaning `new Stopwatch(...)` or `Stopwatch.StartNew()` on one of the
   spellings in point 1;
3. a simple name `X`, written bare or as `this.X`, that is declared as a Stopwatch somewhere in
   the read's **binding region**.

The binding region is not a scope, and the rule does not resolve which declaration a read sees.
It is the union of two subtrees:

- the subtree of the member the read sits in. Parents are walked from the read to the first
  `method_declaration`, `constructor_declaration`, `destructor_declaration`,
  `operator_declaration`, `conversion_operator_declaration`, `property_declaration`,
  `indexer_declaration`, `event_declaration`, `field_declaration`, or `global_statement`. Local
  functions and lambdas belong to the member that contains them; they are not regions of their
  own. A top-level program is one region: the grammar wraps each top-level statement in its own
  `global_statement`, so a read in one of them takes every top-level statement in the file, not
  just the statement it sits in;
- the direct `field_declaration` and `property_declaration` members of the enclosing type
  (`class_declaration`, `struct_declaration`, `record_declaration`, `interface_declaration`;
  `record struct` and `record class` both parse as `record_declaration`). Direct members only:
  nested types are not walked, and neither base classes nor the other files of a partial class
  are consulted.

A name is *declared as a Stopwatch* when one of these declaration node shapes introduces it, and
no other:

- a `variable_declaration` whose declared type is one of the spellings in point 1 - every name it
  declares, which covers locals, `using` declarations, and fields;
- a `variable_declarator` whose initializer is a Stopwatch construction - the `var timer =
  Stopwatch.StartNew()` and `var timer = new Stopwatch()` forms;
- a `variable_declarator` that deconstructs a `tuple_pattern` from a `tuple_expression` - the
  pattern elements whose positionally matching initializer element is a Stopwatch construction;
- a `property_declaration`, a `parameter`, or a `declaration_expression` (the `out Stopwatch
  resolved` form) whose declared type is one of those spellings;
- a `foreach_statement` whose declared element type is one of those spellings.

Nothing else declares a name. In particular a method, indexer, or lambda whose *return* type is
`Stopwatch` declares no Stopwatch-typed name, so `Stopwatch Display()`, `Stopwatch Render<T>()`,
`Stopwatch IFactory.Make<T>()`, and `Stopwatch this[int index]` bind nothing; neither does an
assignment such as `presenter.display = Stopwatch.StartNew()`, nor a tuple-*valued* initializer
such as `var display = (Stopwatch.StartNew(), Elapsed: expected)`. A member read inside
`nameof(...)` is never a clock read, because `nameof` names a member without evaluating it.

**File-level opt-out.** If the file aliases the name (`using Stopwatch = ProgressDisplay;`) or
declares its own type called `Stopwatch` (class, struct, record, interface, enum, or delegate),
then every check above is off for that whole file, and so are the `Stopwatch.GetTimestamp()` and
`Stopwatch.GetElapsedTime(...)` reads. The other C# clock reads (`DateTime.Now`,
`DateTime.UtcNow`, `DateTimeOffset.*`, `Environment.TickCount*`) still run. This is one
structural query over the file rather than alias resolution: a file that has given the name
another meaning is simply not a file this rule can read.

**Deliberate over-inclusions.** The region is deliberately coarser than C# scoping, so two
shapes are reported that a compiler would resolve the other way. Suppress them in place:

- **A name declared as a Stopwatch in the region and rebound to another type in the same
  region.** A `ProgressDisplay display` parameter in a class that also has a `Stopwatch display`
  field, a lambda parameter shadowing a Stopwatch local, or an accessor's implicit `value` in a
  type that also has a `Stopwatch value` field: the read is reported. Collisions *across* members
  do not fire, because the region is the enclosing member plus the type's direct fields and
  properties.
- **`Stopwatch.StartNew()` where `Stopwatch` is a local, parameter, or property** rather than the
  type. The spelling is read as the type name unless the file opts out above.

**Deliberate non-detections.**

- **A Stopwatch that reaches the receiver any other way.** A stopwatch returned by a method
  (`var timer = factory.CreateStopwatch()`) or reached through an indexer, a cast, `as`, a
  conditional, `await`, or a method group is not tracked, so `timer.Elapsed` is not reported.
  Deciding those would mean resolving types across expressions, which is the open-ended surface
  this rule avoids.
- **A Stopwatch field declared in a base class or in another file of a partial class.** Only the
  enclosing type's own direct fields and properties are read.
- **A type alias for Stopwatch.** `using SW = System.Diagnostics.Stopwatch;` followed by
  `SW timer` declares nothing this rule recognises, and neither does a `global using` alias in
  another file. Only the literal spellings in point 1 are matched.
- **Receivers introduced by a shape that is not in the declaration list above**: implicitly typed
  lambda parameters (`shown => shown.Elapsed`), query range variables, pattern variables
  (`candidate is Stopwatch matched`), record primary-constructor parameters, and an accessor's
  implicit `value`.
- **Elapsed time computed on an earlier line.** `const elapsed = Date.now() - start;` followed
  by `expect(elapsed).toBeLessThan(500)` is not reported, and neither is the C# equivalent
  `var elapsed = timer.Elapsed;` followed by `Assert.Equal(expected, elapsed)`. Connecting the
  two would mean tracking the value a variable holds, which is the open-ended surface this rule
  avoids; the C# arm resolves declared types, never assigned values.
- **Whether the clock is mocked.** The rule does not look for `vi.useFakeTimers()`,
  `freezegun`, or an injected clock, and it does not try to decide whether a mock is in scope
  at the assertion. A test that has genuinely frozen the clock and still reads it in an
  assertion is reported; suppress it in place with a reason.
- **Go's plain `if` assertions.** `if time.Since(start) > limit { t.Fatal(...) }` is not
  reported, because only the testify-style assertion helpers are listed.

### Non-ASCII punctuation (`ai-slop/em-dash`, `ai-slop/smart-punctuation`)

The em dash is one of the most recognisable "an LLM wrote this" tells, and on Windows it is
also a practical liability: a stray U+2014 breaks cp1252 round-trips and forces compilers into
explicit UTF-8 modes. These two rules flag the character wherever it lands.

**What is scanned.** Every supported source extension plus prose and configuration files:
`.md`, `.markdown`, `.mdx`, `.rst`, `.adoc`, `.txt`, `.yml`, `.yaml`, `.toml`, `.json`,
`.jsonc`, `.ini`, `.cfg`, `.sh`, `.bash`, `.zsh`, `.ps1`, `.psm1`, `.bat`, `.cmd`, `.html`,
`.css`, `.scss`, `.vue`, `.svelte`, `.astro`, `.sql`. Comments, string literals, and prose are
all treated alike. Dependency lockfiles and auto-generated files are skipped; nothing else is.

**Emoji and non-Latin text are safe.** The rules match an explicit table of punctuation code
points, not "any byte above ASCII", so emoji, accented letters, and CJK text never match.

**No category exemptions.** Fenced code blocks, quoted tool output, and counter-examples are
*not* exempt just for being what they are. Content that genuinely needs the character opts out
explicitly, per line or per file:

```md
<!-- aislop-ignore-file ai-slop/em-dash -- this note is about em dashes -->
```

```ts
// aislop-ignore-next-line ai-slop/em-dash -- verbatim transcript of tool output
const captured = "...";
```

The trailing reason after `--` is itself exempt, so a suppression can name the character it is
silencing. The rest of the line is still scanned: a directive for an unrelated rule does not
smuggle punctuation through.

**Report-only by default.** Both rules ship at `info` severity in the `report-only` scoring
tier (multiplier 0), so they surface findings without moving the score or the exit code. That
is deliberate: a punctuation rule turned into a hard gate on day one reddens every repo with a
pre-existing backlog and teaches everyone to ignore the build. Measure the backlog, sweep it,
then promote:

```yaml
# .aislop/config.yml
rules:
  ai-slop/em-dash: error            # now fails `aislop ci`
  ai-slop/smart-punctuation: "off"  # or drop the softer family entirely
```

### Hardcoded user paths (`ai-slop/hardcoded-user-path`)

**What is reported.** This rule reports hardcoded machine-bound home paths in source and test files.
The decision surface is two closed lists. First, three fixed shapes, matched for any user name
that is not a placeholder: `/home/<name>/`, `/Users/<name>/` and `<drive>:\Users\<name>\` (either
separator, raw or source-escaped), plus the `file:` forms of each. Second, any roots listed under
`aiSlop.hardcodedUserPath.bannedRoots` in `.aislop/config.yml`, for non-standard roots such as
`/mnt/data/<name>`. The verdict depends only on the scanned text and the configuration, never on
the account that runs the scan. Given a banned root of `/home/alice`, both the exact root and its descendants
are reported:

```text
/home/alice
/home/alice/project
file:/home/alice/project
file:///home/alice/project
file://localhost/home/alice/project
```

On Windows, drive-letter and UNC roots are supported. Raw, source-escaped, mixed-separator, and
forward-slash spellings are accepted. Matching local file URLs such as
`file:///C:/Users/alice/project`, `file://localhost/C:/Users/alice/project`, and
`file://server/profiles/alice/project` produce one finding. For POSIX and Windows drive roots, the
`file:` scheme accepts no authority (`file:/...`), an empty authority (`file:///...`), and the
`localhost` authority (`file://localhost/...`, matched case-insensitively) as equivalent local
spellings; any other authority (`file://example.com/...`) is treated as remote and not reported.
The `localhost` authority is deliberately excluded for UNC roots: the authority position in a UNC
file URL names the server itself (`file://server/share/...`), so `file://localhost/server/...` is
a different, non-equivalent URL, not another spelling of the configured UNC root. POSIX matching is
case-sensitive; Windows matching is case-insensitive. When two banned roots overlap on the same
path (for example `/home/alice` and `/home/alice/project` both configured), only one diagnostic is
reported.

**Configuring non-standard roots.** `bannedRoots` covers homes that do not follow the standard
shapes:

```yaml
aiSlop:
  hardcodedUserPath:
    bannedRoots:
      - /mnt/data/team
```

Each configured root must be absolute (a POSIX `/...` root, a Windows drive root, or a UNC root);
see [docs/configuration.md](configuration.md#hardcoded-user-path-roots) for the exact forms
accepted and what happens to a non-absolute entry.

The built-in placeholder names are exactly `example`, `someone`, and `me`,
matched case-insensitively. Use `example` in fixtures and documentation.
`allowedPlaceholders` adds project-specific names for standard home shapes;
it does not exempt explicitly configured `bannedRoots` outside allowed locations.

Data configuration files allow hardcoded defaults: `.json`, `.jsonc`, `.yaml`,
`.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.env`, and basenames `.env` or
`.env.*`. Filename comparison is case-insensitive. Code-shaped configuration
files such as `tool.config.ts` and `tool.config.js` use the code policy.

In selected JS/TS sources (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`), a
direct source-file-level, non-exported `const` identifier declaration may
initialize a plain string literal or no-substitution template literal. Type
annotations and multiple declarators are permitted. Export modifiers, local
export specifiers (including renamed/default specifiers), and direct identifier
export assignments prevent that allowance. CommonJS-exporting files
(`module.exports` or `exports` member assignments and
`Object.defineProperty`/`defineProperties`/`assign` calls on unbound `exports`
or `module.exports`, independent of `require(...)` calls or locally bound
`exports`/`module` variables) receive no const allowance. The decision uses the
TypeScript parser and compiler symbols.

Only the literal's matched contents are exempt: calls and comments on the same
line are still checked. Inline arguments, getenv fallbacks, nullish defaults,
function-local consts, nested declarations, destructuring, tagged/interpolated
templates, concatenation, and wrapped initializers are not allowed locations.
Both home-shape and configured-root matches use this location policy.

C# and Python retain their existing fixed-shape detection without a structural
const allowance. A private C# field is not a module-level declaration; Python
structural analysis waits for a bundled grammar. The rule does not trace
arbitrary exported object graphs or transitive aliases. Invalid JS/TS syntax
receives no const allowance. Shared source enumeration is unchanged; the data
filename allowance is explicit even though ordinary source enumeration already
omits most data files.

**Escape hatches for a legitimate literal path.** Pick the narrowest that fits:

- `aiSlop.hardcodedUserPath.allowedPlaceholders` in `.aislop/config.yml` lists further user-name
  segments to exempt under the standard shapes (plain segments, no `/` or `\`, case-insensitive).
- A per-file override turns the rule off for a glob, for example `templates/**`, by setting
  `ai-slop/hardcoded-user-path: off` under `rules` in an `overrides` entry in `.aislop/config.yml`
  (see [ordered per-file overrides](configuration.md#ordered-per-file-overrides)).
- The inline comment `// aislop-ignore-next-line ai-slop/hardcoded-user-path -- reason` covers a
  single line.

The name exemption applies to the standard shapes only; a root listed in `bannedRoots` is reported
whatever its name.

**Why the boundary is narrow.** The rule does not infer whether an arbitrary `/home/<name>` string
is a filesystem path, web route, placeholder, or another account. That semantic question has no
sound syntactic answer across every language aislop scans. Restricting the match to fixed shapes plus the configured
`bannedRoots` makes the question finite and avoids growing an exclusion list to guess at routes.

**Known non-detections.** Deliberately not reported: WSL mounts (`/mnt/c/Users/<name>`), `~user`
spellings, `/root` (it is not a `/home/<name>` shape), the legacy Windows `Documents and Settings` root, UNC homes unless listed in
`bannedRoots`, template or glob names (`/home/$USER`, `/home/*`, `<name>`), and relative paths or
home-like suffixes inside another token. Add a root to `bannedRoots` to catch a non-standard
shape. Usernames end at whitespace in the fixed shape matcher. A path whose first
username word is non-placeholder is still reported, but a spaced username whose
first word is `example`, `someone`, or `me` can be missed. Literal-span allowances
do not change this boundary. Explicit banned roots can cover these names. Examples outside the rule:

```text
home/example/project
/srv/site/home/zed/project
```

HTTP and HTTPS URLs are consumed as opaque URL tokens before home paths are considered, so their
route segments are not reported. A local `file:` URL remains machine-bound and is reported. The
rule never attempts to distinguish a filesystem path from a web route by its shape; a route that
happens to spell a home shape (for example `/home/zed/summary` as a URL path) is reported the same as a filesystem path would be, because the rule
has no sound way to tell them apart.

**Suppress intentional matches at the site.** Use `aislop` suppression comments with a realistic reason:

```ts
// aislop-ignore-next-line ai-slop/hardcoded-user-path -- historical path retained in migration fixture
loadHistoricalPath("C:\\Users\\alice\\project");
```

### Systemd unbounded start timeouts (`ai-slop/systemd-timeout`)

**What is reported.** The unit type is read from the file extension (`.service`, `.socket`, `.mount`, `.swap`), and only the section that extension maps to is analyzed: `[Service]` for a `.service` file, `[Socket]` for `.socket`, `[Mount]` for `.mount`, `[Swap]` for `.swap`. Repeated matching sections merge in file order, matching systemd override semantics. Within that section, the participating start-timeout keys are `TimeoutStartSec` and `TimeoutSec` for `[Service]`, and `TimeoutSec` alone for `[Socket]`/`[Mount]`/`[Swap]` (systemd.socket, systemd.mount, and systemd.swap document only `TimeoutSec=`). The effective value is the last assignment, in file order, across those participating keys. Section names, directive keys, and enum values are compared with the exact casing systemd documents; any other casing is not a spelling systemd recognizes.

Two things are flagged from that effective state:
- `[Service]` with an effective `Type=oneshot` and no explicit start timeout, because systemd disables the start timeout by default for oneshot units (`TimeoutStartSec=infinity`), creating invisible unbounded runs that can stall deploy queues indefinitely.
- A final effective unbounded start timeout (the literal token `infinity`, or a time span totaling zero) unless it carries a preceding rationale comment.

**What is not reported.**
- Explicit bounded start timeouts (e.g. `TimeoutStartSec=5m`, `TimeoutStartSec=6h`).
- Explicit unbounded start timeouts carrying a preceding rationale comment explaining why the unit must run unbounded.
- `TimeoutStopSec=infinity` (stop and drain timeouts are legitimate for graceful process shutdown and do not affect startup bounds).
- Non-oneshot units without explicit start timeouts (systemd applies `DefaultTimeoutStartSec`, typically 90s, by default).
- Any wrong-cased section header, directive key, or enum value (e.g. `[service]`, `timeoutstartsec=infinity`, `Type=OneShot`, `TimeoutStartSec=Infinity`), because systemd itself does not recognize them.
- `TimeoutStartSec=` inside a `[Socket]`, `[Mount]`, or `[Swap]` section: systemd ignores that directive there, so it cannot mask or resolve the start timeout.
- A section that does not match the file's unit type (e.g. a `[Socket]` section in a `.service` file, or a `[Service]` section in a `.socket` file): systemd never reads it for that unit.
- Drop-in `.conf` fragments (e.g. `foo.service.d/override.conf`): the `.conf` extension is not one of the four scanned extensions.
- Directive values continued across lines with a trailing backslash.
- Unit content in files with a non-standard extension (for example `.service.j2`): only the exact four extensions above are analyzed.

### Committed tool output (ai-slop/committed-tool-output, ai-slop/committed-large-file)

Agents under review pressure sometimes commit raw tool output to the repository as
"proof": analyzer SARIF files, captured stdout and stderr, test inventories, evidence
tarballs. Past examples were `before.sarif` and `after.sarif` (11,746 lines each) plus
captured stream files, and several evidence tarballs of 100 KB to 3 MB beside a
53,000-line JSON inventory. The files go stale the moment the code changes and stay in
every clone forever.

**What is detected.** Both rules look only at files git tracks, the entries listed by
`git ls-files --cached`. Untracked and ignored files are never considered.

- `ai-slop/committed-tool-output` reports a tracked file whose basename ends, compared
  case-insensitively, in one of these fixed spellings: `.log`, `.trx`, `.sarif`,
  `.stdout.txt`, `.stderr.txt`, `.tar.gz`, `.tgz`, `.tar`, `.zip`, `.7z`. That is the
  whole list.
- `ai-slop/committed-large-file` reports a tracked text file whose size on disk exceeds
  `quality.maxTrackedFileBytes` (default 524288, 512 KiB; see
  [configuration](configuration.md#quality-thresholds)). Lockfiles are spared by exact
  basename: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`,
  `bun.lock`, `bun.lockb`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `Cargo.lock`,
  `go.sum`, `Gemfile.lock`, `composer.lock`, `packages.lock.json`, `flake.lock`,
  `mix.lock`, `pubspec.lock`, `Podfile.lock`. A file that matches the tool-output list
  is reported by `ai-slop/committed-tool-output` only.

**Deliberate non-detections.**

- A directory that is not a git repository yields no findings from either rule: with no
  repository there is nothing committed. Missing `git` is surfaced in the engine's
  `missingTools` record, and operational `git ls-files` errors are surfaced as engine
  failures.
- Raw dumps under other names that stay below the byte ceiling.
- Binary files of any size (gif, wasm, fonts, images). Text versus binary is git's own heuristic and the whole decision: a file is binary when a NUL byte appears in its first 8000 bytes. A NUL only after byte 8000 counts as text. There is no extension allowlist; binary archives are covered by `ai-slop/committed-tool-output` by name.
- Untracked files, including ignored ones.
- Any content-based judgement of whether a JSON, text, or markdown file is a dump.

**Escape hatch.** A binary or log file cannot carry an `aislop-ignore` comment. List the
legitimate fixture in the `exclude` entries of `.aislop/config.yml` (for example
`tests/fixtures`), or set the rule to `off` under `rules`. Otherwise put counts and the
reproduction command in the PR body or a short doc, or attach a CI artifact.

### Rule notes

**`ai-slop/python-mutable-default` and call-wrapped keyword arguments.** Only
bare defaults at the signature's top parenthesis level are flagged. A mutable
literal passed as a keyword argument inside a call (FastAPI/typer/pydantic
markers like `Body(default={})`) is deliberately not, because whether the
wrapper shares its result across calls is framework semantics the rule cannot
decide from syntax. flake8-bugbear covers that separate case as B008, and
needs a per-framework `extend-immutable-calls` allowlist to do it. Signature
scanning masks string literals and trailing comments before counting
parentheses, including f-string replacement fields that nest same-quote
strings (PEP 701, Python 3.12+); the one accepted approximation is a `#`
comment inside a multi-line replacement field, which is treated as expression
text because `#` is also a format-spec character.

**`ai-slop/hardcoded-url` and Python docstrings.** URLs inside Python
docstrings are documentation examples, not deployment targets, and are exempt.
A triple-quoted literal counts as a docstring only when docstring-positioned:
its opening delimiter (after optional prefix letters) is the first thing on
its line, making the string a bare expression statement - PEP 257
first-statement docstrings, attribute docstrings, and block-comment strings,
including the single-line form. An assigned or call-wrapped triple-quoted
value is a runtime value and stays scanned.

**`ai-slop/silent-recovery` and Python traceback-attaching logs.** A Python
except-block is exempt when a log call uses `logger.exception(...)` or passes
`exc_info=True`, since both attach the currently-handled exception's traceback
even though no bound exception name appears in the call. The exemption is
cancelled when that same call spells the literal `exc_info=False`, which
Python forwards to `Logger.error`, omitting the traceback. Calls wrapped
across several lines are read as one statement, so it makes no difference
which line an argument sits on. Any other
`exc_info` value (a variable, an expression) stays exempt rather than guessed
at, since deciding its value would mean evaluating Python. The keyword is
only recognised as code, so a message that mentions `exc_info=False` in its
text does not cancel the exemption.

## Security

Finds secrets, risky constructs, and vulnerable dependencies.

| Rule | What it catches |
|---|---|
| `security/hardcoded-secret` | API keys, AWS credentials, JWT tokens, database URLs, passwords |
| `security/eval` | `eval()` usage (JS/TS/Python/Ruby/PHP) |
| `security/innerhtml` | Direct `.innerHTML` assignment |
| `security/dangerously-set-innerhtml` | React `dangerouslySetInnerHTML` usage that needs sanitization |
| `security/sql-injection` | String concatenation/interpolation in SQL queries (JS/TS, C#) |
| `security/shell-injection` | User input in command execution (JS/TS/Python, C#, C/C++ `system`/`popen`) |
| `security/unsafe-deserialization` | Legacy .NET formatters (`BinaryFormatter`, `SoapFormatter`, ...) that deserialize arbitrary types |
| `security/unsafe-c-call` | Memory-unsafe C string functions (`gets`, `strcpy`, `strcat`, `sprintf`) |
| `security/vulnerable-dependency` | npm/pip/cargo/go dependency audit |
| `security/dependency-audit-skipped` | Dependency audit could not run because tooling or lockfile context was missing. A tool that failed, timed out or printed something other than its report is also reported here, with any findings it did print kept; `pip-audit` audits the project's `requirements.txt` with pip disabled by default, warning when there is none or when requirements are not exact `name==version` pins. Both pinned and resolving modes pass `--progress-spinner=off` to keep the JSON report clean even in terminal-forcing environments. With `security.resolvePythonRequirements: true`, only `aislop ci` may resolve loose requirements using pip, which can execute repository and package-index build code; resolved versions depend on the index at run time, so results can change without repository changes. Fully pinned files keep pip disabled. See [configuration](configuration.md#resolving-python-requirements-ci-only). NuGet audits run per scoped `.csproj`, so a solution member the dotnet CLI cannot evaluate (such as a `.vcxproj`) does not fail the whole audit; a `.csproj` whose assets are not restored is reported skipped by name |
| `security/dependency-audit-policy` | Cargo audit exited 1 with policy warnings but no vulnerability findings; the completed report denied configured dependency policy |
| `security/accepted-advisory` | Vulnerable dependency whose every advisory is listed in `security.acceptedAdvisories`; shown at info severity and costs no score (see [configuration](configuration.md#accepted-advisories)) |
| `security/stale-accepted-advisory` | A `security.acceptedAdvisories` entry that matches nothing in the current dependency audit; shown at info severity and costs no score |

Python reports containing `skip_reason` and malformed nested pip, Cargo, or NuGet
reports are incomplete: readable vulnerability findings remain visible next to the
audit-skipped warning, and unmatched advisory acceptances are not marked stale.
NuGet report problems also make the audit incomplete, including exit-zero warnings
about sources without vulnerability data. Omitted empty NuGet framework/package
collections are valid. Cargo discovery checks PATH and Cargo's home bin directory
without executing Cargo. If neither finds cargo-audit, it asks Cargo for its
subcommands only for enabled, in-scope dependency audits in a project with a Rust
manifest. Source-engine language selection does not restrict manifest-based audits.

The Cargo policy rule reports the warning set as an error only when exit 1 has no
vulnerability findings. JSON does not identify which warnings were denied, so the
rule does not guess individual denial status or reinterpret `.cargo/audit.toml`.
Exit-zero informational warnings do not trigger it. A report with vulnerabilities
already carries error findings; its warnings alone do not prove a policy denial.

## Architecture (opt-in)

Custom import and path rules defined in `.aislop/rules.yml`. Enable with `engines.architecture: true` in your config.

| Rule type | Example |
|---|---|
| `forbid_import` | Ban `axios` project-wide |
| `forbid_import_from_path` | Controllers cannot import database modules |
| `require_pattern` | Require error handling in API routes |

See [examples/architecture-rules.yml](../examples/architecture-rules.yml) for a sample rules file.

## Supported Languages

| Language | Format | Lint | Code quality | AI slop | Security |
|---|---|---|---|---|---|
| TypeScript | Biome | oxlint | knip, complexity | All rules | All rules |
| JavaScript | Biome | oxlint | knip, complexity | All rules | All rules |
| Expo / React Native | Biome | oxlint + expo-doctor | knip, complexity | All rules | All rules |
| Python | ruff | ruff | complexity | Imports, exceptions, comments, tautological tests (`assert True`, `assert 1`) | Secrets, audit |
| Go | gofmt | golangci-lint | complexity | Exceptions, comments | Secrets, audit |
| Rust | cargo fmt | clippy | complexity | Comments | Secrets, audit |
| Ruby | rubocop | rubocop | complexity | Exceptions, comments | Secrets |
| PHP | php-cs-fixer | -- | complexity | Comments | Secrets |
| C# | -- | jb inspectcode + Roslynator (optional, each independently togglable) | complexity | NotImplementedException, redundant XML-doc, async, exceptions, comments | Secrets |
| C/C++ | clang-format (requires `.clang-format`) | cppcheck + clang-tidy (clang-tidy requires `compile_commands.json`) | complexity | Not-implemented stubs, using-namespace-std in headers, C-style casts, manual delete, iostream leftovers | Secrets |
