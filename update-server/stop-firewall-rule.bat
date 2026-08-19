@echo off
echo Removing OTA firewall rule for port 4231...
netsh advfirewall firewall delete rule name="NEXTREME-OTA-4231"
if errorlevel 1 (
    echo No rule found or could not remove. May need admin rights.
) else (
    echo Rule removed.
)
pause
