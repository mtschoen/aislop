# Configuration

Run `aislop init` to generate `.aislop/config.yml` with default values.

## Default config

```yaml
version: 1

engines:
  format: true
  lint: true
  code-quality: true
  ai-slop: true
  architecture: false    # opt-in, needs rules.yml
  security: true

quality:
  maxFunctionLoc: 80
  maxFileLoc: 400
  maxNesting: 5
  maxParams: 6
  repeatedLiteralThreshold: 3
  maxTrackedFileBytes: 524288

security:
  audit: true
  auditTimeout: 25000
  resolvePythonRequirements: false
  acceptedAdvisories: [] # reviewed dependency advisories (see Accepted advisories)

aiSlop:
  hardcodedUserPath:
    bannedRoots: []
    allowedPlaceholders: []
  testSpawnTimeout:
    wrapperNames: [run_captured, run_command, _run]
    helperPaths: []

scoring:
  weights:
    format: 0.3
    lint: 0.6
    code-quality: 0.8
    ai-slop: 1.0
    architecture: 1.0
    security: 1.5
  thresholds:
    good: 75
    ok: 50
  smoothing: 20
  maxPerRule: 40

ci:
  failBelow: 70          # fail CI below this score
  format: json
  # baseline: .aislop/ci-baseline.json   # fail only on findings not in this file (see docs/ci.md)

telemetry:
  enabled: true          # set to false to opt out
```

When a field has an invalid value, aislop reports its path and value, drops only that field, and
keeps the rest of the configuration in effect. Invalid YAML and non-mapping document roots cannot
be recovered field by field, so they use the full default configuration.

## Excluded paths

`exclude` entries and `.aislopignore` patterns are relative to the scan root. Build-backed
analyzers such as jb may inspect whole solutions, so their returned findings are filtered
again before scoring. Diagnostic paths are normalized to root-relative forward-slash paths,
including lexical `.` and `..` segments, before glob matching. For example,
`exclude: [external/MFTLib/**]` also matches `./external/MFTLib/File.cs` and
`App/../external/MFTLib/File.cs`. This does not resolve filesystem symlinks.

When the diagnostic filter removes findings, stderr reports the suppressed count per
engine. JSON and SARIF stdout remain machine-readable and contain only retained findings.

## Ordered per-file overrides

Use one `.aislop/config.yml` and one scan for different file policies:

```yaml
version: 1
quality:
  maxFileLoc: 400
rules:
  complexity/file-too-large: warning
overrides:
  - files: ["**/*.controller.ts"]
    quality:
      maxFileLoc: 700
  - files: ["**/*.generated.ts", "src/legacy/**"]
    rules:
      complexity/file-too-large: off
      ai-slop/trivial-comment: off
  - files: ["src/legacy/critical.service.ts"]
    rules:
      complexity/file-too-large: error
```

Overrides use ordered glob matching, similar to Biome's overrides. Patterns are
relative to the scanned project directory, not the `.aislop` directory. Write
patterns with `/` on every OS; Windows file paths are normalized before matching.
`**` crosses directories, and dot directories are included. Each entry requires a
non-empty `files` list. Multiple positive patterns select a union; negative patterns
such as `!**/*.service.ts` exclude matches from that entry.

Each matching entry merges only the fields it supplies. Later entries win for the
same field or rule, including re-enabling a rule previously set to `off`. Unmatched
files retain the top-level policy. Supported fields are `quality.maxFileLoc`,
`maxFunctionLoc`, `maxNesting`, `maxParams`, and `rules` with `error`, `warning`, or
`off`. Quality values must be positive. Other settings remain project-wide.

Quality overrides feed the existing complexity checks: language multipliers,
exemptions, and the existing line-count tolerance still apply. Rule severity is
resolved before scoring and reporting; `off` suppresses that rule's diagnostic,
not the entire file or an external formatter. Overrides do not grant an exclusion
from mutating fix tools; use `exclude` when generated files must never be rewritten.
The policy is also used by hook/MCP scans and post-fix verification. No LLM or
network resolver is involved in matching. Without overrides, behavior is unchanged.

When using `extends`, an explicitly supplied child `overrides` array replaces the
parent's array, like other arrays; if omitted, the parent's array is inherited.

## Engines

Each engine can be enabled or disabled individually:

```yaml
engines:
  format: true        # formatting checks
  lint: true          # linting checks
  code-quality: true  # complexity, dead code, unused deps
  ai-slop: true       # AI pattern detection
  architecture: false  # custom import/path rules (requires rules.yml)
  security: true       # secrets, risky constructs, dependency audits
```

## Quality thresholds

Control what triggers code quality warnings:

| Setting | Default | Description |
|---|---|---|
| `maxFunctionLoc` | 80 | Max lines per function |
| `maxFileLoc` | 400 | Max lines per file |
| `maxNesting` | 5 | Max control-flow nesting depth |
| `maxParams` | 6 | Max function parameters |
| `repeatedLiteralThreshold` | 3 | Permitted occurrences of one named literal in one file; values are reported only when this threshold is exceeded (for example, 3 reports 4 or more occurrences) |
| `maxTrackedFileBytes` | 524288 | Largest tracked text file, in bytes (binary files are never considered), before `ai-slop/committed-large-file` reports it (512 KiB); lockfiles are spared and tool-output names are reported by `ai-slop/committed-tool-output` instead |

## Accepted advisories

The dependency audit reports one `security/vulnerable-dependency` finding per
vulnerable package. When an advisory has been reviewed and cannot be fixed (no
patched release exists, or the vulnerable code is unreachable), list it under
`security.acceptedAdvisories` instead of switching the audit off or excluding the
manifest:

```yaml
security:
  acceptedAdvisories:
    - id: GHSA-xxxx-xxxx-xxxx
      reason: dev-only through the stylesheet linter; no untrusted input reaches it
      package: example-package   # optional
      expires: 2027-01-31        # optional
```

| Field | Required | Description |
|---|---|---|
| `id` | yes | The advisory identifier as the audit reports it. Matching ignores case and also checks the aliases the audit source provides |
| `reason` | yes | Why the advisory is acceptable. It is repeated in the scan output |
| `package` | no | Apply the entry only to findings for this package |
| `expires` | no | Last day (`YYYY-MM-DD`) the entry applies. From the next day the finding fails again and its help says the acceptance expired |

How it behaves:

- A package finding is accepted only when **every** advisory behind it has an
  entry. It is then reported as `security/accepted-advisory` at info severity with
  the reasons in its help text. It stays in the terminal and JSON output, and it
  costs no score and does not fail the run.
- A package with one accepted and one unaccepted advisory keeps failing as
  `security/vulnerable-dependency`, and its help text names the advisory that is
  not accepted.
- The help text of every vulnerable-dependency finding lists the advisory ids
  behind it, so the id to put in the list can be read from a scan.
- An entry applies only as written. One without a non-empty `id` and `reason`,
  with a `package` that is not non-empty text, with an `expires` that is not a
  `YYYY-MM-DD` calendar date, or with an unknown field is reported
  on stderr as an invalid configuration field and the whole entry is dropped; the
  finding it was meant to cover keeps failing.
- An entry that matches nothing is reported as `security/stale-accepted-advisory`
  (info severity, no score cost) so it gets removed. This is only reported when
  every audit source that ran completed; a tool that failed, was offline, or
  printed something other than its report proves nothing.

Which identifier each audit source provides:

| Audit source | Identifier | Aliases |
|---|---|---|
| `npm audit`, `bun audit` | GHSA id, taken from the advisory url | none (no CVE id is reported) |
| `pnpm audit` | GHSA id (`github_advisory_id`, or the advisory url) | CVE ids when the pnpm release reports `cves` |
| `dotnet list <project.csproj> package --no-restore --vulnerable --include-transitive --format json` | GHSA id, taken from the advisory url | none |
| `pip-audit` | the vulnerability id (`PYSEC-...` or `GHSA-...`) | the reported aliases (CVE, GHSA) |
| `cargo audit` | `RUSTSEC-...` | the reported aliases (CVE, GHSA) |
| `govulncheck` | the Go vulnerability id (`GO-YYYY-NNNN`) | the aliases of the OSV message (CVE, GHSA) |

The NuGet audit runs per `.csproj` in scan scope, honoring include and exclude
patterns. A solution member the dotnet CLI cannot evaluate (such as a `.vcxproj`)
does not fail the whole audit. A `.csproj` whose assets are not restored is
reported as `security/dependency-audit-skipped` by its project path; findings
from the other projects are still kept.

An advisory the audit source reports without any identifier is listed as
`unidentified` and can never be accepted. Go (`govulncheck`) reports only
advisories whose vulnerable symbol your code calls, one finding per vulnerable
module, so a `package` on an entry names the Go module (for example
`github.com/golang-jwt/jwt/v4`) and accepting one module never covers another.

With `ci.baseline` set, accepted and stale advisory findings are not counted as
new findings and do not change the exit code.

## Resolving Python requirements (CI only)

By default, `pip-audit` audits `requirements.txt` only when every requirement is
an exact `name==version` pin, using `--disable-pip --no-deps`. Loose requirements
produce a `security/dependency-audit-skipped` warning, not a clean audit.

Set `security.resolvePythonRequirements: true` to allow resolving loose files
**only under `aislop ci`**. This runs `pip-audit --format=json -r requirements.txt`
using pip's resolver, including extras, markers, constraints, `--find-links`,
editable requirements and nested requirements files. The resolver can execute
build code from the repository and the package index. Enable it only for trusted
inputs in an appropriately isolated CI environment. Resolved versions depend on
the index at run time, so results can change without the repository changing.

`scan`, hooks and `fix` do not enable resolution, even with the flag set. Fully
pinned files keep the fast pip-disabled mode. `security.auditTimeout` still
applies (default 25000 milliseconds); timeouts and skipped dependencies remain
incomplete audits, with any readable vulnerability findings preserved.

## Hardcoded user path roots

`ai-slop/hardcoded-user-path` flags hardcoded home-directory paths (see
[docs/rules.md](rules.md#hardcoded-user-paths-ai-slophardcoded-user-path)). It always flags the
standard home shapes `/home/<name>/`, `/Users/<name>/` and `<drive>:\Users\<name>\` (and their
`file:` forms) for any user name other than the placeholders listed in docs/rules.md (`example` is the one to use
in fixtures and docs, e.g. `/home/example/project`). Two keys adjust that:

- `bannedRoots` adds home roots of a non-standard shape, for example `/mnt/data/<name>`.
- `allowedPlaceholders` lists user-name segments (beyond the built-in placeholders) that are not flagged under the standard
  shapes. Entries are plain segments (no `/` or `\`), matched case-insensitively.

```yaml
aiSlop:
  hardcodedUserPath:
    bannedRoots:
      - /mnt/data/team
    allowedPlaceholders:
      - fixture-user
```

Each `bannedRoots` entry must be an absolute path: a POSIX root starting with `/`, a Windows drive root
(`C:\...` or `C:/...`), or a UNC root (`\\server\share...`). A relative or bare entry (`alice`,
`home/alice`) is rejected rather than silently matched, because it would build a matcher with no
path-boundary requirement and flag ordinary identifiers instead of hardcoded paths. Each rejected
entry is dropped and reported by path and value; valid entries and all other valid configuration
fields remain in effect. An `allowedPlaceholders` entry containing `/` or `\` is rejected the same
way.

File length counts every physical line, including blank and comment lines. `.tsx`, `.jsx`, and `.go` files get 1.5x `maxFileLoc`, Rust and C/C++ files 2.5x, and `.d.ts` and data-only files are skipped. Function length runs from the signature to the closing brace, minus lines inside multi-line template literals. Python counts only the logical body code (no signature, docstrings, comments, or blank lines). React components get 2x `maxFunctionLoc`, and Rust functions 1.5x.

Both size rules allow 10% over the limit before reporting, so with the defaults a file is flagged above 440 lines and a function above 88. The finding message shows both numbers, for example `File too large (limit: 400, flagged above 440 lines)`.

## Test spawn timeout wrappers

`ai-slop/test-spawn-timeout-literal` flags a numeric literal `timeout` on a real subprocess in a
Python or JavaScript/TypeScript test (see [docs/rules.md](rules.md)). Two settings tune it:

```yaml
aiSlop:
  testSpawnTimeout:
    wrapperNames: [run_captured, run_command, _run, run_tool]
    helperPaths:
      - tests/helpers/
```

`wrapperNames` lists Python callables treated as process spawns and replaces the default list.
`helperPaths` lists path substrings; test files whose relative path contains one are skipped.

## Runtime-provided imports

`ai-slop/hallucinated-import` reports imports that no manifest declares. Python dependencies come from `pyproject.toml`, `Pipfile`, `requirements*.txt` files (including `-r` includes and a `requirements/` directory), and PEP 723 inline script metadata.

Inline metadata must be actual Python comments, not examples inside strings. A file referenced by both `-r` and `-c` contributes dependencies through its explicit requirements edge; a constraint-only file does not.

Some modules come from the runtime instead of a manifest, for example `homeassistant` in a Home Assistant integration, Sage's bundled packages, or `vscode` in a VS Code extension. List them under `imports.provided` so they are not reported:

```yaml
imports:
  provided:
    - homeassistant
    - fpylll
```

Each entry covers the module and its submodules (`homeassistant.core`, `vscode/...`).

## Engine weights

Control how much each engine contributes to the final score:

```yaml
scoring:
  weights:
    format: 0.3       # formatting issues have lighter impact
    lint: 0.6
    code-quality: 0.8
    ai-slop: 1.0      # AI-slop signals stay visible without dominating warnings
    architecture: 1.0
    security: 1.5
  smoothing: 20        # increase to reduce penalty spikes on larger repos
  maxPerRule: 40       # cap one rule family so repeated noise cannot dominate
```

## Extending a shared config

`extends:` lets a project inherit a parent config and override only the keys it cares about. Useful for org-wide baselines.

```yaml
# packages/payments/.aislop/config.yml
extends: ../../.aislop/base.yml

ci:
  failBelow: 80         # override one key, inherit everything else from the parent
```

Multiple parents are supported via an array; later entries win on conflict:

```yaml
extends:
  - ../../.aislop/base.yml
  - ./local-overrides.yml
```

**Resolution rules**

- Paths are relative to the config file declaring `extends:`. Absolute paths are rejected, and resolved targets must stay inside the project root to avoid reading local files outside the repository. Package or URL forms are not yet supported and will fail with a clear error. Extends targets must be regular files no larger than 1 MiB.
- Nested objects (`engines`, `scoring.weights`, `quality`) are deep-merged key-by-key. The child's keys win on conflict.
- Arrays (e.g. `exclude:`) are replaced wholesale, not concatenated. Append in the child if you want to extend rather than overwrite.
- Cycles and chains deeper than 5 levels are rejected at load time, not silently ignored.

## Architecture rules

Create `.aislop/rules.yml` to define custom import and path rules. Enable the architecture engine in your config:

```yaml
engines:
  architecture: true
```

See [examples/architecture-rules.yml](../examples/architecture-rules.yml) for a sample rules file.

## Example configs

See the [examples/](../examples/) directory for pre-built configs:

- [`typescript-strict.yml`](../examples/typescript-strict.yml): tight thresholds for zero-slop teams
- [`monorepo-relaxed.yml`](../examples/monorepo-relaxed.yml): loose thresholds for incremental adoption
- [`python-go.yml`](../examples/python-go.yml): backend-focused with higher security weight
## Strict C# project evaluation

Setting `lint.csharp.projectEvaluation: true` forces `ci.failOnMissingTools: true`, even if `ci.failOnMissingTools` is explicitly `false`. Enabled C# analyzers missing from PATH or lacking solution or restored project targets fail CI. Missing restore evidence (`project.assets.json`) also fails CI for an individual project or an unrestored member of an otherwise restored solution. Run `dotnet restore` before scanning. Explicitly disabled analyzers stay disabled. With project evaluation off, `failOnMissingTools` defaults to `false` and optional-tool behavior is unchanged.
