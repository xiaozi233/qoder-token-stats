@echo off
setlocal enabledelayedexpansion
for %%I in ("%~dp0..") do set "plugin_root=%%~fI"

set "cmd_name=%~1"
if "%cmd_name%"=="stop-stats" set "script_name=stop-stats.mjs"
if "%cmd_name%"=="token-stats" set "script_name=token-stats.mjs"
if not defined script_name (
  >&2 echo token-stats: unknown command "%~1" ^(expected stop-stats ^| token-stats^)
  exit /b 2
)
shift

rem Set TOKEN_STATS_SOURCE to a working checkout to run its runtime/*.mjs
rem directly, so edits take effect without reinstalling. Development only.
set "script=!plugin_root!\runtime\!script_name!"
if defined TOKEN_STATS_SOURCE set "script=!TOKEN_STATS_SOURCE!\runtime\!script_name!"

set "runtime="
set "run_as_node="
set "data=%QODER_PLUGIN_DATA%"
if not defined data set "data=%CLAUDE_PLUGIN_DATA%"
set "home=%QODER_HOME%"
if not defined home set "home=%USERPROFILE%\.qoder-cn"

if defined data call :try_path "!data!\run\runtime-path.v1"
if not defined runtime call :try_path "!home!\plugins\data\qoder-context-qoderapp-bundler\run\runtime-path.v1"
if not defined runtime if exist "%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe" set "runtime=%LOCALAPPDATA%\Programs\Qoder CN\Qoder CN.exe"
if not defined runtime if exist "D:\Qoder CN\Qoder CN.exe" set "runtime=D:\Qoder CN\Qoder CN.exe"

if defined runtime (
  set "run_as_node=1"
) else (
  where node.exe >nul 2>nul
  if errorlevel 1 (
    >&2 echo token-stats: no compatible JavaScript runtime found
    exit /b 127
  )
  set "runtime=node.exe"
)

if "!run_as_node!"=="1" (set "ELECTRON_RUN_AS_NODE=1") else (set "ELECTRON_RUN_AS_NODE=")
"!runtime!" "!script!" %*
exit /b !errorlevel!

:try_path
if not exist %~1 exit /b 0
set /p candidate=<%~1
if exist "!candidate!" set "runtime=!candidate!"
exit /b 0
