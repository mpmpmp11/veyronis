@echo off
echo ===========================================
echo    VEYRONIS API SERVER (DEBUG MODE)
echo ===========================================
echo.
echo Finding your IP...
ipconfig | findstr "IPv4"
echo.
echo Starting server... (window stays open)
echo Press Ctrl+C to stop
echo.
python api.py
echo.
echo Server exited. Press any key to close.
pause