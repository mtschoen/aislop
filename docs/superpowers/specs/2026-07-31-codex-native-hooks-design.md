# Native Codex Hooks Design

## Goal

Make `aislop hook install --codex` install a native Codex runtime adapter instead of rules only, so user-global Codex sessions and PR-crew agents receive scoped aislop feedback automatically.

## Scope and activation

- Global installation writes `~/.codex/hooks.json` and remains the canonical installation for this fleet.
- Project installation writes `<project>/.codex/hooks.json` and remains supported for portable repository configuration.
- A globally registered runtime hook exits successfully without scanning unless the session working directory belongs to a project whose resolved root contains `.aislop/config.yml`.
- The guard applies to both `PostToolUse` and `Stop`, preventing noise and scan cost in projects that have not opted into aislop.
- Existing Codex rules installation remains in place. Global installation must preserve a symlinked `~/.codex/AGENTS.md` instead of replacing the symlink.

## Hook configuration

The installer merges managed groups into `hooks.json` without modifying `config.toml` or unrelated hook groups.

- `PostToolUse` uses matcher `Edit|Write`, which Codex treats as aliases for `apply_patch`.
- Its command is `aislop hook codex`.
- `Stop` is installed only when `--quality-gate` is supplied.
- Its command is `aislop hook codex --stop`.
- Reinstalling without `--quality-gate` removes only the aislop-managed `Stop` group.
- Uninstall removes only aislop-managed hook groups and fenced aislop rules.
- Repeated install and uninstall operations are idempotent.

Codex requires users to review changed non-managed hooks through `/hooks`. The installer will report the written hook path, and documentation will call out the one-time trust step.

## Runtime adapter

The Codex adapter reads the documented JSON payload from standard input.

For `PostToolUse`:

1. Resolve the session root from `cwd`.
2. Apply the `.aislop/config.yml` opt-in guard.
3. Parse affected paths from Codex `apply_patch` input, including add, update, delete, and move directives.
4. Reuse the existing scoped scan, baseline, session-file, feedback, and telemetry services.
5. Return `hookSpecificOutput.hookEventName = "PostToolUse"` with serialized `AislopFeedback` as `additionalContext`.
6. Remain advisory: do not block a completed edit.

For `Stop`:

1. Apply the same opt-in guard.
2. Ignore a repeated continuation when `stop_hook_active` is true.
3. Scan files touched during the session against the captured baseline.
4. Return no output when the score has not regressed.
5. Return `decision: "block"` with the regression reason when the score dropped, causing Codex to continue the turn and fix the findings.

Malformed input, missing configuration, scan-lock contention, and adapter failures fail open with exit code zero. They must not prevent Codex from editing or stopping.

## Code structure

- `src/hooks/install/codex.ts` owns path resolution, JSON merging, installation, and uninstall.
- `src/hooks/adapters/codex.ts` owns Codex payload parsing, affected-path extraction, output rendering, and adapter entry points.
- Shared scan services remain under the existing `src/hooks/io`, `src/hooks/quality-gate`, and `src/hooks/feedback` modules.
- `src/commands/hook.ts` routes the internal `codex` callback and labels Codex as a runtime adapter.
- Installer registry paths include both `AGENTS.md` and `hooks.json`.

No plugin packaging, Bash-command scanning, or new configuration format is included.

## Testing

Implementation follows test-first development.

- Installer tests cover global and project paths, exact hook shapes, preservation of unrelated hooks, idempotency, dry runs, quality-gate enable and disable, uninstall, and symlink preservation.
- Adapter tests cover valid and malformed payloads, add/update/delete/move path extraction, the configuration guard, advisory output, and Stop continuation output.
- Command tests cover Codex runtime routing and updated UI labels.
- The full repository typecheck, tests, formatting, lint, coverage, aislop scan, and a real temporary-home install/uninstall smoke test must pass.

## Documentation

Update the README, command reference, changelog, and fleet `AGENTS.md` guidance to describe global Codex installation, the `.aislop/config.yml` guard, optional quality gate, and `/hooks` trust review.

## Reference

The hook shape and runtime behavior follow the current OpenAI Codex hooks documentation: <https://developers.openai.com/codex/config-advanced#hooks>.
