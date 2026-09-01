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

When both tools run, findings are merged and de-duplicated by `(filePath, line, bare-rule-id)`, where the bare rule id is the part after the `jb/` or `dotnet/` namespace prefix (so a `jb/CS0219` and a `dotnet/CS0219` at the same site count as one). When jb and roslynator report an equivalent finding at the same location, the jb finding wins.

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
| `projectEvaluation` | `false` | Allow MSBuild-backed lint, format, and NuGet audit passes. These may evaluate repository-controlled project files; enable only for repositories you trust. |
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
| `complexity/function-too-long` | Functions exceeding configurable line limit (default: 80). For Python, measured by logical body code: the signature, docstrings, comments, and blank lines do not count. For C#, C++, and brace-delimited languages, declarations and prototypes (such as P/Invoke extern methods or header prototypes ending in `;`) have no body and are skipped rather than treated as functions. Braces inside strings, comments, and regexes are ignored. `async def`/`async Task` and multi-line wrapped signatures are detected. |
| `complexity/file-too-large` | Files exceeding configurable line limit (default: 400) |
| `complexity/deep-nesting` | Control-flow nesting beyond threshold (default: 5) |
| `complexity/too-many-params` | Functions with too many parameters (default: 6). For Python, counts required parameters only: `self`/`cls`, `*args`/`**kwargs`, the `*` / `/` separators, and parameters with a default are not counted. |
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
| `ai-slop/duplicate-import` | warning | Multiple imports from the same module that should be merged |
| `ai-slop/hardcoded-url` | warning | Environment-specific URLs hardcoded in production code instead of env/config; Python docstring content is exempt (see notes below the table) |
| `ai-slop/hardcoded-id` | warning | Provider/project IDs hardcoded in production code instead of env/config |
| `ai-slop/hardcoded-user-path` | warning | Configured or runtime home-directory paths hardcoded in source or tests instead of runtime APIs/config |
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
| `ai-slop/hallucinated-import` | error | Imports of JS/TS packages that are not declared in the project manifest |
| `ai-slop/tautological-test` | warning | JavaScript/TypeScript assertions comparing equal fixed literals, plus standalone Python `assert True` statements, which cannot fail |
| `ai-slop/test-sleep` | warning | A fixed-duration delay written directly inside a test file, outside any loop (see the bounds below the table) |
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

### Repeated magic literals (`ai-slop/repeated-magic-literal`)

**What is reported.** The same literal value, appearing under the same name more than `quality.repeatedLiteralThreshold` times in one file, is reported once. The comparison is exclusive: a threshold of 3 first reports at 4 occurrences. This is a counting rule: it does not examine what encloses a literal. A value assigned in a plain statement, passed as a call argument, sitting in an object literal, or repeated across the rows of a lookup table all count the same way. A collection whose rows all repeat one value is reported deliberately, because that is one default written N times, not N independent decisions.

**Supported structural sites.** In Python, the rule scans keyword arguments and plain assignments (`name = value`) at any nesting depth, over comment- and string-masked source, so occurrences inside comments or string literals are not counted.

In JavaScript and TypeScript, the rule scans object property assignments, parameter defaults, variable-declaration initializers, class property initializers, and plain assignment expressions (`target = value`), at any nesting depth. Whether the enclosing structure is a call argument, a returned object, a standalone variable, or a row of an array or object table makes no difference.

Supported JS/TS properties have static identifier, string, or numeric names. Supported values are finite numeric literals (including unary `+` and `-`) and non-empty string literals of at most 80 characters after parentheses and TypeScript assertion wrappers are removed. The numeric values -1, 0, 1, and 2 are treated as trivial and excluded.

**Differing values never group.** Grouping is by name and value together, so a property whose value differs across rows of a table never groups on that property. A named-constant reference (`timeout=_DEFAULT_TIMEOUT_SECONDS`) contributes nothing to any group: only literal occurrences are counted.

**Suppress above the reported line.** Where the repetition genuinely is data, or the values are meant to stay independently tunable, suppress it with a reason. The diagnostic is reported on the first occurrence in the group, so the directive goes above that line:

```ts
// aislop-ignore-next-line ai-slop/repeated-magic-literal -- per-state timeouts are independently tunable
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
(`tools/grammars/tree-sitter-c_sharp.wasm`) and asks a structural question of the tree. The
grammar is loaded once per process, the first time a C# test file is scanned; a project with no
C# tests never loads it. When the grammar is missing or cannot be loaded, a warning is emitted
to stderr (once per process) and the scan reports no C# findings rather than failing.


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
The decision surface is a closed list of banned home roots: the current process home directory
returned by `os.homedir()`, plus any roots listed under `aiSlop.hardcodedUserPath.bannedRoots` in
`.aislop/config.yml`. Given a banned root of `/home/alice`, both the exact root and its descendants
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

**Why `os.homedir()` alone is not enough.** In CI, `os.homedir()` is the runner's home directory,
not a developer's, so a committed `/home/alice/...` path never matches there. Configure
`bannedRoots` for any home directory that should be caught regardless of which machine runs the
scan:

```yaml
aiSlop:
  hardcodedUserPath:
    bannedRoots:
      - /home/alice
```

Each configured root must be absolute (a POSIX `/...` root, a Windows drive root, or a UNC root);
see [docs/configuration.md](configuration.md#hardcoded-user-path-roots) for the exact forms
accepted and what happens to a non-absolute entry.

**The runtime seed is skipped for placeholder and CI service accounts.** Seeding a banned root
from `os.homedir()` when that account is itself a placeholder (`runner`, `runneradmin`, `user`,
`username`, `default`, `defaultuser`, `example`, `public`, `shared`, `someone`, `me`, `your-name`,
`yourname`, or anything starting with `runner~`) would flag paths bound to the CI runner instead
of paths bound to a real person, so the seed is dropped in that case. A path under
`/home/runner/work/repo` is never reported unless `/home/runner` is explicitly configured.

**Why the boundary is narrow.** The rule does not infer whether an arbitrary `/home/<name>` string
is a filesystem path, web route, placeholder, or another account. That semantic question has no
sound syntactic answer across every language aislop scans. Restricting the match to the closed list
of banned roots makes the question finite and avoids growing an exclusion list to guess at routes.

**Known non-detections.** A home path bound to an account that is neither the runtime seed nor
configured in `bannedRoots` is not reported. For example, `/home/bob/project` is deliberately
ignored when aislop runs with `/home/alice` as its only banned root. Configure `bannedRoots` for
every account whose paths should be caught in CI. Relative paths and home-like suffixes inside
another absolute path are also outside the rule:

```text
home/alice/project
/srv/site/home/alice/project
```

HTTP and HTTPS URLs are consumed as opaque URL tokens before home paths are considered, so their
route segments are not reported. A local `file:` URL remains machine-bound and is reported. The
rule never attempts to distinguish a filesystem path from a web route by its shape; a route that
happens to share a banned root's literal text (for example `/home/alice/summary` as a URL path
when `/home/alice` is banned) is reported the same as a filesystem path would be, because the rule
has no sound way to tell them apart.

**Suppress intentional matches at the site.** Use `aislop` suppression comments with a realistic reason:

```ts
// aislop-ignore-next-line ai-slop/hardcoded-user-path -- historical path retained in migration fixture
const historicalPath = "C:\\Users\\alice\\project";
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
except-block is exempt when a log line calls `logger.exception(...)` or passes
`exc_info=True`, since both attach the currently-handled exception's traceback
even though no bound exception name appears in the call. The exemption is
cancelled when that same line spells the literal `exc_info=False`, which
Python forwards to `Logger.error`, omitting the traceback. Any other
`exc_info` value (a variable, an expression) stays exempt rather than guessed
at, since deciding its value would mean evaluating Python.

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
| `security/dependency-audit-skipped` | Dependency audit could not run because tooling or lockfile context was missing |

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
| Python | ruff | ruff | complexity | Imports, exceptions, comments, tautological tests (`assert True`) | Secrets, audit |
| Go | gofmt | golangci-lint | complexity | Exceptions, comments | Secrets, audit |
| Rust | cargo fmt | clippy | complexity | Comments | Secrets, audit |
| Ruby | rubocop | rubocop | complexity | Exceptions, comments | Secrets |
| PHP | php-cs-fixer | -- | complexity | Comments | Secrets |
| C# | -- | jb inspectcode + Roslynator (optional, each independently togglable) | complexity | NotImplementedException, redundant XML-doc, async, exceptions, comments | Secrets |
| C/C++ | clang-format (requires `.clang-format`) | cppcheck + clang-tidy (clang-tidy requires `compile_commands.json`) | complexity | Not-implemented stubs, using-namespace-std in headers, C-style casts, manual delete, iostream leftovers | Secrets |
