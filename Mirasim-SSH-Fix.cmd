@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Mirasim Windows Remote SSH Fix

set "MIRASIM_FIX_ROOT=%~dp0"
set "MIRASIM_FIX_CLI=%~dp0src\cli.cjs"
set "MIRASIM_FIX_COMMAND=%*"
if "%~1"=="" set "MIRASIM_FIX_COMMAND=apply"

set "MIRASIM_FIX_NODE=%~dp0runtime\node.exe"
if exist "%MIRASIM_FIX_NODE%" (
  "%MIRASIM_FIX_NODE%" "%MIRASIM_FIX_CLI%" %MIRASIM_FIX_COMMAND%
  set "MIRASIM_FIX_RC=%ERRORLEVEL%"
  goto :done
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Independent Node.js was not found.
  echo Download the complete Windows Release ZIP or install Node.js 20 or newer.
  echo The target Mirasim.exe is intentionally never used to patch itself.
  set "MIRASIM_FIX_RC=2"
  goto :done
)

node.exe "%MIRASIM_FIX_CLI%" %MIRASIM_FIX_COMMAND%
set "MIRASIM_FIX_RC=%ERRORLEVEL%"

:done
echo.
if not defined MIRASIM_SSH_FIX_NO_PAUSE pause
exit /b %MIRASIM_FIX_RC%
