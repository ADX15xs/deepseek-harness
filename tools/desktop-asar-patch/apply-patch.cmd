@echo off
setlocal
rem Runs patch-asar.cjs with the app's own Electron binary, so the target machine
rem needs no separate Node.js installation.

set "HERE=%~dp0"
set "APP="
set "FLAGS="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--app" (
  set "APP=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
if "%~1"=="--dry-run" ( set "FLAGS=%FLAGS% %~1" & shift & goto parse )
if "%~1"=="--force"   ( set "FLAGS=%FLAGS% %~1" & shift & goto parse )
if "%~1"=="--restore" ( set "FLAGS=%FLAGS% %~1" & shift & goto parse )
set "APP=%~1"
shift
goto parse
:parsed

if not defined APP (
  if exist "D:\deepseek-harness\resources\app.asar" set "APP=D:\deepseek-harness"
  if not defined APP if exist "%ProgramFiles%\DeepSeek Harness\resources\app.asar" set "APP=%ProgramFiles%\DeepSeek Harness"
  if not defined APP if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar" set "APP=%LOCALAPPDATA%\Programs\DeepSeek Harness"
)

if not defined APP (
  echo error: could not find an installed app; pass --app "path to install dir"
  exit /b 1
)

set "EXE=%APP%\DeepSeek Harness.exe"
if not exist "%EXE%" (
  echo error: missing "%EXE%"
  exit /b 1
)

echo Close DeepSeek Harness completely, including the tray icon.
pause

set "ELECTRON_RUN_AS_NODE=1"
"%EXE%" "%HERE%patch-asar.cjs" --app "%APP%" %FLAGS%
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo Failed with exit code %CODE%.
  exit /b %CODE%
)
echo %FLAGS% | findstr /c:"--restore" >nul
if not errorlevel 1 (
  echo Restored the original archive. Start DeepSeek Harness to load it.
  exit /b 0
)
echo %FLAGS% | findstr /c:"--dry-run" >nul
if not errorlevel 1 (
  echo Dry run finished. Nothing was written.
  exit /b 0
)
echo Done. Start DeepSeek Harness to load the patched bundle.
exit /b 0

:usage
echo Usage: apply-patch.cmd [install dir] [--dry-run] [--force] [--restore]
exit /b 0
