# Agent development details

Agents must read this entire document before designing, changing, or reviewing a
detector, or changing architecture/navigating the engine layout. These are
required instructions supplementing [AGENTS.md](../AGENTS.md).

## Runtime requirements

Node `^22.18 || >=24.11` is the runtime/build/test floor: tsdown relies on
modern APIs including `Promise.withResolvers`, and vitest requires 22.18+.
The compiler uses TypeScript strict mode, ES2022, and bundler module resolution.

## Project structure

```text
src/
  cli.ts                    # CLI entry (commander.js)
  index.ts                  # Public API exports
  version.ts                # APP_VERSION constant
  commands/                 # CLI subcommands
    scan.ts, fix.ts, ci.ts, init.ts, doctor.ts, rules.ts, interactive.ts
  config/
    schema.ts               # Zod v4 schema
    defaults.ts             # Default values and YAML templates
    index.ts                # File discovery and loading
  engines/                  # Detection engines run in parallel
    types.ts                # Diagnostic, Engine, EngineContext types
    orchestrator.ts         # Parallel engine runner
    format/                 # biome, ruff, gofmt, cargo fmt, rubocop, php-cs-fixer
    lint/                   # oxlint, ruff, golangci-lint, clippy, rubocop
    code-quality/           # Complexity, duplication, dead code (knip)
    ai-slop/                # AI pattern detection
    architecture/           # Custom import/path rules
    security/               # Secrets, eval, innerHTML, SQL/shell injection, audits
  scoring/                  # Density-aware score calculation (0-100)
  output/                   # Terminal rendering and JSON output
  utils/                    # Discovery, git, subprocess, tooling, telemetry
tests/                      # Vitest tests
scripts/                    # Tool downloads (ruff, golangci-lint), deployment
.aislop/                    # aislop's own configuration
```

The bundler also has MCP and framework-adapter entry points; consult
[`tsdown.config.ts`](../tsdown.config.ts) rather than assuming CLI/API are its
only entries. Tool downloads are exposed through `aislop-tools`; installation
does not run dependency lifecycle scripts (see [Installation](installation.md)).

## Self-detection avoidance example

aislop scans itself. Detector source code must NOT contain the literal patterns
being detected. Use string concatenation to break patterns:

```typescript
// WRONG. aislop will flag its own source
const pattern = /as any/;

// CORRECT. Breaks the literal so it won't self-match
const pattern = new RegExp(`${"a" + "s"}\\s+${"an" + "y"}`);
```

This applies to regex patterns, string literals, and diagnostic messages in all
detector files under `src/engines/ai-slop/`. The example demonstrates splitting
a fixed pattern, not permission to build a regex mini-parser.

## State a closed decision surface

Before writing a detector, write down the question it answers and check that the
question has a finite, enumerable answer. A rule that decides **semantics from
syntax over an open-ended input space cannot be finished by iteration**: a
reviewer probing it adversarially will always find two more real
misclassifications, each fix will be correct, and the defect count will not
converge. Several detectors exhausted repeated review rounds this way until the
guessing subsystems were deleted rather than refined.

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

- **A detector is a fixed spelling or a query over a real parser's tree.** Either
  it matches one fixed spelling (a single literal token or one-line pattern with
  nothing to parse, e.g. `assert True`), or it queries the tree of a real parser:
  the TypeScript compiler API for JS/TS, tree-sitter for languages with a bundled
  grammar (today only C#, see `src/utils/csharp-parser.ts`), Roslyn, or the
  language's own compiler. Regex-driven mini-parsers over source text are not
  allowed: hand-rolled bracket matching, top-level argument splitting, alias or
  binding tracking, "is there an issue link on a nearby line". Blanking strings
  and comments first does not make text matching structural.
- **Python detectors are limited to fixed spellings until a Python grammar is
  bundled.** A Python detector that needs more than a fixed spelling waits for
  the grammar; it is not built from text meanwhile. Unrecognized aliases and
  bindings are documented non-detections, as in `python-patterns.ts`. The
  existing Python text detectors are grandfathered.
- **Anything beyond a fixed spelling in JS/TS MUST use the TypeScript AST**
  (and in C#, the tree-sitter tree), because structural queries (is this node a
  property assignment?) have definite answers. Inferring meaning from
  surrounding syntax does not become sound just because an AST is available.
- **Scope freeze for detector PRs.** The PR that adds a detector states its
  detections and its deliberate non-detections. For that PR, inputs outside the
  stated scope are follow-ups, not blockers; misfires on claimed inputs and false
  positives on ordinary valid code still block.
- **Under-reporting is acceptable; misfiring on valid code is not.** A rule that
  fires on ordinary application code gets the whole engine switched off, which
  costs more than every finding it would ever produce.
- **Record the bounds in [the rules reference](rules.md) when the rule lands**,
  not after someone rediscovers them. State what is deliberately not detected
  and why. A documented non-detection is a design decision; an undocumented one
  reads as a bug, and a doc that claims more coverage than the code delivers
  turns a correct diagnostic into an apparent misfire.
- **Let the author express intent, not the detector guess it.** The inline
  suppression `// aislop-ignore-next-line <rule> -- reason` exists for the case
  the rule cannot decide. Reach for it instead of growing an exclusion list,
  because a growing exclusion list is the open surface coming back.

## Why determinism outranks coverage

A linter that scores the same tree 99 on a developer's laptop and 100 on the CI
runner cannot gate anything: either the local hook nags about something the gate
will never enforce, or the gate passes something the developer was told to fix.
A detector that can only catch a problem by reading the environment does not ship
in that form. Follow the complete decision-input and external-tool reporting
contract in [AGENTS.md](../AGENTS.md#detector-design-deterministic-results-and-scan-scope).
