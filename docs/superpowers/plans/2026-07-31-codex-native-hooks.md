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

- [x] **Step 1: Write failing command and rendering tests**

Assert that Codex is labeled `PostToolUse, runtime`, the quality-gate help no longer says Claude only, and callback registration accepts `--stop`.

- [x] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/hooks/hook-command.test.ts tests/commands/hook.render.test.ts`

Expected: FAIL on the rules-only label or missing Codex callback.

- [x] **Step 3: Add Codex routing and callback registration**

Import the two Codex runners, route `agent === "codex"` before the rules-only fallback, register the hidden command, and describe `--quality-gate` as supported by Claude and Codex.

- [x] **Step 4: Run tests, scan, and commit Phase 3**

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
