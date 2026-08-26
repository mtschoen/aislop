@echo off
rem Resolves the `aislop` command to a per-user checkout of this repository.
rem
rem Install by copying onto a directory that is on PATH. AISLOP_HOME overrides
rem the checkout location; without it the wrapper uses %USERPROFILE%\aislop,
rem the location every fleet machine provisions.
rem
rem This is the cmd/PowerShell half of the pair. Git Bash ignores PATHEXT and
rem will not find this file, so install scripts/wrappers/aislop alongside it.
setlocal
if not defined AISLOP_HOME set "AISLOP_HOME=%USERPROFILE%\aislop"
node "%AISLOP_HOME%\dist\cli.js" %*
exit /b %ERRORLEVEL%
