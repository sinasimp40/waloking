@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM  Outer pass: prompt user, then re-run inner pass with output
REM  tee'd to build-log.txt. Inner pass writes its real exit code
REM  to .build-rc.tmp so the outer pass can return it correctly
REM  (cmd pipes lose the left side's exit code).
REM ============================================================
if "%~1"=="--inner" goto :inner

echo ============================================
echo    GAME LAUNCHER BUILD TOOL
echo ============================================
echo.
echo Drop your logo image (PNG/JPG/JFIF/WEBP) in the
echo "branding" folder before running this script.
echo.
echo ============================================
echo.
echo CODE SIGNING (recommended for production):
echo   Set these environment variables BEFORE running this script
echo   to produce a signed installer with no "Unknown publisher" warning:
echo     set CSC_LINK=C:\path\to\your-codesign-cert.pfx
echo     set CSC_KEY_PASSWORD=your-pfx-password
echo.
if defined CSC_LINK (
    echo  [OK] CSC_LINK is set - installer will be SIGNED.
) else (
    echo  [WARN] CSC_LINK not set - installer will be UNSIGNED ^(Windows
    echo         will show "Unknown publisher" warning to end users^).
)
echo.
echo ============================================
echo.
set /p BRAND_NAME=Enter the app name: 
if "%BRAND_NAME%"=="" (
    echo ERROR: App name cannot be empty!
    pause
    exit /b 1
)
echo.
set /p SUBTITLE=Enter subtitle (press Enter for "Internet Cafe"): 
if "%SUBTITLE%"=="" set SUBTITLE=Internet Cafe
echo.
echo ============================================
echo  App Name : %BRAND_NAME%
echo  Subtitle : %SUBTITLE%
echo ============================================
echo.
set /p CONFIRM=Proceed? (Y/N): 
if /i not "%CONFIRM%"=="Y" (
    echo Cancelled.
    pause
    exit /b 0
)
echo.
echo Build output will be saved to build-log.txt
echo.

if exist ".build-rc.tmp" del ".build-rc.tmp"

where powershell >nul 2>nul
if errorlevel 1 (
    echo [WARN] PowerShell not found - running without log capture.
    call "%~f0" --inner "%BRAND_NAME%" "%SUBTITLE%"
    exit /b %errorlevel%
)

call "%~f0" --inner "%BRAND_NAME%" "%SUBTITLE%" 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath build-log.txt"

set FINAL_RC=1
if exist ".build-rc.tmp" (
    set /p FINAL_RC=<".build-rc.tmp"
    del ".build-rc.tmp"
)
exit /b %FINAL_RC%


:inner
set BRAND_NAME=%~2
set SUBTITLE=%~3
set RC=0

echo [Step 1/4] Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed!
    set RC=1
    goto :finish
)
echo.
echo [Step 2/4] Rebranding all files...
call node scripts/rebrand.js "%BRAND_NAME%" "%SUBTITLE%"
if errorlevel 1 (
    echo ERROR: Rebrand failed!
    set RC=1
    goto :finish
)
echo.
echo [Step 3/4] Building launcher installer...
echo Cleaning previous build outputs...
if exist "dist-electron" rmdir /s /q "dist-electron"
if exist "server\dist-electron" rmdir /s /q "server\dist-electron"
call npm run dist
if errorlevel 1 (
    echo ERROR: Launcher build failed!
    set RC=1
    goto :finish
)
echo.
echo [Step 4/4] Building server installer...
call npm run dist:server
if errorlevel 1 (
    echo ERROR: Server build failed!
    set RC=1
    goto :finish
)
echo.

REM ============================================================
REM  Post-build: collect installers FIRST, then run security
REM  checks as non-fatal warnings. Folder is always created.
REM ============================================================
echo Collecting installers into brand-named Release folder...
call node scripts/collect-builds.js
set COLLECT_RC=%errorlevel%
if %COLLECT_RC% EQU 1 (
    echo.
    echo ============================================
    echo    BUILD ABORTED: NO INSTALLERS FOUND
    echo ============================================
    echo collect-builds.js could not find any .exe files in
    echo dist-electron\ or server\dist-electron\. The earlier
    echo build steps must have produced no installers.
    set RC=1
    goto :finish
)

set TAMPER_FAIL=0
set SIG_FAIL=0
set INTEGRITY_WARN=0
if %COLLECT_RC% EQU 2 set INTEGRITY_WARN=1

echo.
echo Running tamper protection regression test ^(non-fatal^)...
call node scripts/integrity-tamper-test.js
if errorlevel 1 set TAMPER_FAIL=1

echo.
echo Verifying signatures on built installers ^(non-fatal^)...
call node scripts/verify-signatures.js
if errorlevel 1 set SIG_FAIL=1

echo.
echo ============================================
if %TAMPER_FAIL% EQU 0 if %SIG_FAIL% EQU 0 if %INTEGRITY_WARN% EQU 0 (
    echo    BUILD COMPLETE!
    echo ============================================
    echo.
    echo Your installers are ready in the Release folder.
    echo Full build log saved to build-log.txt
    echo.
    set RC=0
    goto :finish
)

echo    BUILD COMPLETED WITH WARNINGS
echo ============================================
echo.
echo Your installers WERE collected into the brand-named
echo Release folder, but the following checks did not pass:
echo.
if %INTEGRITY_WARN% EQU 1 echo   [!] Tamper-protection embed check failed - see [collect-builds] warnings above.
if %TAMPER_FAIL% EQU 1   echo   [!] Tamper-protection regression test failed - see [tamper-test] errors above.
if %SIG_FAIL% EQU 1      echo   [!] Signature verification failed - see [verify-sign] errors above.
echo.
echo You may want to investigate before shipping these installers
echo to end users. Full build log saved to build-log.txt
echo.
if "%STRICT_MODE%"=="1" (
    echo [STRICT_MODE=1] Treating warnings as fatal - failing build for CI.
    set RC=1
) else (
    set RC=0
)
goto :finish


:finish
echo %RC% > ".build-rc.tmp"
if not "%RC%"=="0" pause
exit /b %RC%
