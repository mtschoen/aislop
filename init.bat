@echo off
REM Restores this checkout after `git clean -ffxd` from cmd.exe.
REM Forwards every argument to init.ps1 and propagates its exit code.
setlocal
set "POWERSHELL="
where pwsh >nul 2>&1 && set "POWERSHELL=pwsh"
if not defined POWERSHELL (
    where powershell >nul 2>&1 && set "POWERSHELL=powershell"
)
if not defined POWERSHELL (
    echo PowerShell is required but was not found. >&2
    exit /b 1
)
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0init.ps1" %*
exit /b %ERRORLEVEL%
