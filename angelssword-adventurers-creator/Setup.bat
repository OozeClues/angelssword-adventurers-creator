@echo off
chcp 65001 >nul 2>&1
color 0E
echo.
echo   =========================================
echo     AS Adventurer Creator - First Time Setup
echo     Angel's Sword Studios
echo   =========================================
echo.

:: Check if Node.js is already installed
where node >nul 2>&1
if %ERRORLEVEL% equ 0 (
    for /f "tokens=*" %%v in ('node --version') do (
        echo   Node.js %%v is already installed!
        echo.
        echo   You're all set. Run "Start ASAdventurer.bat" to launch.
        echo.
        pause
        exit /b 0
    )
)

echo   Node.js is required to run AS Adventurer.
echo   This setup will install it for you.
echo.

:: Try winget first (Windows 10 1709+ / Windows 11)
where winget >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   [1/2] Installing Node.js via Windows Package Manager...
    echo.
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if %ERRORLEVEL% equ 0 (
        echo.
        echo   Node.js installed successfully!
        goto :INSTALL_DEPS
    ) else (
        echo.
        echo   Winget install had an issue, trying direct download...
        goto :DOWNLOAD_MSI
    )
) else (
    goto :DOWNLOAD_MSI
)

:DOWNLOAD_MSI
echo   [1/2] Downloading Node.js LTS installer...
echo.

:: Download Node.js MSI installer using PowerShell
set "INSTALLER=%TEMP%\nodejs-install.msi"
powershell -Command "& { try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $page = Invoke-WebRequest -Uri 'https://nodejs.org/en/download' -UseBasicParsing; $v = [regex]::Match($page.Content, 'v(\d+\.\d+\.\d+)').Groups[1].Value; if (!$v) { $v = '22.16.0' }; $url = \"https://nodejs.org/dist/v$v/node-v$v-x64.msi\"; Write-Host \"  Downloading Node.js v$v...\"; Invoke-WebRequest -Uri $url -OutFile '%INSTALLER%' -UseBasicParsing; Write-Host '  Download complete!' } catch { Write-Host '  Download failed. Opening nodejs.org instead...'; Start-Process 'https://nodejs.org/en/download'; exit 1 } }"

if %ERRORLEVEL% neq 0 (
    echo.
    echo   Could not auto-download. Please install Node.js manually from:
    echo       https://nodejs.org/
    echo.
    echo   After installing, run this setup again or just run
    echo   "Start ASAdventurer.bat" directly.
    echo.
    pause
    exit /b 1
)

echo.
echo   Running Node.js installer...
echo   (Follow the installer prompts - default settings are fine)
echo.
msiexec /i "%INSTALLER%"

:: Wait for install to complete and clean up
del "%INSTALLER%" >nul 2>&1

:: Refresh PATH so we can find node
set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"

:: Verify installation
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo   NOTE: You may need to close and re-open this window
    echo   for Node.js to be detected. After that, run
    echo   "Start ASAdventurer.bat" to launch.
    echo.
    pause
    exit /b 0
)

:INSTALL_DEPS
:: Refresh PATH
set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"

echo.
for /f "tokens=*" %%v in ('node --version 2^>nul') do echo   Node.js %%v detected!
echo.
echo   [2/2] Installing AS Adventurer dependencies...
echo.

cd /d "%~dp0"
call npm install

if %ERRORLEVEL% equ 0 (
    echo.
    echo   =========================================
    echo     Setup complete!
    echo     Run "Start ASAdventurer.bat" to launch.
    echo   =========================================
    echo.
) else (
    echo.
    echo   [WARNING] npm install had issues.
    echo   Try running "Start ASAdventurer.bat" anyway -
    echo   it will retry the install automatically.
    echo.
)

pause
