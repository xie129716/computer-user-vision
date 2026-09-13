@echo off
rem computer-user doctor launcher.
rem
rem pnpm runs lifecycle scripts in a shell where `node` is NOT necessarily on
rem PATH on this machine (npm_node_execpath is unset too), so resolve the
rem interpreter explicitly, in priority order:
rem   1. npm_node_execpath      (npm/pnpm set it where available)
rem   2. node.exe on PATH
rem   3. scripts\node-path.txt  (manual override; optional)
rem   4. the DSH-bundled node under %USERPROFILE%\.workbuddy
rem   5. a system Node.js install
rem
rem Always exits 0: a health report must never fail a dependency install.
setlocal EnableDelayedExpansion

set "DOCTOR=%~dp0computer-user-doctor.mjs"
set "NODEEXE="

if defined npm_node_execpath set "NODEEXE=%npm_node_execpath%"

if not defined NODEEXE for %%I in (node.exe) do (
  if not defined NODEEXE if not "%%~$PATH:I"=="" set "NODEEXE=%%~$PATH:I"
)

if not defined NODEEXE if exist "%~dp0node-path.txt" (
  set /p NODEEXE=<"%~dp0node-path.txt"
)

rem Walk the DSH-bundled node versions and keep the last match.
if not defined NODEEXE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if exist "%%~fD\node.exe" set "NODEEXE=%%~fD\node.exe"
)

if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODEEXE (
  echo computer-user doctor: skipped - no node interpreter found 1>&2
  exit /b 0
)

if not exist "%DOCTOR%" (
  echo computer-user doctor: skipped - %DOCTOR% missing 1>&2
  exit /b 0
)

"%NODEEXE%" "%DOCTOR%" %*
exit /b 0
