# Windows performance

aislop shells out to scanner binaries (cppcheck, clang-tidy, clang-format,
ruff, oxlint, golangci-lint, gofmt, inspectcode, and its own Node-based
engines) that each open every source file in scan scope. On Windows,
Defender's real-time protection inspects every one of those file opens. On
large trees this adds up: a stress test against a 20,000-file dotnet-runtime
checkout showed a measurable slowdown from Defender inspection alone.

One machine's observation from that stress test: a single-threaded cppcheck
pass took 34m30s, with six chunks hitting a 180-second per-chunk timeout.
Adding `-j 30` (30 worker threads) only pushed effective CPU utilization to
roughly 4-5 cores' worth of work, with the rest of the threads mostly
blocked rather than computing. Parallel workers stalling instead of scaling
with core count is consistent with Defender's filter driver serializing
file opens across the process tree, rather than a CPU bottleneck in
cppcheck itself. Treat these numbers as one data point, not a guaranteed
multiplier on every tree or machine.

This doc covers what the bundled script does, the tradeoffs between the
available mitigations, and how to undo them.

## What `scripts/setup-windows-defender.ps1` does

The script manages Windows Defender **process exclusions**
(`Add-MpPreference -ExclusionProcess <image>`) for aislop's external scanner
binaries: `cppcheck.exe`, `clang-tidy.exe`, `clang-format.exe`, `ruff.exe`,
`oxlint.exe`, `golangci-lint.exe`, `gofmt.exe`, and `inspectcode.exe`.

A process exclusion tells Defender to skip real-time and scheduled scanning
of files **opened by** that process. It does not exclude the executable
itself from being scanned, and it does not exclude files opened by any other
process.

```powershell
# Preview only (also the default when not elevated)
.\scripts\setup-windows-defender.ps1 -WhatIf

# Apply, from an elevated PowerShell prompt
.\scripts\setup-windows-defender.ps1

# Also exclude dotnet.exe (off by default, see below)
.\scripts\setup-windows-defender.ps1 -IncludeDotnet

# Add path exclusions for specific repositories instead of/alongside process exclusions
.\scripts\setup-windows-defender.ps1 -RepositoryPath C:\src\big-repo

# Undo everything the script added
.\scripts\setup-windows-defender.ps1 -Remove
```

Running the script without elevation prints what it would change and the
exact elevated command to re-run it. Applying and removing are both
idempotent: re-running either is a no-op for entries already in the desired
state, and the script prints the current managed exclusion state
(`Get-MpPreference` filtered to the entries it manages) at the end of every
run.

## Process vs. path vs. Dev Drive

Three ways to reduce Defender overhead, in increasing order of the security
surface they open up:

| Approach | Scope | Tradeoff |
|---|---|---|
| `-ExclusionPath` per repository | Files under one directory, any process | Narrowest. Only helps while scanning inside that directory; add one entry per repo you scan often. |
| `-ExclusionProcess` per scanner binary | Every file opened by that image name, on the whole machine | Broader: any other tool on the machine that happens to invoke a binary with the same name also skips scanning. Scoped to specific engines, so the blast radius is limited to what those tools do. |
| [Microsoft Dev Drive](https://learn.microsoft.com/en-us/windows/dev-drive/) (ReFS volume, performance mode) | Everything on the Dev Drive | A dedicated volume with Defender's performance-mode filtering built in. Best fit if you regularly work with large source trees and can move them to a separate volume; more setup than the other two. |

The bundled script defaults to process exclusions because they cover aislop's
scanner invocations regardless of which repository is being scanned, which
matches the common case of scanning many repos with the same tool install.
Use `-RepositoryPath` instead (or alongside) if you would rather keep the
exclusion scoped to specific repositories.

## The node.exe caveat

`node.exe` is deliberately **not** in the script's managed list, even though
aislop's own built-in engines (AI-slop pattern detection, complexity,
architecture, most of security) run inside Node and read every source file
in scan scope.

Excluding `node.exe` would exempt every Node process on the machine from
real-time scanning of the files it opens, not just aislop's. That is a real
reduction in coverage: anything else running under Node (dev servers, build
tools, other CLIs) would also skip inspection. The script does not make that
tradeoff for you. If Node-side scanning is the dominant cost in your
workflow, use `-RepositoryPath` to exclude the specific repository
directories you scan instead, or move those repositories to a Dev Drive.

## Measuring impact

Time a scan before and after applying exclusions, on the same tree, with
Defender's baseline behavior established first (a prior scan warms the file
cache regardless of exclusions, so run at least once before measuring):

```powershell
Measure-Command { aislop scan . }
```

Run it once before applying exclusions, run the script, then run it again.
The gap is Defender's real-time inspection overhead for the excluded
processes; expect the effect to grow with file count and shrink for repos
that already fit largely in OS file cache.

## Undoing the exclusions

```powershell
.\scripts\setup-windows-defender.ps1 -Remove
```

Removes every process and path exclusion this script added. It does not
touch exclusions you or another tool added independently.

## App-managed exclusions (possible future direction)

This doc's script is standalone: you run it yourself, separately from
aislop. A different pattern exists for letting a CLI manage its own
exclusions: the `git-wizard` project's `GitWizard.WindowsDefender` class
(`GitWizard/WindowsDefender.cs`) checks whether the current process is
elevated via `MFTLib.ElevationUtilities`, and if not, either re-launches
itself with a hidden `--elevated-defender` argument (self-elevation, for
published single-file builds) or falls back to spawning an elevated
PowerShell child process (for `dotnet run` and similar cases without a
self-elevatable executable). Once elevated, it calls `Add-MpPreference`
directly rather than asking the user to open an elevated shell themselves.

If aislop wanted to self-manage exclusions instead of shipping a standalone
script, `aislop doctor` is the natural place to detect Defender overhead and
offer to apply exclusions on the spot, following that same
detect-elevate-or-relaunch-then-apply shape. That is not part of this
deliverable; the standalone script is the current scope.

## References

- [Add-MpPreference](https://learn.microsoft.com/en-us/powershell/module/defender/add-mppreference) (PowerShell module docs)
- [Configure Microsoft Defender Antivirus exclusions](https://learn.microsoft.com/en-us/microsoft-365/security/defender-endpoint/configure-exclusions-microsoft-defender-antivirus) (process, path, and other exclusion types)
- [Microsoft Dev Drive overview](https://learn.microsoft.com/en-us/windows/dev-drive/)
