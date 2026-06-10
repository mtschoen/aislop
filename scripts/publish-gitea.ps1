<#
.SYNOPSIS
  Build this aislop fork and publish it to the self-hosted Gitea npm registry
  as @schoen/aislop, so consumer repos (CI + local) pull the SAME fork build
  (C#/roslynator + newer rules) instead of upstream aislop on public npm.

.WHY
  The fork lives on GitHub (mtschoen/aislop). Its GitHub Actions runners cannot
  reach the internal Gitea, so publishing to Gitea is a LOCAL action run from a
  machine on the internal network (chonkers/llamabox). This script is that
  action. Fork-only tooling: it is tracked on the schoen/main integration
  branch and is not intended for upstream PRs.

.NOTES
  - Bump "version" in package.json before re-publishing; Gitea rejects an
    already-published version.
  - Builds via tsdown directly to sidestep any non-portable `pnpm build`
    script variants (upstream's `rm -rf dist && NODE_ENV=production ...`
    fails on Windows cmd/PowerShell).
  - The package "name" is overridden to @schoen/aislop only for the publish,
    then restored to "aislop" (mirrors upstream's own GitHub Packages job).
  - Read access on the registry is anonymous; only publishing needs the token.

.OVERRIDES (env vars)
  GITEA_TOKEN              auth token (default: contents of $HOME\.gitea-token)
  AISLOP_GITEA_REGISTRY   registry URL (default: schoen npm registry below;
                          the canonical hostname serves a Let's Encrypt cert,
                          so no extra CA trust is normally needed)
  AISLOP_GITEA_CA         optional CA PEM for TLS trust when publishing to a
                          host with a private cert (default: the Y: mkcert
                          mount path; if absent, system trust is used and
                          strict-ssl stays on - no TLS downgrade)
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$scopedName = '@schoen/aislop'
$registry   = if ($env:AISLOP_GITEA_REGISTRY) { $env:AISLOP_GITEA_REGISTRY } else { 'https://gitea.llamabox.sticktoitive.net/api/packages/schoen/npm/' }
$tokenPath  = Join-Path $HOME '.gitea-token'
$token      = if ($env:GITEA_TOKEN) { $env:GITEA_TOKEN } else { (Get-Content $tokenPath -Raw).Trim() }
$caPath     = if ($env:AISLOP_GITEA_CA) { $env:AISLOP_GITEA_CA } else { 'Y:\.local\share\mkcert\rootCA.pem' }

# Derive the registry host so the per-registry _authToken key matches exactly.
$registryNoScheme = ($registry -replace '^https?:', '').TrimEnd('/') + '/'

$version = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "Publishing $scopedName@$version -> $registry"

Write-Host '=== build (tsdown, Windows-native) ==='
if (Test-Path dist) { Remove-Item -Recurse -Force dist }
$env:NODE_ENV = 'production'
# Invoke via `pnpm exec` (pnpm is the declared packageManager) rather than the
# .bin shim by path: an extensionless `& <abs-path>\tsdown` does not get PATHEXT
# resolution in PowerShell and silently runs the bash shim instead.
pnpm exec tsdown
if ($LASTEXITCODE -ne 0) { throw "build failed: tsdown exited $LASTEXITCODE" }
if (-not (Test-Path 'dist\cli.js')) { throw 'build failed: dist/cli.js not produced' }

# TLS: the default registry hostname carries a publicly trusted cert, so this
# usually does nothing. For a private-cert host, trust it via the CA if
# reachable (no TLS downgrade); otherwise fall back to disabling strict-ssl
# for this publish only.
$tmpNpmrc = Join-Path $env:TEMP 'aislop-gitea-publish-npmrc'
$npmrcLines = @(
  "$scopedName`:registry=$registry"
  "//${registryNoScheme}:_authToken=$token"
)
if (Test-Path $caPath) {
  Write-Host "TLS: extra CA trust via $caPath"
  $env:NODE_EXTRA_CA_CERTS = (Resolve-Path $caPath).Path
} else {
  Write-Host 'TLS: no extra CA; relying on system trust (strict-ssl stays on)'
}

($npmrcLines -join "`n") | Set-Content -Path $tmpNpmrc -Encoding utf8 -NoNewline

try {
  npm pkg set name="$scopedName"
  Write-Host '=== npm publish ==='
  npm publish --userconfig $tmpNpmrc
  if ($LASTEXITCODE -ne 0) { throw "npm publish failed (exit $LASTEXITCODE)" }
  Write-Host "Published $scopedName@$version"
} finally {
  npm pkg set name="aislop"
  Remove-Item $tmpNpmrc -Force -ErrorAction SilentlyContinue
}
