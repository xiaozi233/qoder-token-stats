@echo off
setlocal enabledelayedexpansion
rem Qoder tok/s -- terminal monitor strip. Double-click, or run it from
rem Qoder's integrated terminal panel. Ctrl+C exits.
rem
rem NOTE: keep every byte of this file ASCII. cmd.exe decodes a .cmd with the
rem console codepage, and a UTF-8 CJK sequence read as GBK can yield "&",
rem which splits a rem line into two commands and executes the tail.
rem
rem chcp 65001 is still needed: node writes UTF-8 to stdout, and without it
rem the CJK labels and the sparkline glyphs come out as mojibake in cmd.exe.

chcp 65001 >nul
set "runtime="
set "run_as_node="

set "data=%QODER_PLUGIN_DATA%"
if not defined data set "data=%CLAUDE_PLUGIN_DATA%"
set "home=%QODER_HOME%"
if not defined home set "home=%USERPROFILE%\.qoder-cn"

rem Prefer a real node: the TUI reads/writes terminal size, and
rem Electron-as-node cannot always get a TTY.
where node.exe >nul 2>nul
if not errorlevel 1 set "runtime=node.exe"

rem Fall back to the interpreter the plugin recorded (same convention as
rem bin/token-stats.cmd).
if not defined runtime if defined data call :try_path "!data!\run\runtime-path.v1"
if not defined runtime call :try_path "!home!\plugins\data\token-stats-local\run\runtime-path.v1"

if not defined runtime if exist "%ProgramFiles%\nodejs\node.exe" set "runtime=%ProgramFiles%\nodejs\node.exe"
if not defined runtime if exist "%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe" set "runtime=%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe"
if not defined runtime if exist "D:\Qoder CN\Qoder CN.exe" set "runtime=D:\Qoder CN\Qoder CN.exe"

if not defined runtime (
  >&2 echo tui: no JavaScript runtime found ^(install Node, or run the plugin once^)
  exit /b 127
)

rem Only the Electron path needs this switch; clear it for a real node.
set "run_as_node=1"
if /i "!runtime!"=="node.exe" set "run_as_node="
if /i "!runtime!"=="%ProgramFiles%\nodejs\node.exe" set "run_as_node="
if defined run_as_node set "ELECTRON_RUN_AS_NODE=1"

"!runtime!" "%~dp0tui.mjs" %*
exit /b !errorlevel!

:try_path
if not exist "%~1" exit /b 0
set /p candidate=<"%~1"
if exist "!candidate!" set "runtime=!candidate!"
exit /b 0
