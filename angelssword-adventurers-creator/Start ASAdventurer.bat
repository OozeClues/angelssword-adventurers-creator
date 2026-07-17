@echo off
chcp 65001 >nul 2>&1
color 0E
echo.
echo   AS Adventurer Creator - VTuber Creation Pipeline
echo   =========================================
echo   Angel's Sword Studios
echo   Design - Generate - Prepare - Export
echo.

cd /d "%~dp0"

:: Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] Node.js is not installed!
    echo.
    echo   AS Adventurer requires Node.js to run.
    echo   Please download and install it from:
    echo.
    echo       https://nodejs.org/
    echo.
    echo   Choose the LTS version, run the installer,
    echo   then re-open this script.
    echo.
    pause
    exit /b 1
)

:: Show Node version
for /f "tokens=*" %%v in ('node --version') do echo   Node.js %%v detected

:: Check if node_modules exists, if not run npm install
if not exist "node_modules\" (
    echo.
    echo   First-time setup: Installing dependencies...
    echo   This only needs to happen once.
    echo.
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo   [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo.
    echo   Dependencies installed successfully!
    echo.
)

echo.
echo   Starting server...
echo   (Press Ctrl+C to stop)
echo.
node server.js
pause
