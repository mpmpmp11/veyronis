@echo off
echo ==========================================
echo  VEYRONIS — Force Clean Start
echo ==========================================
echo.

echo [1/4] Killing old Python processes...
taskkill /F /IM python.exe 2>nul
taskkill /F /IM pythonw.exe 2>nul
timeout /t 1 /nobreak >nul

echo [2/4] Clearing Python cache...
for /d /r . %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d" 2>nul
for /r . %%f in (*.pyc) do @if exist "%%f" del /q "%%f" 2>nul

echo [3/4] Checking .env file...
python check_env.py

echo.
echo [4/4] Starting VEYRONIS server...
echo ==========================================
python api.py
pause