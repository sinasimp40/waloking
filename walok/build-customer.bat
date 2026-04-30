@echo off
setlocal
if "%~1"=="" (
    echo Usage: build-customer.bat ^<customer-id^>
    echo Example: build-customer.bat example-cafe
    echo.
    echo Available customers:
    dir /b customers\*.json 2^>nul
    pause
    exit /b 1
)
echo ============================================
echo  Building customer: %~1
echo ============================================
call npm install
if errorlevel 1 ( echo ROOT INSTALL FAILED & pause & exit /b 1 )
pushd server
call npm install
if errorlevel 1 ( popd & echo SERVER INSTALL FAILED & pause & exit /b 1 )
popd
node scripts\build-customer.js "%~1"
if errorlevel 1 (
    echo BUILD FAILED
    pause
    exit /b 1
)
echo.
echo Build complete. Output in releases\%~1\
pause
