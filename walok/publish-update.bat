@echo off
setlocal
if "%~1"=="" (
    echo Usage: publish-update.bat ^<customer-id^>   OR   publish-update.bat --all
    echo.
    echo This packages built releases into update-server\public\updates\
    echo so connected launchers can detect and download them.
    pause
    exit /b 1
)
node scripts\publish-update.js "%~1"
pause
