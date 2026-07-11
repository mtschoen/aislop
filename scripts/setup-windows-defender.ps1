<#
.SYNOPSIS
  Configure Windows Defender exclusions to speed up aislop scans on large
  repositories.

.WHAT THIS CHANGES
  aislop shells out to scanner binaries (cppcheck, clang-tidy, clang-format,
  ruff, oxlint, golangci-lint, gofmt, inspectcode, and optionally dotnet) that
  each open every source file they touch. Windows Defender real-time
  protection inspects every one of those file opens, and on large trees
  (tens of thousands of files) that inspection overhead is measurable.

  `Add-MpPreference -ExclusionProcess <image>` tells Defender to skip
  real-time and scheduled scanning of files OPENED BY that process. It does
  NOT exclude the process's own executable from being scanned, and it does
  NOT exclude files opened by other processes. See the security tradeoff
  section below before running this with elevation.

.SECURITY TRADEOFF (read before running elevated)
  A process exclusion is scoped to files opened by that image name, but it
  applies machine-wide and to every invocation of that image, not just
  aislop's. Anything else on the machine that happens to run a binary with
  the same name (for example a second cppcheck install used by another
  tool) also loses real-time scanning on the files it opens. This script
  only ever prints or applies changes when you run it; it never runs
  unattended, and -WhatIf (the default when not elevated) previews changes
  without applying them.

  node.exe is deliberately NOT in the managed list. aislop's own built-in
  engines run inside Node and read every source file in scan scope, so
  excluding node.exe would remove real-time scanning from every Node
  process on the machine, not just aislop. See docs/windows-performance.md
  for the recommended alternatives (per-repository -RepositoryPath, or a
  Microsoft Dev Drive for the code tree).

.PARAMETER WhatIf
  Preview the changes that would be made without applying them. This is
  the default behavior in a non-elevated session, since Add-MpPreference
  requires elevation to actually change anything.

.PARAMETER Remove
  Remove every exclusion this script manages (the process list below, and
  any -RepositoryPath entries previously added by this script) instead of
  adding them.

.PARAMETER IncludeDotnet
  Also exclude dotnet.exe. Off by default: dotnet.exe is the shared host
  for every .NET application on the machine, so excluding it is broader
  than the other entries here (any process launched via `dotnet <dll>`
  inherits the exclusion, not just aislop's dotnet-format/roslynator/audit
  passes). Turn this on if those passes dominate your scan time.

.PARAMETER RepositoryPath
  One or more directories to add as path exclusions (-ExclusionPath),
  instead of or in addition to the process exclusions. Path exclusions are
  narrower than process exclusions: they only cover files under the given
  directory, regardless of which process opens them.

.EXAMPLE
  .\setup-windows-defender.ps1
  Preview mode (non-elevated): prints what would change and the elevated
  command to run.

.EXAMPLE
  # From an elevated PowerShell prompt
  .\setup-windows-defender.ps1
  Applies the default process exclusion list.

.EXAMPLE
  # From an elevated PowerShell prompt
  .\setup-windows-defender.ps1 -IncludeDotnet -RepositoryPath C:\src\big-repo

.EXAMPLE
  # From an elevated PowerShell prompt
  .\setup-windows-defender.ps1 -Remove
  Removes every exclusion this script manages.
#>
[CmdletBinding()]
param(
  [switch]$WhatIf,
  [switch]$Remove,
  [switch]$IncludeDotnet,
  [string[]]$RepositoryPath
)

$ErrorActionPreference = 'Stop'

# Image names for aislop's scanner processes, one entry per engine that
# shells out to it. Kept as a flat list (not a hashtable) since
# Add-MpPreference / Remove-MpPreference take image names directly.
$managedProcesses = @(
  'cppcheck.exe'      # code-quality/lint: C/C++ static analysis
  'clang-tidy.exe'    # lint: C/C++ (requires compile_commands.json)
  'clang-format.exe'  # format: C/C++
  'ruff.exe'          # format + lint: Python (covers both the on-PATH tool
                       # and aislop's postinstall-vendored copy - Defender
                       # matches by image name, not install location)
  'oxlint.exe'        # lint: JavaScript/TypeScript
  'golangci-lint.exe' # lint: Go
  'gofmt.exe'         # format: Go
  'inspectcode.exe'   # lint: JetBrains inspections (C#/C++)
)

if ($IncludeDotnet) {
  $managedProcesses += 'dotnet.exe'
}

function Test-IsElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$isElevated = Test-IsElevated
$effectiveWhatIf = $WhatIf -or -not $isElevated

Write-Host ''
Write-Host '=== aislop Windows Defender exclusion setup ===' -ForegroundColor Cyan
Write-Host 'Excluding a process means: files OPENED BY that process skip Defender'
Write-Host 'real-time and scheduled scanning. The process executable itself is'
Write-Host 'still scanned normally. This is a real, machine-wide security tradeoff'
Write-Host '(it is not limited to aislop invocations of that process) - see the'
Write-Host 'script header and docs/windows-performance.md before applying.'
Write-Host ''

if (-not $isElevated -and -not $Remove) {
  Write-Host 'Not running elevated: showing what would change (-WhatIf behavior).' -ForegroundColor Yellow
  Write-Host 'To apply, re-run from an elevated PowerShell prompt:' -ForegroundColor Yellow
  $scriptPath = $PSCommandPath
  $reinvoke = "Start-Process pwsh -Verb RunAs -ArgumentList '-NoProfile -File ""$scriptPath""'"
  Write-Host "  $reinvoke" -ForegroundColor Yellow
  Write-Host ''
}

function Resolve-RepoPath {
  param([string]$Path)
  $resolvedItem = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($resolvedItem) {
    return $resolvedItem.Path
  }
  return $Path
}

function Get-ManagedState {
  $prefs = Get-MpPreference
  $currentProcesses = @($prefs.ExclusionProcess)
  $currentPaths = @($prefs.ExclusionPath)
  [PSCustomObject]@{
    Processes = $currentProcesses
    Paths     = $currentPaths
  }
}

$state = $null
try {
  $state = Get-ManagedState
} catch {
  Write-Host "Could not read current Defender preferences: $($_.Exception.Message)" -ForegroundColor Yellow
}

if ($Remove) {
  foreach ($proc in $managedProcesses) {
    if ($state -and ($state.Processes -contains $proc)) {
      if ($effectiveWhatIf) {
        Write-Host "[WhatIf] Would remove process exclusion: $proc"
      } else {
        Remove-MpPreference -ExclusionProcess $proc
        Write-Host "Removed process exclusion: $proc"
      }
    } else {
      Write-Host "Not currently excluded, nothing to remove: $proc"
    }
  }
  foreach ($path in $RepositoryPath) {
    $resolved = Resolve-RepoPath -Path $path
    if ($state -and ($state.Paths -contains $resolved)) {
      if ($effectiveWhatIf) {
        Write-Host "[WhatIf] Would remove path exclusion: $resolved"
      } else {
        Remove-MpPreference -ExclusionPath $resolved
        Write-Host "Removed path exclusion: $resolved"
      }
    } else {
      Write-Host "Not currently excluded, nothing to remove: $resolved"
    }
  }
} else {
  foreach ($proc in $managedProcesses) {
    if ($state -and ($state.Processes -contains $proc)) {
      Write-Host "Already excluded, no change needed: $proc"
    } elseif ($effectiveWhatIf) {
      Write-Host "[WhatIf] Would add process exclusion: $proc"
    } else {
      Add-MpPreference -ExclusionProcess $proc
      Write-Host "Added process exclusion: $proc"
    }
  }
  foreach ($path in $RepositoryPath) {
    $resolved = Resolve-RepoPath -Path $path
    if ($state -and ($state.Paths -contains $resolved)) {
      Write-Host "Already excluded, no change needed: $resolved"
    } elseif ($effectiveWhatIf) {
      Write-Host "[WhatIf] Would add path exclusion: $resolved"
    } else {
      Add-MpPreference -ExclusionPath $resolved
      Write-Host "Added path exclusion: $resolved"
    }
  }
}

Write-Host ''
Write-Host '=== Current managed exclusion state ===' -ForegroundColor Cyan
try {
  $finalState = Get-ManagedState
  Write-Host 'Process exclusions (managed by this script):'
  foreach ($proc in $managedProcesses) {
    $present = $finalState.Processes -contains $proc
    Write-Host "  [$(if ($present) { 'x' } else { ' ' })] $proc"
  }
  if ($RepositoryPath.Count -gt 0) {
    Write-Host 'Path exclusions (from -RepositoryPath):'
    foreach ($path in $RepositoryPath) {
      $resolved = Resolve-RepoPath -Path $path
      $present = $finalState.Paths -contains $resolved
      Write-Host "  [$(if ($present) { 'x' } else { ' ' })] $resolved"
    }
  }
} catch {
  Write-Host "Could not read final Defender preferences: $($_.Exception.Message)" -ForegroundColor Yellow
}

if (-not $IncludeDotnet) {
  Write-Host ''
  Write-Host 'dotnet.exe is not excluded (pass -IncludeDotnet to add it). See' -ForegroundColor DarkGray
  Write-Host 'docs/windows-performance.md for why it is opt-in.' -ForegroundColor DarkGray
}
