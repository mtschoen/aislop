# C++ finding filters & engine carve-outs (ledger)

Driving context: burning the MFTLib native C++ tree (`~/MFTLib/MFTLibNative`) to a
genuine 100/100 under the aislop gate, "nothing suppressed / thresholds relaxed."
That directive forces a distinction the rest of this doc turns on:

- A **correctness/FP fix** makes aislop report *the right set* of findings - it may
  surface MORE (parser was dropping real ones) or FEWER (parser was inventing fake
  ones). These are not leniency; they fix a measurement bug.
- A **carve-out** is a deliberate policy decision to stop reporting a class of real
  findings because the rule's premise does not hold in this domain. These ARE
  leniency and must be justified per-case, scoped as narrowly as possible, and
  reviewed holistically here.

This file exists so the carve-outs can be audited as a set: each one is a place
aislop now stays quiet about something a vanilla tool would flag. Keep it current
whenever a new filter lands.

---

## 1. clang-tidy `WarningsAsErrors` comma parser fix - CORRECTNESS (surfaces more)

- **Where:** `src/engines/lint/clang-tidy.ts` (committed `e7f5303` on branch
  `fix/clang-tidy-warnings-as-errors-parse`).
- **What:** A project `.clang-tidy` with `WarningsAsErrors: "*"` makes clang-tidy
  append `,-warnings-as-errors` to every bracketed check name, e.g.
  `[bugprone-narrowing-conversions,-warnings-as-errors]`. The old check capture
  `[A-Za-z0-9_.-]+` excluded the comma, the line failed to match, and **every**
  clang-tidy finding was silently dropped. Capture broadened to a comma list; first
  real id resolved, `-warnings-as-errors` pseudo-entry dropped.
- **Direction:** Surfaces MORE findings. Before this, MFTLib's entire C++ clang-tidy
  surface was silently riding on jb's partial reimplementation. This fix is what
  revealed the 22-error built scan we are now burning down.
- **Leniency risk:** None - it is the opposite of a suppression.

## 2. complexity statement-keyword lookahead - CORRECTNESS (removes fakes)

- **Where:** `src/engines/code-quality/complexity.ts` (uncommitted working tree).
- **What:** The C-family `FUNCTION_PATTERNS` regex treated any `<token> <name>(...)`
  as a function definition, so call expressions and control-flow headers
  (`return Foo(args)`, `if (Foo(args))`, a bare Win32 call like
  `GetOverlappedResult(...)`) were mis-parsed as function *definitions*. A negative
  lookahead now rejects statement keywords (`return|if|for|while|switch|do|else|
  throw|delete|new|break|continue|goto|try|catch`) in the return-type slot.
- **Direction:** Removes FALSE findings. Concretely it killed a bogus
  function-too-long / deep-nesting finding on `usn_journal.cpp` where a 6-line
  function wrapping a `GetOverlappedResult()` call was scored as a 303-line function.
- **Leniency risk:** Low. The lookahead is a fixed keyword set; a real function
  whose return type is literally one of those keywords cannot exist in C/C++/C#/Java.

## 3. function-boundaries depth===1 latch guard - CORRECTNESS (removes fakes)

- **Where:** `src/engines/code-quality/function-boundaries.ts` (uncommitted).
- **What:** `findBraceFunctionEnd` latched onto the first `{` it saw. When the scan
  starts inside an already-open surrounding block (depth < 0 relative to start), a
  `{` that merely brings depth back toward zero was wrongly treated as the function
  body opener. Now it only latches on the 0->1 transition.
- **Direction:** Removes FALSE findings (mis-attributed function bodies / lengths).
- **Leniency risk:** Low - same family as #2; a pure boundary-detection correctness fix.

## 4. Swappable-params on the 2 extern-C EXPORTS - PER-CASE SUPPRESSION (research-validated)

- **Rule:** clang-tidy `bugprone-easily-swappable-parameters` (+ jb mirror).
- **Sites:** the 2 extern-C exports `ParseMFTRecords`, `ParseMFTFromFile` ONLY.
- **Research verdict (legitimate, no harmonious structural fix):**
  - The check is one of the most widely-disabled bugprone checks: Chromium, PyTorch,
    SerenityOS, Aseprite all disable it; it is NOT in any major project's default set.
    SerenityOS's comment: "loud with no clear advice on how to fix."
    (clang.llvm.org/extra/clang-tidy/checks/bugprone/easily-swappable-parameters.html;
    github chromium/pytorch/SerenityOS/aseprite `.clang-tidy`.)
  - The check has NO linkage/`extern "C"` awareness and NO option to scope a silence
    to the ABI boundary. Its config options (`IgnoredParameterTypeSuffixes`,
    `MinimumLength`, etc.) are blunt GLOBAL instruments - they'd suppress those types
    project-wide, which is wider, not narrower, than we want.
  - For a fixed C ABI the canonical remedy (strong types / opaque typedefs, which the
    docs themselves prescribe) is **physically impossible**: a `struct{int64_t}` has a
    different ABI than `int64_t` and breaks the C# P/Invoke marshalling. Reordering
    requires a coordinated ABI break on both sides. So suppression is the ONLY option.
  - Precedent: clang-tidy itself special-cases `extern "C"` in other checks
    (`modernize-use-using` via `isExternCContext()`, reviews.llvm.org/D75492) on the
    principle "code shared with C can't be modernized" - the same logic applies here.
- **Chosen mechanism (REVISED after research): per-site `// NOLINT`**, not an engine
  carve-out. `// NOLINTBEGIN(bugprone-easily-swappable-parameters)` / `NOLINTEND`
  around the 2 export signatures, each with a one-line C-ABI justification. clang-tidy
  honors NOLINT natively, and jb (which runs the real clang-tidy binary) honors it
  too -> the finding never reaches aislop, so NO engine change and the per-edit hook
  stays quiet. This is more transparent and more scoped than an engine carve-out
  (visible at the site, exactly 2 functions, zero new engine leniency to audit).
- **Leniency risk:** Low. Per-case, in-source, justified, on functions the check's own
  remedy cannot touch.

## 5a. `CppUnusedIncludeDirective` x10 - HARMONIOUS FIX, NOT a suppression (research win)

- **Rule:** jb-only `CppUnusedIncludeDirective` on `<cstring>`/`<cstdlib>` in files
  that directly call `memcpy`/`memset`/`calloc`/`realloc`/`free`. jb flags them
  because the symbols also arrive transitively via `pch.h -> framework.h`.
- **Research verdict - the decisive argument is BUILD CORRECTNESS, not linter doctrine:**
  `framework.h` (pulled by `pch.h`) includes `<windows.h>` (which transitively provides
  the CRT) ONLY under `#ifdef _WIN32`. On POSIX it includes just
  `<cstdio>/<cstdint>/<memory>/<vector>` - NOT `<cstring>`/`<cstdlib>`. So the direct
  CRT includes jb flags are **genuinely required for the Linux build**; removing them
  would break (or make fragile) the POSIX compile of any file using `memcpy`/`memset`/
  `calloc`/`realloc`/`free`. jb only ever analyzes the Windows pch closure, so it calls
  a cross-platform-load-bearing include "redundant." That alone settles it: removal is a
  real regression, keep is correct.
  - Secondary support: jb "does not run a full preprocessing stage" per its own docs, so
    it mismodels MSVC PCH symbol provision (open YouTrack RSCPP-32689 is the same class).
    IWYU doctrine independently prescribes keeping the direct `#include <cstring>` for
    `memcpy`. NOTE (peer research, corrected): clangd is NOT a clean corroborator - its
    include-cleaner has its OWN umbrella/pch false positive (clangd/clangd#1913 flags the
    `#include "pch.h"` line itself as "not used directly"), and strict IWYU can flag a
    direct include if it credits the symbol to a different provider header. The tools
    disagree among themselves on pch handling; that is exactly why we anchor on build
    correctness + IWYU doctrine rather than on any single tool's verdict. (Also: the
    NATIVE GATE is clang-tidy/cppcheck/jb, not clangd - clangd is only a second opinion.)
- **HARMONIOUS FIX (no suppression, no engine filter):** annotate each direct include
  with **`// IWYU pragma: keep`**. ReSharper C++ >= 2024.2 recognizes it and stops
  flagging `CppUnusedIncludeDirective` (jetbrains.com/resharper-cpp/whatsnew/2024-2/);
  our jb is 2026.1, so it is honored. clangd honors it too. This is the standard,
  cross-tool, self-documenting way to assert an intentional IWYU-direct include - it
  SATISFIES the inspection while KEEPING the include, exactly the requirement. This
  REPLACES the previously-planned corroboration filter for these 10.
  (Fallback if ever on jb < 2024.2: `// ReSharper disable once CppUnusedIncludeDirective`.)
- **Leniency risk:** None - it is an annotation that resolves the FP, not a suppression
  of a real finding.

## 5b. `CppClangTidyMiscUseInternalLinkage` x3 - jb-vs-upstream divergence (genuine FP)

- **Rule:** jb `CppClangTidyMiscUseInternalLinkage` on `ParseDataRuns`/`ReadMFTRecord`
  (declared in `ntfs_io.h`) and `ShouldFailUsnIo` (declared in `internal.h`) - all
  genuinely cross-TU.
- **Research verdict (PROVEN from upstream source):** upstream `misc-use-internal-linkage`
  mechanically EXCLUDES any function with a header redeclaration via the
  `isAllRedeclsInMainFile` matcher (`UseInternalLinkageCheck.cpp`). Real clang-tidy
  with a resolved compile DB does NOT flag these. jb's `inspectcode` invocation likely
  doesn't resolve the header redeclaration, so it mis-fires. There is NO harmonious
  fix via making them internal: a function declared in a shared header and called from
  another .cpp CANNOT be given internal linkage (it would fail to link).
- **Empirically confirmed this session (compiler/gate as authority, not assertion):**
  - Making them `static` (ReSharper's autofix) -> `LNK2001 unresolved external symbol`
    on all 3 (the cross-TU callers can't link). Proves they require external linkage.
  - Wrapping `ntfs_io` in a named `namespace mftlib::ntfs` -> still links (named ns keeps
    external linkage) AND the finding STILL fires -> namespaces are orthogonal to this
    check; they do not satisfy it. (Kept the namespace anyway: real name-hygiene win.)
- **Options considered and REJECTED (do not re-litigate):**
  - RELOCATE the helpers into `mft_parse.cpp`'s anon namespace (so they are genuinely
    internal). Rejected: it drags the interdependent cluster (ParseDataRuns ->
    ReadNonResidentData -> ReadMFTRecord -> Read/FindAttribute) and, applied consistently,
    collapses most of `ntfs_io.cpp` back into `mft_parse.cpp` - partially reversing the
    intentional B7 module split. "Single current consumer" != "wrong module boundary."
    ntfs_io is a coherent NTFS I/O/decode layer (Read/ApplyFixup/FindAttribute/
    ParseDataRuns/ReadNonResidentData/ReadMFTRecord). Does NOT help ShouldFailUsnIo
    (multi-consumer test seam). NOTE: this means there is NO harmonious relocation fix -
    relocation was evaluated and rejected, not available.
  - UNITY/jumbo build (compile the split files as one TU so helpers can be anon-ns
    internal). Possible (MSVC EnableUnitySupport, or amalgamation), and groupable. Rejected
    for this: to clear the finding you must drop the header decls and rely on in-unit
    include ORDER, which makes each file non-self-contained (LSP can't resolve a file
    opened alone) - directly against the LLM-read/edit reason the files were split. Trades
    a cosmetic FP for a real readability cost.
  - `extern` on the definitions. Rejected as the framing: redundant (the header already
    gives external linkage), so its ONLY effect is tripping the check's
    `isExternStorageClass()` exclusion. Honest to call that placation, not architecture.
- **Chosen mechanism (3-model convergence: Claude + GPT-5.5-via-pi; user locked option ii):**
  treat as a jb divergence / module-boundary FP and suppress HONESTLY via focused
  corroboration filtering:
  - Rejected alternative: per-site `// ReSharper disable once CppClangTidyMiscUseInternalLinkage`
    x3 with reason "declared in <header>; intentional cross-file NTFS primitive; upstream
    clang-tidy does not flag header redecls." This would be acceptable but less reusable.
  - LOCKED: aislop **focused corroboration filter**. Drop a jb `CppClangTidy<X>` mirror
    finding only when standalone clang-tidy actually ran successfully on that TU/file and
    did not corroborate the same canonical rule. Fail CLOSED if clang-tidy did not run,
    failed, was missing, or did not analyze that file. Scope is `jb/CppClangTidy*` only;
    native ReSharper C++ rules (`jb/CppUnusedIncludeDirective`, `jb/CppCStyleCast`, etc.)
    must never pass through this filter. Principled + reusable (fixes jb's divergence
    generally); folds into B1.
  - The check is not a reliable architectural oracle here (it flags ParseDataRuns/
    ReadMFTRecord but NOT the equally-internal ReadNonResidentData/FindAttribute), which
    is itself evidence of a buggy jb heuristic.

---

## Holistic review checklist

The only items that hide a *real* finding are #4 (2 NOLINTs, ABI-forced) and 5b
(the focused corroboration filter). #1-3 are measurement fixes; 5a is a standard IWYU
annotation; internal-swappable is restructured, not suppressed.

- [ ] #4 is exactly 2 NOLINTs on extern-C exports, each justified, and does NOT leak to
      the 8 internal helpers (those are restructured).
- [ ] 5a uses `// IWYU pragma: keep` (resolves the FP) - confirm jb version honors it.
- [ ] 5b: if the corroboration filter is chosen, it is focused and fail-closed:
      `jb/CppClangTidy*` only, standalone clang-tidy actually ran successfully, the
      affected file/TU was analyzed, canonical rule ids match, same file+line matches
      dedupe normally, and jb is kept whenever clang-tidy is missing/skipped/failed or
      did not analyze the file. Native ReSharper rules are never filtered. If per-case
      disables are chosen instead, each cites the header.
- [ ] No engine carve-out is reachable by a project that hasn't opted into the C++ lint
      path - default-off preserved.
- [ ] Every suppression has a hand-verified justification, not a category hunch.

## MFTLib-side decisions (for context)

- 8 internal swappable-param helpers: **restructured** (strong types / param structs) -
  the canonical remedy per the check's own docs; not suppressed.
- narrowing-conversions x7, modernize-avoid-c-arrays x3 (.cpp lookup tables -> std::array,
  the harmonious fix since these are NOT layout-constrained), suspicious-realloc-usage x2:
  **real fixes** in the C++.
- modernize-avoid-c-arrays NOLINTs on the C-ABI / on-disk header structs (prior sessions):
  research-CONFIRMED legitimate - `std::array` layout-equivalence to `T[N]` is convention
  not yet normative (LWG 2335 closed NAD, P3737 pending), the check has no serialization
  exemption and its `extern "C"` exemption only covers structs literally inside an
  `extern "C"` block, and C consumers can't see `std::array`. Raw array + justified NOLINT
  is how LLVM/nlohmann-json handle this. No harmonious alternative.
- cognitive-complexity x2 (`ParseMFTRecords` 78, `GenerateBatch` ~27): **extracted**.
- `.clang-tidy` is NOT relaxed; only `-modernize-use-trailing-return-type` and
  `-readability-magic-numbers` remain disabled (pre-existing).
