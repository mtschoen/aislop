# C++ component pattern

Use this pattern when one cohesive C++ module is too large for aislop's file-size gate, but splitting it into independent `.cpp` files would force internal helpers to become external-linkage API.

The goal is simple: keep small files for agent readability while preserving one translation unit for C++ linkage semantics.

## When to use it

Use a component when all of these are true:

- A C++ module genuinely exceeds the project's `complexity.maxFileLoc` target.
  (C/C++ files get a 2.5x budget - 1000 lines at the default `maxFileLoc` of
  400 - because splitting them has linkage costs other languages don't pay.)
- The split files are one cohesive responsibility, not independent modules.
- Helpers would otherwise need header declarations only so another split file can call them.
- `misc-use-internal-linkage` or the JetBrains `CppClangTidyMiscUseInternalLinkage` mirror would become noise.

Do not use this for small modules. If the code fits in one `.cpp`, keep one `.cpp` with anonymous-namespace helpers.

## Layout

A component is one compiled owner file plus small included fragments:

```text
mft.cpp              # owner translation unit, the only compiled .cpp
mft.records.cpp      # fragment, included by mft.cpp
mft.parse_core.cpp   # fragment, included by mft.cpp
mft.internal.h       # editor-only cross-fragment declarations
mft.h                # public component API
```

The owner has the bare component name. Fragments use the same prefix plus a descriptive dotted segment.

## Linkage rule

- Used only inside the component: put it in an anonymous namespace.
- Deliberate public API: declare it in the public header.
- Used by multiple components or test seams: keep it external and document why.

This keeps internal-linkage lint meaningful. A finding now means accidental public surface, not an artifact of file splitting.

## Fragment sentinel

Each fragment starts with a banner, a compile-alone guard, and the internal header:

```cpp
// Part of the mft component. Included by mft.cpp; do not compile directly.
#ifndef AISLOP_TU_FRAGMENT
#error "mft.records.cpp is a fragment included by mft.cpp; do not compile it directly"
#endif

#include "mft.internal.h"

namespace {
// Internal helpers here.
}
```

The owner defines the marker before including fragments:

```cpp
#include "mft.h"

#define AISLOP_TU_FRAGMENT
#include "mft.records.cpp"
#include "mft.parse_core.cpp"
#undef AISLOP_TU_FRAGMENT

// Public API definitions here.
```

`mft.internal.h` exists so a fragment opened alone resolves symbols in clangd. The build does not depend on it for linkage.

## Tooling

### clangd

Add this to the project `.clangd` so fragments do not trip the guard while edited alone:

```yaml
CompileFlags:
  Add: [-DAISLOP_TU_FRAGMENT]
```

### Build systems

Compile only the owner file. Exclude fragments explicitly:

- CMake: mark fragments `HEADER_FILE_ONLY` or otherwise omit them from targets.
- MSBuild: set fragment files `ExcludedFromBuild`.

The `#error` guard is the backstop if a fragment accidentally enters the build.

### aislop

When `complexity/file-too-large` fires on a C/C++ source file, its fix hint points back to this pattern rather than the generic "split into smaller modules" advice.

The pattern is applicable by hand. Two **experimental** commands automate the mechanical parts of it; both are new, their output is meant to be reviewed rather than trusted blindly, and their interface may change.

Generate a new component scaffold with:

```bash
aislop scaffold component mft --fragment records --fragment parse_core --fragment parse
```

By default this refuses to touch files that already exist. To convert an existing translation unit into a component, pass `--adopt`: the public header and any existing sources are kept as they are, missing pieces are created, each adopted fragment gains the `#error` guard, and the owner gets the fragment include block threaded in after its includes. Re-running with more `--fragment` flags folds the new fragments into the existing block.

```bash
aislop scaffold component mft --adopt --fragment records --fragment parse
```

Regenerate editor-only cross-fragment declarations after moving helper definitions with:

```bash
aislop cpp sync-internal mft
```

`sync-internal` declares only the helpers one fragment defines and another actually calls. It reads the fragments structurally (balanced parameter lists, trailing specifiers, trailing return types, with comments, string literals, and preprocessor lines masked out), so templated return types, brace-initialized default arguments, and definitions nested inside indented namespaces are all picked up. It is still a text-level tool, not a compiler front end: check the generated header before relying on it.

- `clang-tidy` and JetBrains inspectcode should run through the compile database or project build model, so they lint the owner translation unit and report findings at fragment paths when appropriate.
- `cppcheck`, formatting, complexity, security, and AI-pattern checks may still scan fragments as text files. That is expected.
- Do not suppress internal-linkage findings globally. The component structure is the fix.

## Restructuring recipe

1. Identify the cohesive file cluster from call graph and responsibility.
2. Create the owner `.cpp` and public `<component>.h`.
3. Rename split implementation files to dotted fragment names.
4. Include fragments from the owner in dependency order.
5. Move component-private helpers into anonymous namespaces.
6. Remove private helper declarations from public headers.
7. Add `<component>.internal.h` declarations only where editor parsing needs them.
8. Exclude fragments from the build.
9. Build, then run clang-tidy or aislop to confirm internal-linkage findings are real signal.

## Residual exceptions

If a symbol is genuinely consumed by more than one component, or is a deliberate cross-cutting test seam, it is correctly external. Prefer a focused per-site suppression with a reason over any engine-wide filter.
