@echo off
setlocal
set OTA_PORT=4231

REM ---- Load .env file if it exists (one-time password config) ----
if exist "%~dp0.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
    )
)

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
echo [2/3] Checking dependencies...
if not exist "node_modules" (
    echo  Installing express...
    call npm install
    if errorlevel 1 (
        echo  [ERROR] npm install failed
        pause
        exit /b 1
    )
)
echo  [OK] Dependencies ready.
echo.

REM ---- Step 3: Start server ----
echo [3/3] Starting OTA server on port %OTA_PORT%...
echo.
node server.js
pause
