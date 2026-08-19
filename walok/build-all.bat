@echo off
setlocal
echo ============================================
echo  Building ALL customers
echo ============================================
call npm install
if errorlevel 1 ( echo ROOT INSTALL FAILED & pause & exit /b 1 )
pushd server
call npm install
if errorlevel 1 ( popd & echo SERVER INSTALL FAILED & pause & exit /b 1 )
popd
node scripts\build-all.js
if errorlevel 1 (
    echo ONE OR MORE BUILDS FAILED
    pause
    exit /b 1
)
echo.
echo All builds complete. Outputs in releases\
echo Run "node scripts\publish-update.js --all" to publish to update server.
pause
