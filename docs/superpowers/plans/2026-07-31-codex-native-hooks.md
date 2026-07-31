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

## Phase 1: Installer

### Task 1: Codex hook configuration and rules lifecycle

**Files:**
- Create: `tests/hooks/install-codex.test.ts`
- Modify: `src/hooks/install/codex.ts`
- Modify: `src/hooks/install/registry.ts`
- Modify: `src/hooks/io/sentinel.ts`
- Modify: `tests/hooks/install-rules-only.test.ts`

**Interfaces:**
- Produces: `resolveCodexPaths(opts): { hooks: string; rules: string }`.
- Produces: `removeMarkdownFence(existing: string): string | null` for preserving non-aislop Markdown.
- Keeps: `installCodex(opts)` and `uninstallCodex(opts)` registry contracts.

- [x] **Step 1: Write failing installer tests**

Create focused Vitest cases that assert the exact documented hook shape:

```ts
const hooks = JSON.parse(fs.readFileSync(resolveCodexPaths(opts).hooks, "utf-8"));
expect(hooks.hooks.PostToolUse).toEqual([
	{
		matcher: "Edit|Write",
		hooks: [{ type: "command", command: "aislop hook codex" }],
	},
]);
expect(hooks.hooks.Stop).toBeUndefined();
```

Cover global and project paths, unrelated PostToolUse and Stop preservation, repeat-install idempotency, dry run, `qualityGate: true`, reinstall without quality gate, uninstall, invalid existing JSON recovery, and a global `AGENTS.md` symlink whose target retains user text and loses only the aislop fence on uninstall.

- [x] **Step 2: Run the installer tests and verify failure**

Run: `pnpm vitest run tests/hooks/install-codex.test.ts`

Expected: FAIL because `resolveCodexPaths()` has no `hooks` path and no Codex hooks are written.

- [x] **Step 3: Add fenced-rule removal**

Add a sentinel helper with this contract:

```ts
export const removeMarkdownFence = (existing: string): string | null => {
	const begin = existing.match(BEGIN_RE);
	const end = existing.match(END_RE);
	if (!begin || !end || (end.index ?? 0) <= (begin.index ?? 0)) return existing;
	const before = existing.slice(0, begin.index);
	const after = existing.slice((end.index ?? 0) + end[0].length);
	const next = `${before}${after}`.replace(/\n{3,}/g, "\n\n").trim();
	return next.length === 0 ? null : `${next}\n`;
};
```

- [x] **Step 4: Implement Codex JSON merging and symlink-safe rules**

Build PostToolUse and Stop groups with only `matcher`, `hooks`, `type`, and `command`. Parse absent or malformed JSON as `{}`. For each managed event, remove groups containing the exact commands `aislop hook codex` or `aislop hook codex --stop`, retain all other groups, then append the desired group. When the rules path is a symlink, read and write its resolved target while reporting the configured path. Uninstall removes only managed groups and the fenced Markdown block, deleting a file only when nothing remains.

- [x] **Step 5: Register both Codex paths and run tests**

Change the registry path list to:

```ts
codex: (opts: HookInstallOpts): string[] => {
	const paths = resolveCodexPaths(opts);
	return [paths.hooks, paths.rules];
},
```

Run: `pnpm vitest run tests/hooks/install-codex.test.ts tests/hooks/install-rules-only.test.ts tests/hooks/registry.test.ts`

Expected: PASS.

- [x] **Step 6: Scan and commit Phase 1**

Run: `aislop scan src/hooks/install src/hooks/io tests/hooks`

Expected: score does not regress and no blocking finding remains.

Commit: `feat: install native Codex hook configuration`

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

- [ ] **Step 1: Write failing parser and guard tests**

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

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `pnpm vitest run tests/hooks/codex-adapter.test.ts`

Expected: FAIL because the Codex adapter module does not exist.

- [ ] **Step 3: Implement parsing and opt-in guard**

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

- [ ] **Step 4: Implement advisory and blocking callbacks**

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

- [ ] **Step 5: Extend feedback agent types and run tests**

Add `"codex"` to the internal feedback `AgentName` union, then run:

Run: `pnpm vitest run tests/hooks/codex-adapter.test.ts tests/hooks/adapters.test.ts tests/hooks/feedback.test.ts`

Expected: PASS.

- [ ] **Step 6: Scan and commit Phase 2**

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
