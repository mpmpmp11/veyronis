@echo off
echo ======================================
echo       VEYRONIS API SERVER
echo ======================================
echo.
echo Finding your IP...
ipconfig | findstr "IPv4"
echo.
echo Starting server...
python api.py
pause