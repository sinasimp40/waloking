@echo off
cd /d "%~dp0"
setlocal
set OTA_PORT=4231
set OTA_ADMIN_PASSWORD=admin
set OTA_MAX_BUILDS=10

echo ============================================
echo  OTA UPDATE SERVER - STARTUP
echo ============================================
echo.

REM ---- Step 1: Add Windows Firewall rule (requires admin) ----
echo [1/3] Configuring Windows Firewall to allow port %OTA_PORT% (TCP, inbound)...
netsh advfirewall firewall show rule name="NEXTREME-OTA-%OTA_PORT%" >nul 2>&1
if errorlevel 1 (
    netsh advfirewall firewall add rule name="NEXTREME-OTA-%OTA_PORT%" dir=in action=allow protocol=TCP localport=%OTA_PORT%
    if errorlevel 1 (
        echo  [WARN] Could not add firewall rule.
        echo         You may need to run this script as Administrator,
        echo         or add the rule manually:
        echo         netsh advfirewall firewall add rule name="NEXTREME-OTA-%OTA_PORT%" dir=in action=allow protocol=TCP localport=%OTA_PORT%
    ) else (
        echo  [OK] Firewall rule added.
    )
) else (
    echo  [OK] Firewall rule already exists.
)
echo.

REM ---- Step 2: Install deps if needed ----
echo [2/4] Checking dependencies...

REM -- update-server deps --
if not exist "node_modules" (
    echo  Installing update-server dependencies...
    REM The package-lock.json generated in Replit contains internal Replit registry
    REM URLs (package-firewall.replit.local) that are unreachable on Windows.
    REM Deleting it forces npm to resolve packages from the public npmjs.com registry.
    if exist "package-lock.json" (
        echo  [info] Clearing Replit-generated package-lock.json ^(has internal Replit URLs^)...
        del /f "package-lock.json"
    )
    REM better-sqlite3 is an OPTIONAL native fallback only used on Node ^< 22.
    REM On Node 22+ we use the built-in node:sqlite, so skip optional deps
    REM entirely - that avoids needing Visual Studio C++ build tools.
    call npm install --omit=optional
    if errorlevel 1 (
        echo  [WARN] npm install --omit=optional failed, retrying with full install...
        call npm install
        if errorlevel 1 (
            echo  [ERROR] npm install failed for update-server
            pause
            exit /b 1
        )
    )
)

REM -- walok (launcher) root deps --
if not exist "..\walok\node_modules" (
    echo  Installing walok launcher dependencies ^(this may take 1-3 min^)...
    pushd "..\walok"
    REM The package-lock.json generated in Replit contains internal Replit registry
    REM URLs (package-firewall.replit.local) that are unreachable on Windows.
    REM Deleting it forces npm to resolve packages from the public npmjs.com registry.
    if exist "package-lock.json" (
        echo  [info] Clearing Replit-generated package-lock.json...
        del /f "package-lock.json"
    )
    call npm install
    if errorlevel 1 (
        echo  [ERROR] npm install failed for walok
        popd
        pause
        exit /b 1
    )
    popd
)

REM -- walok individual package checks (catches packages added after first install) --
if not exist "..\walok\node_modules\hls.js" (
    echo  Installing missing walok package: hls.js...
    pushd "..\walok"
    call npm install hls.js
    if errorlevel 1 (
        echo  [ERROR] Failed to install hls.js
        popd
        pause
        exit /b 1
    )
    popd
    echo  [OK] hls.js installed.
)

if not exist "..\walok\node_modules\dashjs" (
    echo  Installing missing walok package: dashjs...
    pushd "..\walok"
    call npm install dashjs
    if errorlevel 1 (
        echo  [ERROR] Failed to install dashjs
        popd
        pause
        exit /b 1
    )
    popd
    echo  [OK] dashjs installed.
)

REM -- walok/server deps --
if not exist "..\walok\server\node_modules" (
    echo  Installing walok server dependencies...
    pushd "..\walok\server"
    call npm install
    if errorlevel 1 (
        echo  [ERROR] npm install failed for walok/server
        popd
        pause
        exit /b 1
    )
    popd
)

REM -- balok (launcher UI) deps --
REM balok is the improved launcher UI; its dist is synced into walok before
REM each customer build. Install here so "Build Balok" in the admin panel works
REM without needing a separate manual install step.
if not exist "..\balok\node_modules" (
    echo  Installing balok launcher UI dependencies ^(this may take 1-3 min^)...
    pushd "..\balok"
    REM The package-lock.json generated in Replit contains internal Replit registry
    REM URLs (package-firewall.replit.local) that are unreachable on Windows.
    REM Deleting it forces npm to resolve packages from the public npmjs.com registry.
    if exist "package-lock.json" (
        echo  [info] Clearing Replit-generated package-lock.json ^(has internal Replit URLs^)...
        del /f "package-lock.json"
    )
    call npm install
    if errorlevel 1 (
        echo  [ERROR] npm install failed for balok
        popd
        pause
        exit /b 1
    )
    popd
)

echo  [OK] All dependencies ready.
echo.

REM ---- Step 3: Pre-flight check ----
echo [3/4] Verifying project layout...
if not exist "..\walok\package.json" (
    echo  [WARN] walok folder not found at ..\walok - builds will be unavailable.
    echo         Make sure the full waloking folder is intact.
)
echo  [OK] Layout verified.
echo.

REM ---- Step 4: Start server ----
echo [4/4] Starting OTA server on port %OTA_PORT%...
echo.
node server.js
pause
