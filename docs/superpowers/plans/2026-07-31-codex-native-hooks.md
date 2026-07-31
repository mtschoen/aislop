# Native Codex Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `aislop hook install --codex` install guarded native Codex hooks globally or per project while preserving existing hooks and Codex instruction files.

**Architecture:** The Codex installer owns `hooks.json` merging and fenced `AGENTS.md` rules, identifying managed hook groups by their exact aislop commands so the emitted Codex JSON contains only documented fields. A dedicated adapter parses Codex `apply_patch` payloads, exits unless `.aislop/config.yml` opts the project in, reuses the existing scan and baseline services, and emits documented PostToolUse or Stop responses.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Commander, Vitest, existing aislop hook scan and baseline modules.

## Global Constraints

- Global hooks write `$HOME/.codex/hooks.json`; project hooks write `<project>/.codex/hooks.json`.
- Both callbacks fail open and no-op unless an ancestor project has `.aislop/config.yml`.
- Preserve unrelated hook groups and a symlinked `$HOME/.codex/AGENTS.md`.
- Do not emit undocumented sentinel properties into Codex hook configuration.
- `PostToolUse` is advisory; only the optional Stop quality gate can block.

---

## Phase 2: Runtime adapter

### Task 2: Guarded PostToolUse and Stop callbacks

**Files:**
- Create: `src/hooks/adapters/codex.ts`
- Create: `tests/hooks/codex-adapter.test.ts`
- Modify: `src/hooks/feedback.ts`

**Interfaces:**
- Produces: `parseCodexStdin(raw: string): CodexHookStdin`.
- Produces: `extractCodexPatchFiles(command: string): string[]`.
- Produces: `runCodexHook(deps?): Promise<number>` and `runCodexStopHook(deps?): Promise<number>`.

- [x] **Step 1: Write failing parser and guard tests**

Use an `apply_patch` command containing add, update, delete, and move headers:

```ts
const files = extractCodexPatchFiles(`*** Begin Patch
*** Add File: src/new.ts
*** Update File: src/old.ts
*** Move to: src/moved.ts
*** Delete File: src/gone.ts
*** End Patch`);
expect(files).toEqual(["src/new.ts", "src/old.ts", "src/moved.ts", "src/gone.ts"]);
```

Also cover malformed JSON, duplicate paths, absolute `cwd`, no `.aislop/config.yml`, config present in an ancestor, advisory PostToolUse output, `stop_hook_active`, no baseline, non-regression cleanup, regression blocking, scan-lock contention, and thrown scan failures.

- [x] **Step 2: Run adapter tests and verify failure**

Run: `pnpm vitest run tests/hooks/codex-adapter.test.ts`

Expected: FAIL because the Codex adapter module does not exist.

- [x] **Step 3: Implement parsing and opt-in guard**

Define the documented input subset:

```ts
interface CodexHookStdin {
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: { command?: string };
	cwd?: string;
	session_id?: string;
	stop_hook_active?: boolean;
}
```

Resolve `cwd`, use `findConfigDir(cwd)`, and require an actual `config.yml` file inside that directory before scanning. Extract paths only for `tool_name === "apply_patch"`; match `*** Add File:`, `*** Update File:`, `*** Delete File:`, and `*** Move to:` lines.

- [x] **Step 4: Implement advisory and blocking callbacks**

Reuse `resolveHookFiles`, `runScopedScan`, `acquireHookLock`, baseline/session-file helpers, `buildFeedback`, and telemetry. PostToolUse writes:

```ts
{
	hookSpecificOutput: {
		hookEventName: "PostToolUse",
		additionalContext: JSON.stringify(feedback),
	},
}
```

Stop returns no output unless the baseline regressed, then writes:

```ts
{
	decision: "block",
	reason: `aislop: score dropped from ${baseline.score} to ${score}. Fix the findings before finishing.`,
}
```

Every malformed-input, guard, lock, and exception path returns zero without output.

- [x] **Step 5: Extend feedback agent types and run tests**

Add `"codex"` to the internal feedback `AgentName` union, then run:

Run: `pnpm vitest run tests/hooks/codex-adapter.test.ts tests/hooks/adapters.test.ts tests/hooks/feedback.test.ts`

Expected: PASS.

- [x] **Step 6: Scan and commit Phase 2**

Run: `aislop scan src/hooks/adapters src/hooks/feedback.ts tests/hooks`

Expected: score does not regress and no blocking finding remains.

Commit: `feat: add guarded Codex hook runtime adapter`

## Phase 3: CLI and documentation

### Task 3: Route Codex callbacks through the CLI

**Files:**
- Modify: `src/commands/hook.ts`
- Modify: `src/cli/hook-command.ts`
- Modify: `tests/hooks/hook-command.test.ts`
- Modify: `tests/commands/hook.render.test.ts`

**Interfaces:**
- Consumes: `runCodexHook()` and `runCodexStopHook()` from Task 2.
- Produces: hidden `aislop hook codex [--stop]` callback command.

- [ ] **Step 1: Write failing command and rendering tests**

Assert that Codex is labeled `PostToolUse, runtime`, the quality-gate help no longer says Claude only, and callback registration accepts `--stop`.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/hooks/hook-command.test.ts tests/commands/hook.render.test.ts`

Expected: FAIL on the rules-only label or missing Codex callback.

- [ ] **Step 3: Add Codex routing and callback registration**

Import the two Codex runners, route `agent === "codex"` before the rules-only fallback, register the hidden command, and describe `--quality-gate` as supported by Claude and Codex.

- [ ] **Step 4: Run tests, scan, and commit Phase 3**

Run: `pnpm vitest run tests/hooks/hook-command.test.ts tests/commands/hook.render.test.ts`

Run: `aislop scan src/commands/hook.ts src/cli/hook-command.ts tests/hooks/hook-command.test.ts tests/commands/hook.render.test.ts`

Expected: tests pass and no blocking finding remains.

Commit: `feat: route Codex hook callbacks`

### Task 4: Document and install the fleet integration

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `/home/schoen/AGENTS.md`
- Modify through installer: `/home/schoen/.codex/hooks.json`
- Preserve: `/home/schoen/.codex/AGENTS.md` symlink

- [ ] **Step 1: Update durable documentation**

Document Codex as a runtime adapter, global and project hook paths, the `.aislop/config.yml` opt-in guard, `--quality-gate`, and the one-time `/hooks` review. Replace the fleet rule that forbids every global aislop hook with a scoped rule: Claude remains per-project; guarded Codex installation is global so PR-crew agents inherit it.

- [ ] **Step 2: Run the docs-update check**

Review README, CLI help, changelog, `AGENTS.md`, and nearby inline documentation for stale rules-only or Claude-only statements. Correct every affected statement.

- [ ] **Step 3: Run full verification**

Run: `pnpm typecheck`

Run: `pnpm test`

Run: `pnpm exec biome check .`

Run: `aislop ci .`

Expected: every command exits zero, tests pass, and aislop reports no blocking regression.

- [ ] **Step 4: Run a temporary-home smoke test**

Build the CLI, install Codex hooks into a temporary home, verify exact JSON and symlink behavior, run an opted-in PostToolUse fixture, then uninstall and verify unrelated content remains.

- [ ] **Step 5: Install systemwide and verify**

Use the verified fork build to run `aislop hook install --codex --global`, confirm `/home/schoen/.codex/hooks.json` contains the managed PostToolUse group, confirm `/home/schoen/.codex/AGENTS.md` is still a symlink to `/home/schoen/AGENTS.md`, and run `/hooks` in the next interactive Codex session to accept the changed non-managed hooks.

- [ ] **Step 6: Commit documentation and fleet configuration**

Commit repository documentation with: `docs: document guarded Codex hooks`

Do not commit user-home configuration into the aislop repository.
