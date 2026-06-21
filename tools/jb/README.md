# tools/jb

This directory holds aislop's bundled ReSharper/JetBrains settings for the
`jb inspectcode` pass. The settings file is passed via `--settings` when
`resolveBundledJbSettings()` finds it, allowing aislop to layer controlled
suppressions and patterns on top of the jb defaults.

## aislop.DotSettings

Currently ships one entry:

- **InconsistentNaming suppression** (`DO_NOT_SHOW`): The `InconsistentNaming`
  inspection binds to machine-global ReSharper configuration and ignores
  solution-level settings, making its output unreliable and noisy in CLI usage.
  aislop force-suppresses it via this settings file so the inspection count is
  deterministic across machines.

## TODO: SSR slop-pattern starter set (deferred)

The following Structural Search and Replace (SSR) patterns are planned but not
yet authored. They must be created interactively in Rider's Structural Search UI
(ReSharper | Tools | Pattern Catalog), verified to fire against real C# code,
then exported and merged into `aislop.DotSettings`. SSR blobs are opaque enough
that hand-writing them silently no-ops; authoring in Rider is required.

Patterns to add (each at severity WARNING):

1. Redundant local-then-return: `var $x$ = $expr$; return $x$;` where `$x$`
   is a local used exactly twice.
2. Empty catch block: `try { $body$ } catch { }`.
3. Single-variable string interpolation: `$"{$x$}"` where `$x$` is any
   expression (should be written as `$x$.ToString()` or cast directly).
4. Redundant null-guard duplicating a non-null contract.

See `docs/superpowers/plans/2026-06-20-jb-inspectcode-lint.md` Task 7 Steps
3-4 for the full authoring and verification procedure.
