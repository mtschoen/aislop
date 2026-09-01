@echo off
rem Resolves the `aislop` command to a per-user checkout of this repository.
rem
rem Install by copying onto a directory that is on PATH. AISLOP_HOME overrides
rem the checkout location; without it the wrapper uses %USERPROFILE%\aislop,
rem the location every fleet machine provisions.
rem
rem Keep this file the only wrapper on PATH. A hand-written copy is how a stale
rem install stays invisible: one on llamabox described itself as pointing at a
rem machine-shared /opt/aislop that "the sync-consumers workflow keeps
rem current", and no workflow has ever updated a machine install.
rem sync-consumers.yml bumps consumer repository pins (.aislop/fork-commit) and
rem nothing else, so a checkout only moves when someone runs
rem scripts/update-local-checkout.sh.
rem
rem Do not point this at a machine-shared directory. pnpm hard-links package
rem files out of its content-addressable store, so the account that installs a
rem checkout has to be the account that runs aislop from it.
rem
rem This is the cmd/PowerShell half of the pair. Git Bash ignores PATHEXT and
rem will not find this file, so install scripts/wrappers/aislop alongside it.
setlocal
if not defined AISLOP_HOME set "AISLOP_HOME=%USERPROFILE%\aislop"

if not exist "%AISLOP_HOME%\" (
	rem The refresh script lives inside the checkout, so it cannot be the advice
	rem when the checkout itself is missing.
	echo aislop: no checkout at %AISLOP_HOME% 1>&2
	echo Clone one with: git clone https://gitea.fleet.sticktoitive.net/schoen/aislop.git "%AISLOP_HOME%" 1>&2
	echo Then build it with: bash "%AISLOP_HOME%/scripts/update-local-checkout.sh" 1>&2
	exit /b 1
)

if not exist "%AISLOP_HOME%\dist\cli.js" (
	echo aislop: checkout at %AISLOP_HOME% has no build 1>&2
	echo Build it with: bash "%AISLOP_HOME%/scripts/update-local-checkout.sh" 1>&2
	exit /b 1
)

node "%AISLOP_HOME%\dist\cli.js" %*
exit /b %ERRORLEVEL%
