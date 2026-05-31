# Handoff: ruff lint findings never surface in `aislop scan` (Python)

**Status:** investigation PAUSED. Symptom is solid and reproducible. Root cause is
**NOT yet identified** — several plausible hypotheses were tested and *refuted*
this session (see "Hypotheses tried and REJECTED"). Do not trust a root cause
until you've instrumented the running binary.
**Branch in use:** `feat/csharp-support` (this `~/aislop` clone is **1 commit
ahead** of `fork/feat/csharp-support`; `e9fc89c` is unpushed and is NOT in the
installed binary — see Provenance).
**Reported by:** projdash session, 2026-05-31, while checking whether projdash's
`aislop` + `ruff` post-edit hooks are redundant.

> Honesty note for next-me: an earlier draft of this file asserted a
> "discovery returns empty" root cause and a "works at ~247ms" baseline. **Both
> were wrong / unobserved** and have been removed. Re-derive from the confirmed
> facts below; don't inherit a conclusion.

---

## TL;DR (what is actually CONFIRMED)

`aislop scan <dir>` consistently reports **`Linting: 0 issues`** for Python while
standalone `ruff check` on the same file reports real errors. In **every** test
this session — tracked file, untracked file, repo root, nested subdir, with and
without projdash's custom config — aislop's **Linting engine produced zero ruff
diagnostics**. The AI-Slop engine *did* independently flag the same file
(`ai-slop/unused-import`), so the file is being discovered and read; it's the
**ruff lint pipeline specifically** that yields nothing.

Consequence for consumers: **do NOT assume `aislop` subsumes `ruff`.** Keep a
separate ruff gate. (This is why projdash keeps both a `ruff` PostToolUse hook and
the aislop hook — notably aislop never enforces projdash's `TID251` subprocess
ban, but neither does it surface plain `F401`.)

---

## Minimal reproduction

```bash
R=$(mktemp -d)/r && mkdir -p "$R" && cd "$R" && git init -q
printf 'import os\n' > bad.py && git add bad.py \
  && git -c user.email=t@t -c user.name=t commit -qm init

ruff check bad.py        # → F401 `os` imported but unused   (ruff sees it)
aislop scan "$R"         # → Linting: done (0 issues)
                         #   AI Slop:  done (1 warning)  ← same file, caught here
```

Also reproduces inside projdash with a file that violates the custom config:
`import os` + `subprocess.run(...)` → standalone ruff reports `F401` **and**
`TID251`; aislop Linting reports 0.

---

## Provenance (WHICH binary runs — read before editing anything)

- PATH `aislop` → `~/AppData/Local/pnpm/bin/aislop(.CMD)` → pnpm global store
  `~/AppData/Local/pnpm/global/v11/be64-19e7cc31380/node_modules/aislop/dist/cli.js`,
  **v0.9.4**.
- Installed via `pnpm add -g "github:mtschoen/aislop#feat/csharp-support"` — a
  **built snapshot from GitHub**, NOT a live link to this `~/aislop` clone, NOT
  the npm release (`scanaislop/aislop`).
- **Editing `~/aislop` changes nothing at runtime** until you either push the
  branch and re-run the `pnpm add -g …#feat/csharp-support` line, OR (better for
  iterating) `cd ~/aislop && pnpm build && pnpm link --global` so PATH `aislop`
  runs your local `dist/`.
- `~/aislop` clone: branch `feat/csharp-support`, HEAD `e9fc89c`, clean,
  **1 commit ahead of the pushed fork branch** → the installed 0.9.4 is one commit
  behind. Reconcile this first.
- ruff: **system** ruff `0.15.15`
  (`…/Python313/Scripts/ruff`). No bundled ruff (`tools/bin/` holds only C#
  analyzer DLLs). `aislop doctor` (run inside projdash) reports
  `Linting  ruff (system)` and `0 missing` — i.e. aislop DOES detect ruff.

---

## Code path (verified by reading source in this clone)

- `src/engines/lint/index.ts:29` — gate:
  `if (languages.includes("python") && installedTools["ruff"]) runRuffLint(context)`.
- `src/engines/lint/ruff.ts:14` — `runRuffLint`: runs
  `ruff check --output-format=json <targets>` via `runSubprocess`, `cwd:
  rootDirectory`. **No `--isolated`, no `--select`** → it is *designed* to honor
  the project's `pyproject.toml` (so if it worked it WOULD catch TID251). Maps
  JSON → `Diagnostic` with `rule: "ruff/<code>"`.
- `src/engines/python-targets.ts:9` — `getPythonTargets` =
  `context.files ?? getSourceFiles(context)`, filtered to `.py/.pyi`, paths made
  **relative to rootDirectory**, dropping `..`-escaping paths.
- `src/utils/source-files.ts:189` — `listProjectFiles` =
  `git ls-files --cached --others --exclude-standard` (cwd root), then
  `filterProjectFiles` applies git-check-ignore + `EXCLUDED_DIRS` + `isTestFile`.
- `src/engines/lint/index.ts:49` — `Promise.allSettled`; only `fulfilled`
  results are pushed (a `rejected` lint promise would vanish silently — but
  `runRuffLint` has its own try/catch, so it resolves, not rejects).
- Three silent `return []` spots in `ruff.ts` (17 `targets.length===0`,
  26 `!output`, 44 `catch`) — any of these would yield "0 issues" with no
  "skipped" signal.

---

## Hypotheses tried and REJECTED this session (don't re-spend time here)

1. **"aislop bundles its own ruff / ignores project config."** Rejected. It runs
   system ruff with no rule overrides; designed to honor `pyproject.toml`.
2. **subprocess layer swallows ruff's non-zero exit.** Rejected. Reproduced the
   exact `spawn("ruff",["check","--output-format=json",…])` (and `ruff.exe`,
   no shell, `windowsHide`, piped stdio) at the node level →
   `{code:1, stdoutLen:733}`. JSON comes back fine; `runSubprocess` resolves
   regardless of exit code; `runRuffLint` reads `result.stdout`. Not it.
3. **Windows `which` vs `where` tool-detection fails → `installedTools.ruff`
   false → gate skipped.** Rejected. node `spawn("which",["ruff"])` returns
   `{code:0, stdout:<path>}` (git-bash provides `which`), and `aislop doctor`
   shows ruff detected. Gate should pass. (Still: cheap to *confirm* truthy on the
   scan path — see step 1 below.)
4. **File discovery returns no Python targets.** Rejected as a general cause:
   `git ls-files --cached --others --exclude-standard` returned `bad.py` in ALL
   cases (tracked, untracked, root, nested subdir). The file reaches discovery.
5. **Display timing (~32ms) proves ruff never spawned.** Invalid evidence.
   `lint/index.ts:59` hardcodes `elapsed: 0`; the per-engine ms in the scan
   output is not real per-engine timing. Discard any timing-based argument.
6. **General diagnostic dedupe drops ruff's `F401` in favor of aislop's
   `unused-import`.** Rejected. Only `dedupeCSharpAsync` exists
   (`engines/csharp-dedupe.ts`); no cross-engine Python dedupe. Both would show.

**Net:** ruff is detected, the file is discovered, and the spawn works in
isolation — yet `runRuffLint` contributes 0 diagnostics to the report. The defect
is somewhere between "engine actually invokes ruff with the right targets" and
"diagnostics land in the final report." Not yet pinned.

---

## Next steps (instrument the real binary — fastest path to truth)

1. `cd ~/aislop && pnpm build && pnpm link --global` so PATH `aislop` runs this
   clone. Verify with `aislop --version` + a deliberate `console.error` banner.
2. In `src/engines/lint/index.ts:29` add
   `console.error("[dbg] python?", languages.includes("python"), "ruff?", installedTools["ruff"])`.
   Rebuild, run the repro. Confirms the gate is entered.
3. In `src/engines/lint/ruff.ts:runRuffLint` add, right after line 16:
   `console.error("[dbg] targets", JSON.stringify(targets))` and after the
   subprocess `console.error("[dbg] rc", result.exitCode, "len", result.stdout.length, "parsed", (JSON.parse(result.stdout||"[]")).length)`.
   This splits the problem cleanly:
   - `targets === []`  → discovery/relative-path bug after all (re-open H4 with the
     exact context.files vs getSourceFiles branch — check whether `scan` sets
     `context.files`).
   - `targets` non-empty but `rc/len` show empty stdout → invocation/cwd/path bug
     (e.g. relative target not found from chosen cwd).
   - stdout has JSON but `parsed > 0` and report still 0 → the loss is downstream
     (orchestrator collection at `engines/orchestrator.ts`, scoring, or the
     output/report filter by severity/category). Trace `runRuffLint`'s return up
     through `lint/index.ts:49-54` → orchestrator → report.
4. Whatever the cause, also **make the silent paths loud**: when Python is present
   but ruff yields nothing, emit an informational note instead of a clean
   "0 issues" (mirrors aislop's own anti-silent-failure philosophy). And consider
   unifying lint-engine discovery with whatever the AI-Slop engine uses (AI-Slop
   found the file the lint pipeline effectively didn't surface).

## Determinism
No LLM involved. All commands reproduce on chonkers (Windows) against the 0.9.4
build in Provenance.
